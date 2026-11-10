import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { App, type Logger, type PluginDefinition, provide } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ASRService, asr, type TranscribeInput } from '../../packages/api-asr/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import asrOpenai from '../../packages/plugin-asr-openai/src/index.js';
import asrWhisper from '../../packages/plugin-asr-whisper-cpp/src/index.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 转写接调用方的中止信号（TranscribeInput.signal）：远程音频的下载、云端转写请求、ffmpeg 转码与 whisper-cli 随之停下，
// 抛出中止原因，不按转码或识别失败报；超时照旧。调用方没中止、提供转写的插件停用或重启时同样停下（实现另接自己这次激活的
// 信号）。plugin-media 经 asr 桥接转写时交本插件这次激活的信号。下载打到本机一个
// 只收不回的上游桩；转写请求的 fetch 与 process 服务是替身，卡住的那一步只在中止时拒绝（与 process 服务停掉进程组后一样）。
// ════════════════════════════════════════════════════════════

const WAV = `data:audio/wav;base64,${Buffer.from('RIFF\0\0\0\0WAVEfmt ').toString('base64')}`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 只收不回的上游桩：requested 为收到请求，closed 为那条请求断开 */
async function hangingUpstream() {
  const seen = { requested: false, closed: false };
  const server = createServer(req => {
    seen.requested = true;
    req.on('close', () => {
      seen.closed = true;
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  setNetworkPolicy({ blockPrivate: false }); // 只为连本机的上游桩；用完复原
  cleanups.push(async () => {
    setNetworkPolicy({ blockPrivate: true });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/a.wav` };
}

/** 在 signal 中止时以 reject 落定；没有 signal 就一直不落定 */
const untilAborted = (signal: AbortSignal | undefined, error: () => unknown) =>
  new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(error()), { once: true }));

/**
 * 装上 ASR 插件。execFile 卡在 hang 指定的命令上（中止时按非零退出拒绝），其余照常回放；execs 记下每次子进程调用收到的
 * 中止信号
 */
async function boot(plugin: PluginDefinition, config: Record<string, unknown>, hang?: string) {
  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  const host = app.bind({ provide, asr });
  const execs: Array<{ cmd: string; signal?: AbortSignal }> = [];
  host.provide.use(processService, {
    makeTempDir: async () => ({ path: '/zz-virtual/whisper', uri: 'tmp:/whisper', cleanup: async () => {} }),
    async execFile(cmd: string, _args: readonly string[], opts: { signal?: AbortSignal } = {}) {
      execs.push({ cmd, signal: opts.signal });
      if (cmd === hang) {
        return untilAborted(opts.signal, () => new Error(`execFile ${cmd} 退出码 null (signal SIGTERM)`));
      }
      return { stdout: '转写文本', stderr: '', code: 0, signal: null };
    },
  } as never);
  host.provide.use(storage, {
    writeFile: async () => {},
    readFile: async () => '转写文本',
  } as never);
  await app.plugin(plugin, config);
  await app.plugins.idle();
  if (!host.asr.present) throw new Error(`${plugin.name} 没有注册 asr`);
  return { service: host.asr.use as ASRService, execs, disable: () => app.plugins.disable(plugin.name) };
}

describe.each([
  ['plugin-asr-openai', asrOpenai, { apiKey: 'k' }],
  ['plugin-asr-whisper-cpp', asrWhisper, { modelPath: '/tmp/ggml-base.bin' }],
] as const)('%s：远程音频下载随中止停下', (_name, plugin, config) => {
  it('下载途中中止：到上游的请求随之断开，转写以中止原因拒绝', async () => {
    const upstream = await hangingUpstream();
    const { service } = await boot(plugin, config);
    const ac = new AbortController();
    const pending = service.transcribe({ attachment: { kind: 'audio', data: upstream.url }, signal: ac.signal });
    await expect.poll(() => upstream.seen.requested).toBe(true);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect.poll(() => upstream.seen.closed).toBe(true);
  });

  it('调用方没给信号，下载途中停用插件：到上游的请求随之断开，转写以中止原因拒绝', async () => {
    const upstream = await hangingUpstream();
    const { service, disable } = await boot(plugin, config);
    const failure = service.transcribe({ attachment: { kind: 'audio', data: upstream.url } }).then(
      () => undefined,
      (err: unknown) => err,
    );
    await expect.poll(() => upstream.seen.requested).toBe(true);
    await disable();
    await expect.poll(() => upstream.seen.closed).toBe(true);
    expect(await failure).toMatchObject({ name: 'AbortError' });
  });
});

describe('plugin-asr-openai：转写请求随中止停下', () => {
  /** fetch 替身：sent 记下每次请求收到的中止信号，请求只在中止时以中止原因拒绝 */
  const stubFetch = () => {
    const sent: Array<AbortSignal | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        sent.push(init?.signal ?? undefined);
        return untilAborted(init?.signal ?? undefined, () => init?.signal?.reason);
      }),
    );
    return sent;
  };

  it('转写请求途中中止：交给 fetch 的信号随之断开，转写以中止原因拒绝', async () => {
    const sent = stubFetch();
    const { service } = await boot(asrOpenai, { apiKey: 'k' });
    const ac = new AbortController();
    const pending = service.transcribe({ attachment: { kind: 'audio', data: WAV }, signal: ac.signal });
    await expect.poll(() => sent.length).toBe(1);
    ac.abort();
    expect(sent[0]?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('调用方没给信号，转写请求途中停用插件：交给 fetch 的信号随之断开，转写以中止原因拒绝', async () => {
    const sent = stubFetch();
    const { service, disable } = await boot(asrOpenai, { apiKey: 'k' });
    const failure = service.transcribe({ attachment: { kind: 'audio', data: WAV } }).then(
      () => undefined,
      (err: unknown) => err,
    );
    await expect.poll(() => sent.length).toBe(1);
    await disable();
    expect(sent[0]?.aborted).toBe(true);
    expect(await failure).toMatchObject({ name: 'AbortError' });
  });
});

describe('plugin-asr-whisper-cpp：子进程随中止停下', () => {
  /** 卡住的那一步：说明、命令、卡住时已发起的子进程调用数 */
  const steps = [
    ['ffmpeg 转码', 'ffmpeg', 1],
    ['whisper-cli 识别', 'whisper-cli', 2],
  ] as const;

  it.each(steps)('%s途中中止：交给它的中止信号随之断开，以中止原因拒绝、不按失败报', async (_label, cmd, count) => {
    const { service, execs } = await boot(asrWhisper, { modelPath: '/tmp/ggml-base.bin' }, cmd);
    const ac = new AbortController();
    const pending = service.transcribe({ attachment: { kind: 'audio', data: WAV }, signal: ac.signal });
    await expect.poll(() => execs.length).toBe(count);
    ac.abort();
    expect(execs.at(-1)?.signal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each(
    steps,
  )('调用方没给信号，%s途中停用插件：交给它的中止信号随之断开，以中止原因拒绝', async (_label, cmd, count) => {
    const { service, execs, disable } = await boot(asrWhisper, { modelPath: '/tmp/ggml-base.bin' }, cmd);
    const failure = service.transcribe({ attachment: { kind: 'audio', data: WAV } }).then(
      () => undefined,
      (err: unknown) => err,
    );
    await expect.poll(() => execs.length).toBe(count);
    await disable();
    expect(execs.at(-1)?.signal?.aborted).toBe(true);
    expect(await failure).toMatchObject({ name: 'AbortError' });
  });
});

describe('plugin-media 经 asr 桥接转写', () => {
  it('交给 asr 服务的是本插件这次激活的中止信号', async () => {
    const received: TranscribeInput[] = [];
    const ears: ASRService = {
      transcribe: async input => {
        received.push(input);
        return { text: '听到了' };
      },
    };
    const activation = new AbortController();
    const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;
    const service = new MediaServiceImpl(
      {
        logger: fixedRef(logger),
        llm: ref(),
        asr: ref([{ instance: ears, contextId: 'zz-ears' }]),
        memory: ref(),
        lifecycle: fixedRef({ signal: activation.signal } as never),
      },
      {
        vision: { maxTokens: 300, think: false },
        audio: { mode: 'enabled', maxTokens: 1024, think: true },
        video: { maxTokens: 300, think: false },
      } as unknown as MediaConfigResolved,
    );
    expect(await service.transcribe({ kind: 'audio', data: WAV })).toBe('听到了');
    expect(received[0]?.signal).toBe(activation.signal);
  });
});
