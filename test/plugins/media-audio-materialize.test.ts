import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger, ServiceRef } from '@aalis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import type { AdapterCaps } from '../../packages/plugin-media/src/llm-adapter.js';
import { scanLLMProcessors } from '../../packages/plugin-media/src/llm-adapter.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import { safeDownloadToTemp } from '../../packages/plugin-media/src/safe-fetch.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';

// ════════════════════════════════════════════════════════════
// 音频附件物化：http 下载件与 file:// 件都必须能喂给 LLM 转写。
//
// 两个实证缺陷：safeDownloadToTemp 丢掉刚写好的 tmp uri（下游按 uri 判「是否落入
// storage 根」，丢了就必抛），以及 audioToBase64 对没有 uri 的物化结果直接放弃，
// 而不是像 imageToBase64DataUrl 那样退回 proc.readExternalFile。两者叠加让
// http 音频这条路 100% 抛错，被上层吞成「[音频] 识别失败」。
//
// 真 http 服务 + 真 fs：blockPrivate 临时关掉，才能连本机测试服务。
// ════════════════════════════════════════════════════════════

/** 'ID3' magic → detectAudioFormat 判 mp3（主流格式直接透传，不进 ffmpeg） */
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);

let base: string;
let server: Server;
let port: number;

/** tmp:/<子目录>/<文件> ←→ 真实临时目录，proc/storage 两个网关都落在真 fs 上 */
function realRuntime(baseDir: string): void {
  const toPath = (uri: string): string => join(baseDir, uri.replace(/^tmp:\//, ''));
  let seq = 0;
  setMediaRuntime({
    proc: {
      makeTempDir: async (prefix: string) => {
        const name = `${prefix}-${seq++}`;
        await mkdir(join(baseDir, name), { recursive: true });
        return {
          path: join(baseDir, name),
          uri: `tmp:/${name}`,
          cleanup: async () => rm(join(baseDir, name), { recursive: true, force: true }),
        };
      },
      readExternalFile: (p: string) => readFile(p),
    } as never,
    storage: {
      writeFile: async (uri: string, data: Buffer) => {
        await mkdir(dirname(toPath(uri)), { recursive: true });
        await writeFile(toPath(uri), data);
      },
      readFile: (uri: string) => readFile(toPath(uri)),
    } as never,
  });
}

/** 一个只有 audio 能力的假 LLM 提供者：记下收到的 audios，回一句转写结果 */
function audioLLMCaps(): { caps: AdapterCaps; audios: () => string[] } {
  let seen: string[] = [];
  const instance: LLMModel = {
    id: 'fake-audio',
    capabilities: ['audio'],
    chat: async (req: { messages: Array<{ audios?: string[] }> }) => {
      seen = req.messages[0].audios ?? [];
      return { content: '转写文本' };
    },
  } as unknown as LLMModel;
  const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;
  const llm: ServiceRef<LLMModel> = {
    current: instance,
    require: () => instance,
    all: () => [{ contextId: 'p/fake-audio', instance, priority: 0 }],
    follow: () => () => {},
  };
  return { caps: { llm, logger }, audios: () => seen };
}

beforeAll(async () => {
  setNetworkPolicy({ blockPrivate: false }); // 只为连本机测试服务；afterAll 复原
  base = await mkdtemp(join(tmpdir(), 'aalis-audio-mat-'));
  realRuntime(base);
  server = createServer((req, res) => {
    // 刻意无扩展名（实测的 audio.com/download 形态）
    if (req.url === '/download') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(MP3);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  setNetworkPolicy({ blockPrivate: true });
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(base, { recursive: true, force: true });
});

describe('safeDownloadToTemp', () => {
  it('返回落盘的 storage uri（下游按 uri 判是否落入 storage 根）', async () => {
    const dl = await safeDownloadToTemp(`http://127.0.0.1:${port}/download`);
    if (!dl) throw new Error('下载失败');
    try {
      expect(dl.uri).toMatch(/^tmp:\/media-dl-\d+\/download\.bin$/);
      expect(await readFile(join(base, dl.uri.replace(/^tmp:\//, '')))).toEqual(MP3);
    } finally {
      await dl.cleanup();
    }
  });
});

describe('audio 附件 → LLM 转写', () => {
  it('http 音频（无扩展名 URL）能转写：uri 随下载结果一起回来，不再必抛', async () => {
    const { caps, audios } = audioLLMCaps();
    const proc = scanLLMProcessors(caps).find(p => p.transcribe);
    if (!proc?.transcribe) throw new Error('未包出 audio processor');
    const r = await proc.transcribe({ attachment: { kind: 'audio', data: `http://127.0.0.1:${port}/download` } });
    expect(r.text).toBe('转写文本');
    expect(audios()[0]).toBe(`data:audio/mpeg;base64,${MP3.toString('base64')}`);
  });

  it('file:// 音频走 proc.readExternalFile 回落（没落进 storage 根不是死路）', async () => {
    const local = join(base, 'local-voice.mp3');
    await writeFile(local, MP3);
    const { caps, audios } = audioLLMCaps();
    const proc = scanLLMProcessors(caps).find(p => p.transcribe);
    if (!proc?.transcribe) throw new Error('未包出 audio processor');
    const r = await proc.transcribe({ attachment: { kind: 'audio', data: `file://${local}` } });
    expect(r.text).toBe('转写文本');
    expect(audios()[0]).toBe(`data:audio/mpeg;base64,${MP3.toString('base64')}`);
  });
});
