import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type ASRService, asr, type TranscribeInput } from '../../packages/api-asr/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type ChatModelRequest, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { type MediaService, media } from '../../packages/api-media/src/index.js';
import { type ExecResult, type ProcessService, processService } from '../../packages/api-process/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, LogHub, provide } from '../../packages/core/src/index.js';
import mediaPlugin from '../../packages/plugin-media/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 来消息即识别的预处理是本插件自己发起的，交给下载、ffprobe、ffmpeg 与内置 LLM 处理器的中止信号是本插件这次激活的；
// describe、transcribe 与 describeVideo 把调用方给的信号与它合并。停用或调用方中止时这些随之停下，不等到各自的时限；
// 中止不按取不到、没有音轨、转不了处理，到达识别也不再处理后面的附件。ffmpeg 与 ffprobe 经进程服务调用：替身里卡住的那条一直不回，中止时按非零退出拒绝
// （与 process 服务停掉进程组后一样），其余照常回放输出；存储在内存里，不依赖本机的 ffmpeg；识别模型是替身。
// ════════════════════════════════════════════════════════════

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)]);
/** 带 ID3v2 标签头、够 256 字节：按 MP3 原样交给模型，不转码 */
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(300)]);
/** AMR 文件头：不是原样交给模型的格式，转写前先经 ffmpeg 转成 WAV */
const AMR = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(32)]);
const dataUri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
const VIDEO = { kind: 'video', data: 'data:video/mp4;base64,AAAAIGZ0eXBpc29t' };

type Hang = { cmd: 'ffprobe' } | { cmd: 'ffmpeg'; arg: string } | { chat: true } | { asr: true };

const apps: App[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const c of cleanups.splice(0)) await c();
});

/**
 * 真插件装进 App。hang 指定卡住的那一步：ffprobe、带某个参数的 ffmpeg（抽帧 -vf、抽音轨 libmp3lame、转码 pcm_s16le）、
 * 模型调用，或经 asr 桥接的转写（这时另装一个 asr 提供者、模型不认音频，转写走 asr）；卡住的那一步中止时拒绝，已中止时
 * 调用的立即拒绝。ffprobe 数出 frames 帧；ffmpeg 照常写出帧、音轨与 WAV。execs、chats、heard 记下每次调用与收到的中止
 * 信号，warns 收告警
 */
async function boot(hang: Hang, frames = 2) {
  const files = new Map<string, Buffer>();
  const store = {
    async readFile(uri: string) {
      const data = files.get(uri);
      if (!data) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      return data;
    },
    async writeFile(uri: string, data: string | Buffer) {
      files.set(uri, Buffer.from(data));
    },
  } as unknown as StorageService;
  const stopped = (what: string, signal?: AbortSignal) =>
    new Promise<never>((_, reject) => {
      const stop = () => reject(new Error(`${what} 被中止`));
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    });

  const execs: Array<{ cmd: string; args: readonly string[]; signal?: AbortSignal }> = [];
  let seq = 0;
  const uriOf = (path: string) => `tmp:${path.slice('/zz-virtual'.length)}`;
  const done = (stdout = ''): ExecResult => ({ code: 0, signal: null, stdout, stderr: '' });
  const proc = {
    async makeTempDir(prefix: string) {
      const name = `${prefix}-${seq++}`;
      return { path: `/zz-virtual/${name}`, uri: `tmp:/${name}`, cleanup: async () => {} };
    },
    async execFile(cmd: string, args: readonly string[], opts: { signal?: AbortSignal } = {}) {
      execs.push({ cmd, args, signal: opts.signal });
      if ('cmd' in hang && hang.cmd === cmd && (hang.cmd === 'ffprobe' || args.includes(hang.arg))) {
        return stopped(cmd, opts.signal);
      }
      if (opts.signal?.aborted) throw new Error(`${cmd} 被中止`);
      if (cmd === 'ffprobe') return done(String(frames));
      const output = args[args.length - 1] as string;
      if (args.includes('libmp3lame')) files.set(uriOf(output), MP3);
      else if (args.includes('pcm_s16le')) files.set(uriOf(output), Buffer.alloc(300));
      else for (let i = 1; i <= frames; i++) files.set(uriOf(output.replace('%04d', String(i).padStart(4, '0'))), PNG);
      return done();
    },
  } as unknown as ProcessService;

  const chats: ChatModelRequest[] = [];
  const model: LLMModel = {
    id: 'seer',
    providerId: 'fake-host',
    contextLength: 8000,
    capabilities: 'asr' in hang ? ['chat', 'vision'] : ['chat', 'vision', 'audio'],
    async chat(request) {
      chats.push(request);
      if ('chat' in hang || request.signal?.aborted) return stopped('识别', request.signal);
      return { content: '看到了' };
    },
  };
  const heard: TranscribeInput[] = [];
  const ears: ASRService = {
    transcribe: input => {
      heard.push(input);
      return stopped('转写', input.signal);
    },
  };
  const host = definePlugin({
    name: 'fake-host',
    provides: 'asr' in hang ? [processService, storage, llm, asr] : [processService, storage, llm],
    uses: { provide },
    apply({ provide }) {
      provide.use(processService, proc);
      provide.use(storage, store);
      provide.use(llm, model, { entryId: 'fake-host/seer' });
      if ('asr' in hang) provide.use(asr, ears);
    },
  });
  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  apps.push(app);
  await registerHubs(app);
  const bound = app.bind({ media, hooks });
  await app.plugin(host, {});
  await app.plugin(mediaPlugin, { video: { mode: 'frames+asr' }, audio: { mode: 'enabled' } });
  await app.plugins.idle();
  if (!bound.media.present) throw new Error(`plugin-media 没有激活：${app.plugins.getPlugin(mediaPlugin.name)?.error}`);
  const service: MediaService = bound.media.use;
  return {
    service,
    execs,
    chats,
    heard,
    warns,
    disable: () => app.plugins.disable(mediaPlugin.name),
    /** 主模型能看图时发出前的一次 agent:llm:before，signal 是这一轮的中止信号；passed 为是否交给了下一步 */
    llmBefore: async (images: string[], signal?: AbortSignal) => {
      const message = { role: 'user' as const, content: '看看', images };
      let passed = false;
      await bound.hooks.use.run(
        'agent:llm:before',
        { messages: [message], tools: [], acceptsImages: true, signal },
        async () => {
          passed = true;
        },
      );
      return { message, passed };
    },
    /** 一条带这些附件的消息到达；报告上另挂着处理过的消息（描述写在它的 _attachmentDescriptions 里） */
    arrive: async (...attachments: Array<{ kind: string; data: string }>) => {
      const message = {
        sessionId: 'onebot:t:group:1',
        platform: 'onebot',
        content: '',
        attachments,
      } as unknown as IncomingMessage;
      return Object.assign(await service.processMessage(message), { message });
    },
  };
}

type Booted = Awaited<ReturnType<typeof boot>>;

describe('来消息即识别随停用中止', () => {
  it.each([
    ['视频数帧', { cmd: 'ffprobe' } as const, 2],
    ['视频抽音轨（数不出帧，直接抽音轨）', { cmd: 'ffmpeg', arg: 'libmp3lame' } as const, 0],
  ])('%s途中停用：交给它的中止信号随之断开，这条附件按中止记错，不当成没有内容', async (_label, hang, frames) => {
    const t = await boot(hang, frames);
    const pending = t.arrive(VIDEO);
    await expect.poll(() => t.execs.at(-1)?.cmd).toBe(hang.cmd);
    await t.disable();
    expect(t.execs.at(-1)?.signal?.aborted).toBe(true);
    expect((await pending).items[0].error).toBeDefined();
  });

  it.each([
    ['视频的帧识别', VIDEO],
    ['静图识别', { kind: 'image', data: dataUri('image/png', PNG) }],
    ['语音转写（MP3 原样交给模型）', { kind: 'audio', data: dataUri('audio/mpeg', MP3) }],
  ])('%s的模型调用途中停用：交给它的中止信号随之断开', async (_label, attachment) => {
    const t = await boot({ chat: true });
    const pending = t.arrive(attachment);
    await expect.poll(() => t.chats.length).toBe(1);
    await t.disable();
    expect(t.chats[0].signal?.aborted).toBe(true);
    await pending;
  });

  it('语音转码途中停用：交给 ffmpeg 的中止信号随之断开，不按「转不了」告警，不再调模型转写', async () => {
    const t = await boot({ cmd: 'ffmpeg', arg: 'pcm_s16le' });
    const pending = t.arrive({ kind: 'audio', data: dataUri('audio/amr', AMR) });
    await expect.poll(() => t.execs.length).toBe(1);
    await t.disable();
    expect(t.execs[0].signal?.aborted).toBe(true);
    await pending;
    expect(t.warns.filter(message => message.includes('无法转码'))).toEqual([]);
    expect(t.chats).toEqual([]);
  });

  it('视频网址下载途中停用：到上游的请求随之断开，这条附件按中止记错，不当成读不出', async () => {
    const seen = { requested: false, closed: false };
    const upstream = createServer(req => {
      seen.requested = true;
      req.on('close', () => {
        seen.closed = true;
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    setNetworkPolicy({ blockPrivate: false }); // 只为连本机的上游桩；用完复原
    cleanups.push(async () => {
      setNetworkPolicy({ blockPrivate: true });
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    });
    const t = await boot({ chat: true });
    const port = (upstream.address() as AddressInfo).port;
    const pending = t.arrive({ kind: 'video', data: `http://127.0.0.1:${port}/a.mp4` });
    await expect.poll(() => seen.requested).toBe(true);
    await t.disable();
    await expect.poll(() => seen.closed).toBe(true);
    expect((await pending).items[0].error).toBeDefined();
  });

  it('停用之后，同一条消息后面的附件不再处理', async () => {
    const t = await boot({ cmd: 'ffprobe' });
    const pending = t.arrive(VIDEO, { kind: 'audio', data: dataUri('audio/mpeg', MP3) });
    await expect.poll(() => t.execs.length).toBe(1);
    await t.disable();
    const report = await pending;
    expect(report.items.map(item => item.error !== undefined)).toEqual([true, true]);
    expect(t.execs).toHaveLength(1);
    expect(t.chats).toEqual([]);
  });

  it.each([
    ['识图', { kind: 'image', data: dataUri('image/png', PNG) }],
    ['转写', { kind: 'audio', data: dataUri('audio/mpeg', MP3) }],
  ] as const)('describe %s的模型调用途中停用：交给它的中止信号随之断开，不告警', async (_label, attachment) => {
    const t = await boot({ chat: true });
    const pending = t.service.describe([attachment]);
    await expect.poll(() => t.chats.length).toBe(1);
    await t.disable();
    expect(t.chats[0].signal?.aborted).toBe(true);
    expect(await pending).toEqual([undefined]);
    expect(t.warns.filter(message => /描述失败|识别失败/.test(message))).toEqual([]);
  });

  it('主模型直通时动图抽帧途中停用：交给 ffprobe 的中止信号随之断开，这条的图不再交出，这一轮照常往下', async () => {
    const t = await boot({ cmd: 'ffprobe' });
    const pending = t.llmBefore([VIDEO.data]);
    await expect.poll(() => t.execs.length).toBe(1);
    await t.disable();
    expect(t.execs[0].signal?.aborted).toBe(true);
    const { message, passed } = await pending;
    expect(passed).toBe(true);
    expect(message.images).toEqual([]);
  });

  it('主模型直通时动图抽帧途中这一轮被停下：交给 ffprobe 的中止信号随之断开，钩子抛中止原因，不交给下一步', async () => {
    const t = await boot({ cmd: 'ffprobe' });
    const turn = new AbortController();
    const pending = t.llmBefore([VIDEO.data], turn.signal);
    await expect.poll(() => t.execs.length).toBe(1);
    turn.abort();
    expect(t.execs[0].signal?.aborted).toBe(true);
    await expect(pending).rejects.toBe(turn.signal.reason);
  });

  it.each([
    ['内置 LLM 处理器', { chat: true } as const, (t: Booted) => t.chats],
    ['asr 桥接', { asr: true } as const, (t: Booted) => t.heard],
  ])('语音转写途中停用（%s）：交给它的中止信号随之断开，不告警，描述位不写识别失败', async (_label, hang, calls) => {
    const t = await boot(hang);
    const pending = t.arrive({ kind: 'audio', data: dataUri('audio/mpeg', MP3) });
    await expect.poll(() => calls(t).length).toBe(1);
    await t.disable();
    expect(calls(t)[0].signal?.aborted).toBe(true);
    const report = await pending;
    expect(report.items[0].error).toBeDefined();
    expect((report.message._attachmentDescriptions ?? []).filter(Boolean)).toEqual([]);
    expect(t.warns.filter(message => /识别失败|附件处理失败/.test(message))).toEqual([]);
  });

  it('视频音轨转写途中停用（asr 桥接）：到达识别与 describeVideo 都不告警、不写失败', async () => {
    const t = await boot({ asr: true });
    const arrival = t.arrive(VIDEO);
    await expect.poll(() => t.heard.length).toBe(1);
    const described = t.service.describeVideo(`${VIDEO.data}#again`);
    await expect.poll(() => t.heard.length).toBe(2);
    await t.disable();
    const report = await arrival;
    expect(report.items[0].error).toBeDefined();
    expect((report.message._attachmentDescriptions ?? []).filter(Boolean)).toEqual([]);
    expect(await described).toBe('');
    expect(t.warns.filter(message => /识别失败|附件处理失败|describeVideo 失败/.test(message))).toEqual([]);
  });

  it('describeVideo 途中停用：交给 ffprobe 的中止信号随之断开', async () => {
    const t = await boot({ cmd: 'ffprobe' });
    const pending = t.service.describeVideo(VIDEO.data);
    await expect.poll(() => t.execs.length).toBe(1);
    await t.disable();
    expect(t.execs[0].signal?.aborted).toBe(true);
    expect(await pending).toBe('');
  });
});

describe('describe、transcribe 与 describeVideo 随调用方的信号中止', () => {
  it.each([
    ['识图', { kind: 'image', data: dataUri('image/png', PNG) }],
    ['转写', { kind: 'audio', data: dataUri('audio/mpeg', MP3) }],
  ] as const)('describe %s的模型调用途中调用方中止：交给它的中止信号随之断开，不告警', async (_label, attachment) => {
    const t = await boot({ chat: true });
    const caller = new AbortController();
    const pending = t.service.describe([attachment], { signal: caller.signal });
    await expect.poll(() => t.chats.length).toBe(1);
    caller.abort();
    expect(t.chats[0].signal?.aborted).toBe(true);
    expect(await pending).toEqual([undefined]);
    expect(t.warns.filter(message => /描述失败|识别失败/.test(message))).toEqual([]);
  });

  it.each([
    ['内置 LLM 处理器', { chat: true } as const, (t: Booted) => t.chats],
    ['asr 桥接', { asr: true } as const, (t: Booted) => t.heard],
  ])('transcribe 途中调用方中止（%s）：交给它的中止信号随之断开，抛中止原因，不告警', async (_label, hang, calls) => {
    const t = await boot(hang);
    const caller = new AbortController();
    const pending = t.service.transcribe(
      { kind: 'audio', data: dataUri('audio/mpeg', MP3) },
      { signal: caller.signal },
    );
    await expect.poll(() => calls(t).length).toBe(1);
    caller.abort();
    expect(calls(t)[0].signal?.aborted).toBe(true);
    await expect(pending).rejects.toBe(caller.signal.reason);
    expect(t.warns.filter(message => message.includes('识别失败'))).toEqual([]);
  });

  it.each([
    ['数帧', { cmd: 'ffprobe' } as const, (t: Booted) => t.execs],
    ['音轨转写（asr 桥接）', { asr: true } as const, (t: Booted) => t.heard],
  ])('describeVideo %s途中调用方中止：交给它的中止信号随之断开，不告警', async (_label, hang, calls) => {
    const t = await boot(hang);
    const caller = new AbortController();
    const pending = t.service.describeVideo(VIDEO.data, { signal: caller.signal });
    await expect.poll(() => calls(t).length).toBe(1);
    caller.abort();
    expect(calls(t)[0].signal?.aborted).toBe(true);
    expect(await pending).toBe('');
    expect(t.warns.filter(message => message.includes('describeVideo 失败'))).toEqual([]);
  });
});
