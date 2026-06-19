import type { ConfigSchema, Context } from '../../packages/core/src/index.js';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMService,
} from '../../packages/plugin-llm-api/src/index.js';
import { LLMCapabilities } from '../../packages/plugin-llm-api/src/index.js';

/**
 * Mock LLM 插件（fixture）
 *
 * 提供可编程的 `LLMService`，用于不联网的集成测试。
 *
 * 用法：
 *   const recorder: ChatRequest[] = [];
 *   const responses: ChatResponse[] = [{ content: 'hi' }];
 *   await ctx.useModule(createMockLLMPlugin({ responses, recorder }));
 */

export interface MockLLMOptions {
  /** 顺序消费的预设响应；用尽后重复使用最后一项 */
  responses?: ChatResponse[];
  /** 每次 chat 的请求都会被 push 进来 */
  recorder?: ChatRequest[];
  /** 模拟延迟（毫秒） */
  latencyMs?: number;
  /** chat() 应该抛出的错误（一次性） */
  throwOnce?: Error;
  /** 上下文长度，默认 8192 */
  contextLength?: number;
  /** 默认温度，默认 0.7 */
  temperature?: number;
  /** 最大输出 token，默认 1024 */
  maxTokens?: number;
}

export class MockLLMService implements LLMService {
  private readonly opts: Required<Omit<MockLLMOptions, 'throwOnce' | 'recorder' | 'responses'>> & {
    throwOnce?: Error;
    recorder?: ChatRequest[];
    responses: ChatResponse[];
  };
  private cursor = 0;

  /** 能力元数据（与真实 provider 一致，挂在 model handle 实例上供 resolveLLMModel/listLLMModels 读取）。 */
  readonly capabilities = [LLMCapabilities.Chat, LLMCapabilities.ToolCalling, LLMCapabilities.Streaming];

  constructor(options: MockLLMOptions = {}) {
    this.opts = {
      responses: options.responses ?? [{ content: 'mock response' }],
      recorder: options.recorder,
      latencyMs: options.latencyMs ?? 0,
      throwOnce: options.throwOnce,
      contextLength: options.contextLength ?? 8192,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens ?? 1024,
    };
  }

  private nextResponse(): ChatResponse {
    const idx = Math.min(this.cursor, this.opts.responses.length - 1);
    this.cursor++;
    return this.opts.responses[idx];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.opts.recorder?.push(request);
    if (this.opts.throwOnce) {
      const err = this.opts.throwOnce;
      this.opts.throwOnce = undefined;
      throw err;
    }
    if (this.opts.latencyMs > 0) await new Promise(r => setTimeout(r, this.opts.latencyMs));
    return this.nextResponse();
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    this.opts.recorder?.push(request);
    if (this.opts.throwOnce) {
      const err = this.opts.throwOnce;
      this.opts.throwOnce = undefined;
      throw err;
    }
    const resp = this.nextResponse();
    const text = resp.content ?? '';
    for (let i = 0; i < text.length; i += 4) {
      if (this.opts.latencyMs > 0) await new Promise(r => setTimeout(r, this.opts.latencyMs));
      yield { contentDelta: text.slice(i, i + 4) };
    }
    if (resp.toolCalls) yield { toolCalls: resp.toolCalls };
    yield { done: true, usage: resp.usage };
  }

  getTemperature() {
    return this.opts.temperature;
  }
  getMaxTokens() {
    return this.opts.maxTokens;
  }
  getContextLength() {
    return this.opts.contextLength;
  }
  getDefaultModelId() {
    return 'mock-model';
  }
  async listModels() {
    return [
      {
        id: 'mock-model',
        capabilities: [LLMCapabilities.Chat, LLMCapabilities.ToolCalling, LLMCapabilities.Streaming],
      },
    ];
  }
}

export interface MockLLMPluginConfig extends MockLLMOptions {}

export function createMockLLMPlugin(options: MockLLMOptions = {}) {
  const service = new MockLLMService(options);
  return {
    name: '@aalis/test-fixture-mock-llm',
    apply(ctx: Context, _config: Record<string, unknown>) {
      ctx.provide('llm', service, {
        capabilities: [LLMCapabilities.Chat, LLMCapabilities.ToolCalling, LLMCapabilities.Streaming],
      });
    },
    /** 直接访问以便断言 */
    service,
  };
}

export const mockLLMConfigSchema: ConfigSchema = {};
