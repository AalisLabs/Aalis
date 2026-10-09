import type { TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type ChatModelRequest, LLMCapabilities, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { compression, memory } from '../../packages/api-memory/src/index.js';
import { App, events, type Logger, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import { registerHubs } from './hubs.js';

/**
 * 假摘要模型：记下每次请求，按 reply 回（缺省回 `SUMMARY-TEXT`，reply 抛错即这次调用失败）。
 * 不声明 maxOutputTokens 时摘要的输出上限按 4096 封顶
 */
export function fakeSummaryLLM(
  options: {
    contextLength?: number;
    maxOutputTokens?: number;
    reply?: (request: ChatModelRequest, index: number) => string | Promise<string>;
  } = {},
) {
  const requests: ChatModelRequest[] = [];
  const model: LLMModel = {
    id: 'fake',
    providerId: 'fake',
    contextLength: options.contextLength ?? 8192,
    maxOutputTokens: options.maxOutputTokens,
    capabilities: [LLMCapabilities.Chat],
    async chat(request) {
      requests.push(request);
      return { content: await (options.reply?.(request, requests.length - 1) ?? 'SUMMARY-TEXT') };
    },
  };
  /** 第 index 次请求（负数从末尾数）的全部正文；没有这次请求时为空串 */
  const text = (index = -1) => (requests.at(index)?.messages ?? []).map(m => String(m.content ?? '')).join('\n');
  return { model, requests, text };
}

/**
 * 装好 memory-inmemory、message-archive 与 memory-summary、挂上桩 LLM，返回这次 App 的 memory、memory-summary 提供的
 * 压缩服务与宿主门面。给了 logger 时日志交给它
 */
export async function setupSummary(
  config: Record<string, unknown> = {},
  model: LLMModel = fakeSummaryLLM().model,
  logger?: Logger,
) {
  const app = new App({ name: 'T', logLevel: 'error', logger });
  await registerHubs(app);
  const host = app.bind({ provide, services, hooks, events });
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchive, { debugLogs: false });
  host.provide(llm, model);
  await app.plugin(memorySummary, config);
  await app.plugins.idle();
  // 激活闸：required 依赖（memory / llm）缺席时插件停在 pending 且不报错，
  // 后面的断言会红在无关的细节上、掩盖真实原因，故在此显式点名。
  if (app.plugins.getPlugin('@aalis/plugin-memory-summary')?.state !== 'active')
    throw new Error('plugin-memory-summary 未激活');
  const store = host.services.get(memory);
  if (!store) throw new Error('memory 服务未就绪');
  const compressor = host.services.get(compression);
  if (!compressor) throw new Error('compression 服务未就绪');
  return { app, host, memory: store, compression: compressor };
}

/** 判定用到的量；没给的取窗口 1000、裁剪预算 1000，默认压缩线 0.8 下有效阈值为 800 */
export interface TurnAmounts {
  used: number;
  compressible: number;
  contextWindow?: number;
  tokenBudget?: number;
}

/** 一条用量事件：可压缩部分全记在历史一项；不给 turnId 即 token:request 的快照 */
export function usageEvent(
  sessionId: string,
  { used, compressible, contextWindow = 1000, tokenBudget = 1000 }: TurnAmounts,
  extra: { turnId?: string; platform?: string } = {},
): TokenUsageEvent {
  return {
    sessionId,
    turnId: extra.turnId,
    platform: extra.platform ?? 'webui',
    contextWindow,
    maxTokens: 100,
    tokenBudget,
    used,
    usageRatio: used / contextWindow,
    breakdown: {
      system: 0,
      persona: 0,
      memorySummary: 0,
      memoryVector: 0,
      skills: 0,
      platform: 0,
      subtask: 0,
      systemOther: 0,
      history: compressible,
      toolResults: 0,
      toolDefs: 0,
      reservedForReply: 100,
    },
    parts: [],
  };
}

type Host = Pick<Awaited<ReturnType<typeof setupSummary>>['host'], 'events' | 'hooks'>;
interface TurnOptions {
  platform?: string;
  outcome?: 'replied' | 'silent' | 'aborted' | 'error';
}
let turns = 0;

/**
 * 开始一轮：与 agent 相同，整轮跑在 agent:input:before 的 next 里。end 时给了用量先发这一轮最后一次调用的用量
 * （带这一轮的 turnId），再跑 agent:turn:after，等这一轮结束
 */
export function startTurn(host: Host, sessionId: string, options: TurnOptions = {}) {
  const turnId = `turn-${++turns}`;
  const platform = options.platform ?? 'webui';
  const message = { sessionId, platform };
  let finish!: (amounts?: TurnAmounts) => void;
  const ending = new Promise<TurnAmounts | undefined>(r => (finish = r));
  const running = host.hooks.run(
    'agent:input:before' as never,
    { message, turnId, metadata: {} } as never,
    async () => {
      const amounts = await ending;
      if (amounts) await host.events.emit('token:usage', usageEvent(sessionId, amounts, { turnId, platform }));
      await host.hooks.run(
        'agent:turn:after' as never,
        { message, reply: 'ok', outcome: options.outcome ?? 'replied', sessionId, turnId, metadata: {} } as never,
      );
    },
  );
  return {
    turnId,
    async end(amounts?: TurnAmounts): Promise<void> {
      finish(amounts);
      await running;
    },
  };
}

/** 一轮从开始到结束 */
export function endTurn(host: Host, sessionId: string, amounts?: TurnAmounts, options?: TurnOptions): Promise<void> {
  return startTurn(host, sessionId, options).end(amounts);
}
