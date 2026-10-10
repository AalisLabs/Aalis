import { describe, expect, it, vi } from 'vitest';
import type { ChatModelRequest, LLMModel } from '../../packages/api-llm/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { scanLLMProcessors } from '../../packages/plugin-media/src/llm-adapter.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerMediaTools } from '../../packages/plugin-media/src/tools.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { emptyMediaCaps, fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// analyze_image（识图）声明可转后台：执行器给这次调用的中止信号经 media 服务一路传到识图的模型调用，中止时识图停住。
// 识图模型是替身：一直不回，中止后以中止原因拒绝；不连任何模型服务。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

function setup() {
  const requests: ChatModelRequest[] = [];
  const vision: LLMModel = {
    id: 'zz-vision',
    providerId: 'zz-provider',
    contextLength: 8192,
    capabilities: ['vision'],
    chat: request => {
      requests.push(request);
      return new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
      });
    },
  };
  const cfg = {
    vision: { recognizeOnArrival: true, delivery: 'describe', maxTokens: 300, think: false, prompt: '' },
    audio: { maxTokens: 1024, think: true },
    video: { maxTokens: 300, think: false },
    animatedImage: { maxFrames: 4 },
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(emptyMediaCaps(logger), cfg);
  for (const processor of scanLLMProcessors({
    llm: ref([{ instance: vision, contextId: 'zz-provider/zz-vision', priority: 0 }]),
    logger,
  })) {
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
    },
    svc,
  );
  if (!analyze) throw new Error('analyze_image 没有登记');
  return { analyze, requests, svc };
}

describe('analyze_image 可转后台', () => {
  it('声明可转后台（让出时限用执行器的默认）', () => {
    expect(setup().analyze.background).toEqual({});
  });

  it('调用的中止信号传到识图的模型调用；中止时停住、回错', async () => {
    const { analyze, requests } = setup();
    const ac = new AbortController();
    const pending = analyze.handler(
      { image: 'https://zz.invalid/a.png', task: '看看是什么' },
      { sessionId: 's', signal: ac.signal },
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].signal).toBe(ac.signal);
    ac.abort();
    const out = await pending;
    expect(JSON.parse(typeof out === 'string' ? out : out.content).error).toBeDefined();
  });

  it('动图走抽帧合并识别时，同样把中止信号交给识图的模型调用', async () => {
    const { requests, svc } = setup();
    vi.spyOn(svc as unknown as { framesFromLocal(): Promise<string[]> }, 'framesFromLocal').mockResolvedValue([
      'data:image/png;base64,AAAA',
    ]);
    const ac = new AbortController();
    const pending = svc.describeImage('https://zz.invalid/a.gif', {
      localPath: '/zz-host/a.gif',
      noCache: true,
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].signal).toBe(ac.signal);
    ac.abort();
    await expect(pending).rejects.toBeDefined();
  });
});
