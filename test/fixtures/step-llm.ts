import {
  type ChatModelRequest,
  type ChatResponse,
  type ChatStreamChunk,
  LLMCapabilities,
  type LLMModel,
  llm,
} from '../../packages/api-llm/src/index.js';
import { definePlugin, provide } from '../../packages/core/src/index.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 能挂住某一次调用的模型替身：decide 按请求与这是第几次调用（从 1 数）作答；hold(n) 让第 n 次调用进来之后停住，直到放行，
// 这一次的中止信号触发时以 AbortError 结束（与真的服务商一样）。记下的是请求那一刻的快照：agent 在同一个消息数组上接着改。
// 用例借它把一轮停在「正在调用模型」上，看这期间到的输入怎么处理。
// ════════════════════════════════════════════════════════════

type Gate = ReturnType<typeof deferred<void>>;

export class StepModel implements LLMModel {
  readonly id = 'step-model';
  readonly providerId = '@aalis/test-fixture-step-llm';
  readonly contextLength = 32_768;
  readonly maxOutputTokens = 1024;
  readonly requests: ChatModelRequest[] = [];
  readonly #holds = new Map<number, { entered: Gate; release: Gate }>();

  readonly capabilities = [LLMCapabilities.Chat, LLMCapabilities.ToolCalling, LLMCapabilities.Streaming];

  constructor(private readonly decide: (request: ChatModelRequest, n: number) => ChatResponse) {}

  /** 挂住第 n 次调用：entered 在它进来时落定，release 之后才作答 */
  hold(n: number): { entered: Promise<void>; release: () => void } {
    const gate = { entered: deferred<void>(), release: deferred<void>() };
    this.#holds.set(n, gate);
    return { entered: gate.entered.promise, release: () => gate.release.resolve() };
  }

  async chat(request: ChatModelRequest): Promise<ChatResponse> {
    return this.decide(this.#record(request), this.requests.length);
  }

  async *chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
    const snapshot = this.#record(request);
    const n = this.requests.length;
    const gate = this.#holds.get(n);
    if (gate) {
      gate.entered.resolve();
      const { signal } = request;
      await Promise.race([
        gate.release.promise,
        new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true })),
      ]);
    }
    if (request.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const response = this.decide(snapshot, n);
    if (response.content) yield { contentDelta: response.content };
    yield { done: true, ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}) };
  }

  #record(request: ChatModelRequest): ChatModelRequest {
    const { signal, ...rest } = request;
    const snapshot = { ...structuredClone(rest), signal };
    this.requests.push(snapshot);
    return snapshot;
  }
}

/** 把替身登记成对话模型的插件 */
export function stepModelPlugin(model: StepModel) {
  return definePlugin({
    name: model.providerId,
    provides: [llm],
    uses: { provide },
    apply: ({ provide }) => void provide.use(llm, model, { entryId: `${model.providerId}/${model.id}` }),
  });
}

/** 一次只调一个工具的回复 */
export const callTool = (name: string, args: Record<string, unknown> = {}, id = `call-${name}`): ChatResponse => ({
  content: null,
  toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
