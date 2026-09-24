import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, type PluginDefinition, provide } from '@aalis/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ASRService, asr } from '../../packages/api-asr/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import asrOpenai from '../../packages/plugin-asr-openai/src/index.js';
import asrWhisper from '../../packages/plugin-asr-whisper-cpp/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';

// ════════════════════════════════════════════════════════════
// 无扩展名的音频 URL（实测形态 audio.com/download）不能用 split('.').pop() 猜后缀：
// 那会把整条路径当扩展名，于是
//   - asr-openai 交给 Whisper API 的 filename 带斜杠 → 400
//   - whisper-cpp 拿它当 storage 写路径 → 造嵌套垃圾目录
// 正解同仓已有（safe-fetch.ts 的 extname + Content-Type 兜底）。
//
// 真 http 服务 + 真 fs；两个插件 provide 出来的 ASRService 经宿主绑定捞出来直接调。
// ════════════════════════════════════════════════════════════

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);

let base: string;
let server: Server;
let port: number;

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop().catch(() => {});
});

/** 装载插件并捞出它 provide 的 asr 服务；process / storage 用本用例的真 fs 桩 */
async function bootAsr(
  plugin: PluginDefinition,
  config: Record<string, unknown>,
  services: { process: Record<string, unknown>; storage: Record<string, unknown> },
): Promise<ASRService> {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ provide, asr });
  // 桩先就位：whisper-cpp 把 process / storage 声明成 required，缺席会被激活闸挡在 pending
  host.provide(processService, services.process as never);
  host.provide(storage, services.storage as never);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(plugin.name)?.state;
  if (state !== 'active') throw new Error(`插件 ${plugin.name} 未激活（state=${state}）`);
  const service = host.asr.current;
  if (!service) throw new Error('插件未注册 asr');
  return service;
}

/** 真 fs 的 process 网关面：readExternalFile 真读盘，makeTempDir 指向真目录 */
function procService(tmpDir: string, onExec?: () => void): Record<string, unknown> {
  return {
    // 同 plugin-process-local：file:// 前缀在此剥掉
    readExternalFile: (p: string) => readFile(p.startsWith('file://') ? p.slice('file://'.length) : p),
    makeTempDir: async () => ({ path: tmpDir, uri: 'tmp:/whisper-in', cleanup: async () => {} }),
    execFile: async () => {
      onExec?.();
      return { stdout: '转写文本', stderr: '', code: 0 };
    },
  };
}

/** 只记 uri 的 storage 面（本用例断言的就是写路径本身） */
function storageService(written: string[]): Record<string, unknown> {
  return {
    listRoots: () => [
      { name: 'tmp', label: 'tmp', kind: 'tmp', browsable: false, readable: true, writable: true, deletable: true },
    ],
    writeFile: async (uri: string) => void written.push(uri),
    readFile: async () => MP3,
    resolveLocalPath: async () => undefined,
  };
}

beforeAll(async () => {
  setNetworkPolicy({ blockPrivate: false }); // 只为连本机测试服务；afterAll 复原
  base = await mkdtemp(join(tmpdir(), 'aalis-asr-ext-'));
  server = createServer((req, res) => {
    if (req.url?.startsWith('/download')) {
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

describe('plugin-asr-openai：交给 Whisper API 的 filename', () => {
  /** 只截 /audio/transcriptions（真下载仍走真 fetch），记下 multipart 里的 filename */
  function captureUpload(): { filename: () => string | undefined } {
    let filename: string | undefined;
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { body?: FormData }) => {
        if (!String(url).includes('/audio/transcriptions')) return realFetch(url as string, init as RequestInit);
        const file = init?.body?.get('file');
        filename = file instanceof File ? file.name : undefined;
        return { ok: true, status: 200, json: async () => ({ text: '转写文本' }) } as unknown as Response;
      }),
    );
    return { filename: () => filename };
  }

  /** 本套用例的被测插件与桩：每条独立装一次 */
  const bootOpenai = () =>
    bootAsr(asrOpenai, { apiKey: 'k' }, { process: procService(base), storage: storageService([]) });

  it('无扩展名的 URL：按 Content-Type 兜底成 audio.mp3，文件名里没有斜杠', async () => {
    const cap = captureUpload();
    const asr = await bootOpenai();
    const r = await asr.transcribe({ attachment: { kind: 'audio', data: `http://127.0.0.1:${port}/download` } });
    expect(r.text).toBe('转写文本');
    expect(cap.filename()).toBe('audio.mp3');
    expect(cap.filename()).not.toContain('/');
    vi.unstubAllGlobals();
  });

  it('后缀不在 Whisper 支持集内（.opus）时按 Content-Type 换成集内后缀，不原样上传', async () => {
    const cap = captureUpload();
    const asr = await bootOpenai();
    const r = await asr.transcribe({ attachment: { kind: 'audio', data: `http://127.0.0.1:${port}/download.opus` } });
    expect(r.text).toBe('转写文本');
    expect(cap.filename()).toBe('audio.mp3'); // .opus 被 API 判 400，故按 audio/mpeg 映射
    vi.unstubAllGlobals();
  });

  it('base64 data URI：mime 子类型不在 Whisper 支持集内（audio/opus）时按白名单换成 audio.ogg', async () => {
    const cap = captureUpload();
    const asr = await bootOpenai();
    const r = await asr.transcribe({
      attachment: { kind: 'audio', data: `data:audio/opus;base64,${MP3.toString('base64')}` },
    });
    expect(r.text).toBe('转写文本');
    expect(cap.filename()).toBe('audio.ogg'); // 直取 mime 子类型会上传 audio.opus，被 API 判 400
    vi.unstubAllGlobals();
  });

  it('本地 .opus 无 Content-Type 可依：按同一张映射表落 audio.ogg，而不是兜底成 wav', async () => {
    const local = join(base, 'voicenote.opus');
    await writeFile(local, MP3);
    const cap = captureUpload();
    const asr = await bootOpenai();
    const r = await asr.transcribe({ attachment: { kind: 'audio', data: `file://${local}` } });
    expect(r.text).toBe('转写文本');
    expect(cap.filename()).toBe('audio.ogg'); // 兜底成 wav 会让 Whisper 按错容器解
    vi.unstubAllGlobals();
  });

  it('无扩展名的本地路径同样不把整条路径当后缀', async () => {
    const local = join(base, 'voicenote'); // 刻意无后缀
    await writeFile(local, MP3);
    const cap = captureUpload();
    const asr = await bootOpenai();
    const r = await asr.transcribe({ attachment: { kind: 'audio', data: `file://${local}` } });
    expect(r.text).toBe('转写文本');
    expect(cap.filename()).toBe('audio.wav'); // 无 mime 可依时的白名单兜底
    expect(cap.filename()).not.toContain('/');
    vi.unstubAllGlobals();
  });
});

describe('plugin-asr-whisper-cpp：下载件的 storage 写路径', () => {
  it('无扩展名的 URL 不造嵌套垃圾目录（写在临时目录下的单个文件里）', async () => {
    const written: string[] = [];
    const asr = await bootAsr(
      asrWhisper,
      { modelPath: join(base, 'ggml-base.bin') },
      { process: procService(join(base, 'whisper-in')), storage: storageService(written) },
    );
    // 转写本身靠假 execFile，成不成功不是本用例的断言点——断言的是下载件的写路径
    await asr
      .transcribe({ attachment: { kind: 'audio', data: `http://127.0.0.1:${port}/download` } })
      .catch(() => undefined);
    expect(written).toHaveLength(1);
    expect(written[0]).toBe('tmp:/whisper-in/audio.mp3');
    // 真目录下不该出现以 host 或整条路径拼出来的嵌套壳
    expect(await readdir(base)).not.toContain('127.0.0.1');
  });
});
