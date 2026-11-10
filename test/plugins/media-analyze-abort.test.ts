import { createServer, type IncomingMessage as HttpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { ChatModelRequest, LLMModel } from '../../packages/api-llm/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { scanLLMProcessors } from '../../packages/plugin-media/src/llm-adapter.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerMediaTools } from '../../packages/plugin-media/src/tools.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { gif } from '../fixtures/file-heads.js';
import { emptyMediaCaps, fixedRef, ref } from '../fixtures/service-ref.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// analyze_image（识图）声明可转后台：执行器给这次调用的中止信号经 media 服务一路传到识图的模型调用，中止时识图停住；调用方
// 没中止、media 停用或重启（本插件这次激活的信号断开）时同样停住。识图模型是替身：一直不回，中止后以中止原因拒绝；不连任何
// 模型服务。网址来源的下载也随这两个信号停下（上游是本机桩）。动图抽帧用的 ffprobe 与 ffmpeg 也是替身，不启动真实子进程。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

/** PNG 文件头与两帧的 GIF，都以 data URL 交给识图，不经存储与网络 */
const PNG = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`;
const ANIMATED_GIF = `data:image/gif;base64,${Buffer.from(gif(2)).toString('base64')}`;

/** delivery 'auto'：主模型能看图（工具上下文的 acceptsImages）时走直通分支；activation 是 media 这次激活的中止信号 */
function setup(delivery: 'describe' | 'auto' = 'describe', activation = new AbortController()) {
  const requests: ChatModelRequest[] = [];
  const vision: LLMModel = {
    id: 'zz-vision',
    providerId: 'zz-provider',
    contextLength: 8192,
    capabilities: ['vision'],
    chat: request => {
      requests.push(request);
      if (request.signal?.aborted) return Promise.reject(request.signal.reason);
      return new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
      });
    },
  };
  const cfg = {
    vision: { recognizeOnArrival: true, delivery, maxTokens: 300, think: false, prompt: '' },
    audio: { maxTokens: 1024, think: true },
    video: { maxTokens: 300, think: false },
    animatedImage: { maxFrames: 4 },
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(
    { ...emptyMediaCaps(logger), lifecycle: fixedRef({ signal: activation.signal } as never) },
    cfg,
  );
  for (const processor of scanLLMProcessors(
    {
      llm: ref([{ instance: vision, contextId: 'zz-provider/zz-vision', priority: 0 }]),
      logger,
      signal: new AbortController().signal,
    },
    { vision: { maxTokens: 2048 }, audio: { maxTokens: 2048 } },
  )) {
    svc.registerProcessor(processor);
  }
  let analyze: Omit<RegisteredTool, 'pluginName'> | undefined;
  registerMediaTools(
    {
      tools: fixedRef(
        stubBoundTools({
          onRegister: t => {
            if (t.definition.function.name === 'analyze_image') analyze = t;
          },
        }),
      ),
      memory: ref(),
      events: ref(),
      sessionManager: ref(),
      authority: ref(),
    },
    svc,
  );
  if (!analyze) throw new Error('analyze_image 没有登记');
  return { analyze, requests, svc };
}

/**
 * ffprobe 与 ffmpeg 的替身：hang 指定的那条一直不回，中止时按非零退出拒绝（与 process 服务停掉进程组后一样）；
 * 另一条立即成功。记下每次调用的命令与收到的中止信号
 */
function frameTools(hang: 'ffprobe' | 'ffmpeg') {
  const calls: Array<{ cmd: string; signal?: AbortSignal }> = [];
  setMediaRuntime({
    proc: {
      makeTempDir: async () => ({ path: '/zz-frames', uri: 'tmp:/zz-frames', cleanup: async () => {} }),
      execFile: (cmd: string, _args: readonly string[], opts: { signal?: AbortSignal } = {}) => {
        calls.push({ cmd, signal: opts.signal });
        if (cmd !== hang) return Promise.resolve({ code: 0, signal: null, stdout: '2', stderr: '' });
        return new Promise((_, reject) => {
          const stopped = () => reject(new Error(`execFile ${cmd} 退出码 null (signal SIGTERM)`));
          opts.signal?.addEventListener('abort', stopped, { once: true });
        });
      },
    } as never,
    storage: { writeFile: async () => {} } as never,
  });
  return calls;
}

describe('analyze_image 可转后台', () => {
  it('声明可转后台（让出时限用执行器的默认）', () => {
    expect(setup().analyze.background).toEqual({});
  });

  it('调用的中止信号传到识图的模型调用；中止时停住、回错', async () => {
    const { analyze, requests } = setup();
    const ac = new AbortController();
    const pending = analyze.handler(
      { image: PNG, task: '看看是什么' },
      toolContext({ sessionId: 's', signal: ac.signal }),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].signal?.aborted).toBe(false);
    ac.abort();
    expect(requests[0].signal?.aborted).toBe(true);
    const out = await pending;
    expect(JSON.parse(typeof out === 'string' ? out : out.content).error).toBeDefined();
  });

  it('调用方没中止、media 停用：识图的模型调用随之停住、回错', async () => {
    const activation = new AbortController();
    const { analyze, requests } = setup('describe', activation);
    const pending = analyze.handler(
      { image: PNG, task: '看看是什么' },
      toolContext({ sessionId: 's', signal: new AbortController().signal }),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    activation.abort();
    expect(requests[0].signal?.aborted).toBe(true);
    const out = await pending;
    expect(JSON.parse(typeof out === 'string' ? out : out.content).error).toBeDefined();
  });

  it('动图走抽帧合并识别时，同样把中止信号交给识图的模型调用', async () => {
    const { requests, svc } = setup();
    vi.spyOn(svc as unknown as { framesOf(): Promise<string[]> }, 'framesOf').mockResolvedValue([
      'data:image/png;base64,AAAA',
    ]);
    const ac = new AbortController();
    const pending = svc.describeImage(ANIMATED_GIF, { noCache: true, signal: ac.signal });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    ac.abort();
    expect(requests[0].signal?.aborted).toBe(true);
    await expect(pending).rejects.toBeDefined();
  });

  it.each([
    ['ffprobe', ['ffprobe']],
    ['ffmpeg', ['ffprobe', 'ffmpeg']],
  ] as const)('%s 途中中止：中止信号交给已调用的抽帧工具，停下回错，不退回整图识别', async (hang, called) => {
    const { requests, svc } = setup();
    const calls = frameTools(hang);
    const ac = new AbortController();
    const pending = svc.describeImage(ANIMATED_GIF, { noCache: true, signal: ac.signal });
    await vi.waitFor(() => expect(calls.map(c => c.cmd)).toEqual(called));
    ac.abort();
    for (const { cmd, signal } of calls) expect(signal?.aborted, cmd).toBe(true);
    await expect(pending).rejects.toBeDefined();
    expect(requests, '识图模型一次也没被调用').toHaveLength(0);
  });

  it('调用方不给信号、抽帧途中 media 停用：中止信号交给已调用的抽帧工具，停下回错', async () => {
    const activation = new AbortController();
    const { requests, svc } = setup('describe', activation);
    const calls = frameTools('ffprobe');
    const pending = svc.describeImage(ANIMATED_GIF, { noCache: true });
    await vi.waitFor(() => expect(calls.map(c => c.cmd)).toEqual(['ffprobe']));
    activation.abort();
    expect(calls[0].signal?.aborted).toBe(true);
    await expect(pending).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it('直通时调用方不给信号、抽帧途中 media 停用：中止信号交给已调用的抽帧工具，抛出', async () => {
    const activation = new AbortController();
    const { svc } = setup('auto', activation);
    const calls = frameTools('ffprobe');
    const pending = svc.transformModelImages([ANIMATED_GIF], 'passthrough');
    await vi.waitFor(() => expect(calls.map(c => c.cmd)).toEqual(['ffprobe']));
    activation.abort();
    expect(calls[0].signal?.aborted).toBe(true);
    await expect(pending).rejects.toBeDefined();
  });

  it('网址来源：下载来源字节也随中止信号停下，不等满下载时限，不退回整图识别', async () => {
    const { requests, svc } = setup();
    const held: HttpRequest[] = [];
    const closed: string[] = [];
    // 上游一直不回：只记下请求与它何时被断开
    const server = createServer(req => {
      held.push(req);
      req.socket.on('close', () => closed.push(req.url ?? ''));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    setNetworkPolicy({ blockPrivate: false }); // 只为连本机的上游桩；结束时复原
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow.png`;
      const ac = new AbortController();
      const rejected = expect(svc.describeImage(url, { noCache: true, signal: ac.signal })).rejects.toBeDefined();
      await vi.waitFor(() => expect(held).toHaveLength(1));
      ac.abort();
      await vi.waitFor(() => expect(closed).toEqual(['/slow.png']), { timeout: 2000 });
      await rejected;
      expect(requests, '识图模型一次也没被调用').toHaveLength(0);
    } finally {
      setNetworkPolicy({ blockPrivate: true });
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it.each([
    ['ffprobe', ['ffprobe']],
    ['ffmpeg', ['ffprobe', 'ffmpeg']],
  ] as const)('主模型能看图、直通时 %s 途中中止：中止信号交给已调用的抽帧工具，停下回错，不回 ok', async (hang, called) => {
    const { analyze, requests } = setup('auto');
    const calls = frameTools(hang);
    const ac = new AbortController();
    const pending = analyze.handler(
      { image: ANIMATED_GIF, task: '看看' },
      toolContext({ sessionId: 's', signal: ac.signal, acceptsImages: true }),
    );
    await vi.waitFor(() => expect(calls.map(c => c.cmd)).toEqual(called));
    ac.abort();
    for (const { cmd, signal } of calls) expect(signal?.aborted, cmd).toBe(true);
    const out = await pending;
    expect(typeof out, '回的是错误文本，不带图').toBe('string');
    expect(JSON.parse(out as string)).toEqual({ error: expect.any(String) });
    expect(requests, '识图模型一次也没被调用').toHaveLength(0);
  });
});
