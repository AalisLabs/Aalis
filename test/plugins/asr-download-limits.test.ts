import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { App, type PluginDefinition, provide } from '@aalis/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ASRService, asr } from '../../packages/api-asr/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import asrOpenai from '../../packages/plugin-asr-openai/src/index.js';
import asrWhisper from '../../packages/plugin-asr-whisper-cpp/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';

// ════════════════════════════════════════════════════════════
// 两个 ASR 插件的远程音频下载与 plugin-media 同口径：带超时信号、20 MiB 流式限额。
//
// 此前两者都是裸 safeFetch(url) 后整读 arrayBuffer()：safeFetch 只管 SSRF 与重定向，
// 对端不应答就把整轮语音回合挂住，超大响应（无 Content-Length 时尤甚）整个读进内存。
// 入站语音 URL 由外部平台给出（OneBot 附件缓存失败时回退原 URL），这条路径可达。
// ════════════════════════════════════════════════════════════

const MIB = 1024 * 1024;

let server: Server;
let port: number;

beforeAll(async () => {
  setNetworkPolicy({ blockPrivate: false }); // 只为连本机测试服务；afterAll 复原
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('ID3'));
      return;
    }
    if (req.url === '/big') {
      // 不带 Content-Length（分块传输）：只有流式累计才能在读完之前发现超限
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      Readable.from(Array.from({ length: 21 }, () => Buffer.alloc(MIB))).pipe(res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  setNetworkPolicy({ blockPrivate: true });
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const apps: App[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.stop().catch(() => {});
});

/** 下游动作的观测点：openai 的转写上传、whisper-cpp 的落盘与子进程 */
interface Probe {
  downstream: number;
  signals: Map<string, AbortSignal | undefined>;
}

/** 本机服务的请求透传真 fetch 并记下 signal；转写上传只计数不外发 */
function stubFetch(probe: Probe): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/audio/transcriptions')) {
        probe.downstream++;
        return new Response(JSON.stringify({ text: '转写文本' }), { status: 200 });
      }
      probe.signals.set(new URL(u).pathname, init?.signal ?? undefined);
      return realFetch(u, init);
    }),
  );
}

async function bootAsr(plugin: PluginDefinition, config: Record<string, unknown>, probe: Probe): Promise<ASRService> {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ provide, asr });
  host.provide(processService, {
    makeTempDir: async () => ({ path: '/tmp/unused', uri: 'tmp:/whisper-in', cleanup: async () => {} }),
    execFile: async () => {
      probe.downstream++;
      return { stdout: '转写文本', stderr: '', code: 0 };
    },
  } as never);
  host.provide(storage, {
    listRoots: () => [
      { name: 'tmp', label: 'tmp', kind: 'tmp', browsable: false, readable: true, writable: true, deletable: true },
    ],
    writeFile: async () => {
      probe.downstream++;
    },
    readFile: async () => '转写文本',
  } as never);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(plugin.name)?.state;
  if (state !== 'active') throw new Error(`插件 ${plugin.name} 未激活（state=${state}）`);
  const service = host.asr.current;
  if (!service) throw new Error('插件未注册 asr');
  return service;
}

describe.each([
  ['plugin-asr-openai', asrOpenai, { apiKey: 'k' }],
  ['plugin-asr-whisper-cpp', asrWhisper, { modelPath: '/tmp/ggml-base.bin' }],
] as const)('%s：远程音频下载', (_name, plugin, config) => {
  it('超过 20 MiB 的响应在读完之前被拒，不进入后续转写', async () => {
    const probe: Probe = { downstream: 0, signals: new Map() };
    stubFetch(probe);
    const service = await bootAsr(plugin, config, probe);
    await expect(
      service.transcribe({ attachment: { kind: 'audio', data: `http://127.0.0.1:${port}/big` } }),
    ).rejects.toThrow(/音频过大/);
    expect(probe.downstream).toBe(0);
  });

  it('下载请求带 15 秒超时信号；正常大小照常转写', async () => {
    const probe: Probe = { downstream: 0, signals: new Map() };
    stubFetch(probe);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const service = await bootAsr(plugin, config, probe);
    const r = await service.transcribe({ attachment: { kind: 'audio', data: `http://127.0.0.1:${port}/ok` } });
    expect(r.text).toBe('转写文本');
    const signal = probe.signals.get('/ok');
    expect(signal, '下载未带 AbortSignal，对端不应答会挂住整轮').toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    // 钉住时长：下载信号必须出自 AbortSignal.timeout(15_000)（openai 的转写上传另有一只超时信号）
    const i = timeoutSpy.mock.results.findIndex(res => res.value === signal);
    expect(i, '下载信号不是 AbortSignal.timeout 造的').toBeGreaterThanOrEqual(0);
    expect(timeoutSpy.mock.calls[i]).toEqual([15_000]);
  });
});
