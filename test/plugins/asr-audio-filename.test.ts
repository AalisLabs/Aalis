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
// 音频的文件名与临时文件：
//   - asr-openai 交给 Whisper 接口的文件名后缀取按内容判定的格式（接口按后缀认格式），不按来源的路径、Content-Type 或
//     data URL 里写的类型猜；接口不接受的格式（如 AMR）明确报错，不改名硬传
//   - whisper-cpp 下载与解码出的临时文件一律叫 audio.bin：转码时 ffmpeg 按内容探测格式，扩展名不参与；无扩展名的网址
//     也不会把整条路径拼进写路径、造出嵌套目录
//
// 真 http 服务 + 真 fs；两个插件 provide 出来的 ASRService 经宿主绑定捞出来直接调。
// ════════════════════════════════════════════════════════════

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(16)]);
const AMR = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(16)]);

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
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ provide, asr });
  // 桩先就位：whisper-cpp 把 process / storage 声明成 required，缺席会被激活闸挡在 pending
  host.provide.use(processService, services.process as never);
  host.provide.use(storage, services.storage as never);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(plugin.name)?.state;
  if (state !== 'active') throw new Error(`插件 ${plugin.name} 未激活（state=${state}）`);
  if (!host.asr.present) throw new Error('插件未注册 asr');
  return host.asr.use;
}

/** 真 fs 的 process 服务：readExternalFile 真读盘，makeTempDir 指向真目录 */
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
      // 类型头写错：内容是 MP3
      res.writeHead(200, { 'content-type': 'audio/ogg' });
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

describe('plugin-asr-openai：交给 Whisper 接口的文件', () => {
  /** 只截 /audio/transcriptions（真下载仍走真 fetch），记下 multipart 里的文件名与类型 */
  function captureUpload(): { file: () => { name: string; type: string } | undefined } {
    let file: { name: string; type: string } | undefined;
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { body?: FormData }) => {
        if (!String(url).includes('/audio/transcriptions')) return realFetch(url as string, init as RequestInit);
        const part = init?.body?.get('file');
        file = part instanceof File ? { name: part.name, type: part.type } : undefined;
        return { ok: true, status: 200, json: async () => ({ text: '转写文本' }) } as unknown as Response;
      }),
    );
    return { file: () => file };
  }

  /** 本套用例的被测插件与桩：每条独立装一次；storage 读出的是 stored */
  const bootOpenai = (stored: Buffer = MP3) =>
    bootAsr(
      asrOpenai,
      { apiKey: 'k' },
      { process: procService(base), storage: { ...storageService([]), readFile: async () => stored } },
    );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['无扩展名、类型头写错的网址', () => `http://127.0.0.1:${port}/download`],
    ['后缀写成 .opus 的网址', () => `http://127.0.0.1:${port}/download.opus`],
    ['data URL 写的类型是 audio/opus', () => `data:audio/opus;base64,${MP3.toString('base64')}`],
    ['存储地址的后缀是 .wav', () => 'data:/audios/s/onebot/0123456789abcdef.wav'],
  ])('%s、内容是 MP3：上传 audio.mp3，类型 audio/mpeg', async (_label, source) => {
    const cap = captureUpload();
    const asr = await bootOpenai();
    const r = await asr.transcribe({ attachment: { kind: 'audio', data: source() } });
    expect(r.text).toBe('转写文本');
    expect(cap.file()).toEqual({ name: 'audio.mp3', type: 'audio/mpeg' });
  });

  it.each([['voicenote.opus'], ['voicenote']])('本地文件 %s、内容是 MP3：上传 audio.mp3', async name => {
    const local = join(base, name);
    await writeFile(local, MP3);
    const cap = captureUpload();
    const asr = await bootOpenai();
    await asr.transcribe({ attachment: { kind: 'audio', data: `file://${local}` } });
    expect(cap.file()?.name).toBe('audio.mp3');
  });

  it('接口不接受的格式（AMR）：报错写明格式，不改名硬传', async () => {
    const cap = captureUpload();
    const asr = await bootOpenai(AMR);
    await expect(
      asr.transcribe({ attachment: { kind: 'audio', data: 'data:/audios/s/onebot/0123456789abcdef.amr' } }),
    ).rejects.toThrow('Whisper 接口不接受 AMR 音频');
    expect(cap.file()).toBeUndefined();
  });
});

describe('plugin-asr-whisper-cpp：音频来源', () => {
  it('存储地址按 storage 解析成本机路径', async () => {
    const resolved: string[] = [];
    const asr = await bootAsr(
      asrWhisper,
      { modelPath: join(base, 'ggml-base.bin') },
      {
        process: procService(join(base, 'whisper-in')),
        storage: {
          ...storageService([]),
          resolveLocalPath: async (uri: string) => {
            resolved.push(uri);
            return join(base, 'voicenote.wav');
          },
        },
      },
    );
    await asr.transcribe({ attachment: { kind: 'audio', data: 'data:/audios/s/onebot/0123456789abcdef.wav' } });
    expect(resolved).toEqual(['data:/audios/s/onebot/0123456789abcdef.wav']);
  });
});

describe('plugin-asr-whisper-cpp：下载与解码出的临时文件', () => {
  it('无扩展名的 URL 不造嵌套垃圾目录：写在临时目录下的 audio.bin 里', async () => {
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
    expect(written[0]).toBe('tmp:/whisper-in/audio.bin');
    // 真目录下不该出现以 host 或整条路径拼出来的嵌套壳
    expect(await readdir(base)).not.toContain('127.0.0.1');
  });

  it('data URL 写的类型不进文件名：解码到 audio.bin', async () => {
    const written: string[] = [];
    const asr = await bootAsr(
      asrWhisper,
      { modelPath: join(base, 'ggml-base.bin') },
      { process: procService(join(base, 'whisper-in')), storage: storageService(written) },
    );
    await asr
      .transcribe({ attachment: { kind: 'audio', data: `data:audio/x-wav;base64,${MP3.toString('base64')}` } })
      .catch(() => undefined);
    expect(written).toEqual(['tmp:/whisper-in/audio.bin']);
  });
});
