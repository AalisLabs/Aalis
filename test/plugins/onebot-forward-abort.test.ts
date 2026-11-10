import { describe, expect, it, vi } from 'vitest';
import type { I18nService } from '../../packages/api-i18n/src/index.js';
import type { ChatModelRequest, LLMModel } from '../../packages/api-llm/src/index.js';
import type { MediaService } from '../../packages/api-media/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { ProcessService } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { createForwardExpander, type ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import { fixedRef } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 合并转发展开途中适配器停用：转发里图片、语音、视频的识别与摘要的模型调用都收到展开器的中止信号（本插件这次激活的），
// 随之停下；展开抛中止原因，不按识别失败写占位、不记告警，也不把半截的展开记进缓存。识别与摘要都是替身，
// 一直不回，只在收到的信号断开时按中止原因落定；process 服务缺席，媒体不落盘、直接拿原始地址识别。
// ════════════════════════════════════════════════════════════

const node = (content: unknown[]) => ({ type: 'node', data: { nickname: '甲', user_id: '1', content } });

const MEDIA_NODES = [
  node([
    { type: 'image', data: { url: 'https://example.invalid/a.png' } },
    { type: 'record', data: { url: 'https://example.invalid/a.amr' } },
    { type: 'video', data: { url: 'https://example.invalid/a.mp4' } },
  ]),
];
const TEXT_NODES = [node([{ type: 'text', data: { text: 'hello' } }])];

/** 一直不回的工作：记下收到的信号，信号断开时按中止原因落定，没收到信号的一直不落定 */
function stall(signals: Array<AbortSignal | undefined>, signal?: AbortSignal): Promise<never> {
  signals.push(signal);
  return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

function harness(nodes: unknown[], cfg: Partial<ForwardConfig>) {
  const controller = new AbortController();
  const signals = {
    image: [] as Array<AbortSignal | undefined>,
    audio: [] as Array<AbortSignal | undefined>,
    video: [] as Array<AbortSignal | undefined>,
    summary: [] as Array<AbortSignal | undefined>,
  };
  const warns: string[] = [];
  const logger: Logger = {
    info() {},
    debug() {},
    error() {},
    warn: (message: string) => {
      warns.push(message);
    },
    child: () => logger,
  } as Logger;
  const media: Partial<MediaService> = {
    describeImage: (_src, opts) => stall(signals.image, opts?.signal),
    transcribe: (_att, opts) => stall(signals.audio, opts?.signal),
    describeVideo: (_src, opts) => stall(signals.video, opts?.signal),
  };
  const model = { capabilities: ['chat'], chat: (request: ChatModelRequest) => stall(signals.summary, request.signal) };
  const expander = createForwardExpander<null>({
    logger,
    memory: fixedRef<MemoryService>(undefined),
    media: fixedRef(media as MediaService),
    llm: fixedRef(model as unknown as LLMModel),
    i18n: fixedRef<I18nService>(undefined),
    storage: {} as StorageService,
    processService: fixedRef<ProcessService>(undefined),
    forwardCfg: {
      enabled: true,
      maxDepth: 3,
      maxNodesPerLevel: 30,
      imageRecognition: true,
      imageRecognitionConcurrency: 3,
      recognitionMaxItems: 0,
      summarize: false,
      summaryMaxChars: 600,
      summaryInputLimit: 0,
      ...cfg,
    },
    attachmentMaxBytes: 1024,
    signal: controller.signal,
    sendAction: async () => ({ messages: nodes }),
  });
  const run = expander.expandForwards(null, [{ type: 'forward', data: { id: 'F1' } }], 's');
  return { controller, signals, warns, expander, run };
}

describe('合并转发展开途中停用', () => {
  it('图片、语音、视频的识别收到的中止信号随之断开；展开抛中止原因，不记告警，缓存里没有半截的展开', async () => {
    const h = harness(MEDIA_NODES, {});
    await vi.waitFor(() =>
      expect([h.signals.image, h.signals.audio, h.signals.video].map(s => s.length)).toEqual([1, 1, 1]),
    );
    h.controller.abort();
    expect([...h.signals.image, ...h.signals.audio, ...h.signals.video].map(s => s?.aborted)).toEqual([
      true,
      true,
      true,
    ]);
    await expect(h.run).rejects.toBe(h.controller.signal.reason);
    expect(h.warns).toEqual([]);
    expect((await h.expander.getOrLoadForward('F1'))?.fullText).toBeUndefined();
  });

  it('摘要的模型调用收到的中止信号随之断开；展开抛中止原因，不记「摘要生成失败」，缓存里没有半截的展开', async () => {
    const h = harness(TEXT_NODES, { summarize: true });
    await vi.waitFor(() => expect(h.signals.summary).toHaveLength(1));
    h.controller.abort();
    expect(h.signals.summary[0]?.aborted).toBe(true);
    await expect(h.run).rejects.toBe(h.controller.signal.reason);
    expect(h.warns).toEqual([]);
    expect((await h.expander.getOrLoadForward('F1'))?.fullText).toBeUndefined();
  });
});
