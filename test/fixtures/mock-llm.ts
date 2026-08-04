import type { ChatModelRequest, ChatResponse, ChatStreamChunk, LLMModel } from '../../packages/api-llm/src/index.js';
import { LLMCapabilities } from '../../packages/api-llm/src/index.js';
import type { Context } from '../../packages/core/src/index.js';
import type { ConfigSchema } from '../../packages/schema-config/src/index.js';

/**
 * Mock LLM 插件（fixture）
 *
 * 提供可编程的 `LLMModel`（per-model entry），用于不联网的集成测试。
 *
 * 这份 mock 曾 `implements LLMService` —— 那个接口在 service-granularity 重构后就不存在了，
 * 于是 implements 子句等于**零约束**：mock 缺 `contextLength`，而 agent 用它算 tokenBudget
 * （`contextLength - maxOutputTokens - safetyMargin`），实测整条端到端链路跑在 NaN 预算上、
 * 压力分桶恒为 0，裁剪/截断这条历史上出过事的路径在集成测试里等于零覆盖，还看着是绿的。
 * `test/` 目录当时无人 typecheck，所以三年也没人发现。现由 tsconfig.test.json 钉住。
 *
 * 用法：
 *   const recorder: ChatModelRequest[] = [];
 *   const responses: ChatResponse[] = [{ content: 'hi' }];
 *   await ctx.useModule(createMockLLMPlugin({ responses, recorder }));
 */

export interface MockLLMOptions {
  /** 顺序消费的预设响应；用尽后重复使用最后一项 */
  responses?: ChatResponse[];
  /** 每次 chat 的请求都会被 push 进来 */
  recorder?: ChatModelRequest[];
  /** 模拟延迟（毫秒） */
  latencyMs?: number;
  /** chat() 应该抛出的错误（一次性） */
  throwOnce?: Error;
  /** 上下文长度，默认 8192。**agent 的 tokenBudget 直接吃它**，留空会让预算变 NaN。 */
  contextLength?: number;
  /** provider 建议的最大输出 token，默认 1024 */
  maxOutputTokens?: number;
  /** model id，默认 'mock-model' */
  id?: string;
  /** 所属 provider 的 contextId，默认 '@aalis/test-fixture-mock-llm' */
  providerId?: string;
}

export class MockLLMService implements LLMModel {
  private readonly opts: Required<Omit<MockLLMOptions, 'throwOnce' | 'recorder' | 'responses'>> & {
    throwOnce?: Error;
    recorder?: ChatModelRequest[];
    responses: ChatResponse[];
  };
  private cursor = 0;

  readonly id: string;
  readonly providerId: string;
  readonly contextLength: number;
  readonly maxOutputTokens: number;
  /** 能力元数据（与真实 provider 一致，挂在 model handle 实例上供 resolveLLMModel/listLLMModels 读取）。 */
  readonly capabilities = [LLMCapabilities.Chat, LLMCapabilities.ToolCalling, LLMCapabilities.Streaming];

  constructor(options: MockLLMOptions = {}) {
    this.opts = {
      responses: options.responses ?? [{ content: 'mock response' }],
      recorder: options.recorder,
      latencyMs: options.latencyMs ?? 0,
      throwOnce: options.throwOnce,
      contextLength: options.contextLength ?? 8192,
      maxOutputTokens: options.maxOutputTokens ?? 1024,
      id: options.id ?? 'mock-model',
      providerId: options.providerId ?? '@aalis/test-fixture-mock-llm',
    };
    this.id = this.opts.id;
    this.providerId = this.opts.providerId;
    this.contextLength = this.opts.contextLength;
    this.maxOutputTokens = this.opts.maxOutputTokens;
  }

  private nextResponse(): ChatResponse {
    const idx = Math.min(this.cursor, this.opts.responses.length - 1);
    this.cursor++;
    return this.opts.responses[idx];
  }

  async chat(request: ChatModelRequest): Promise<ChatResponse> {
    this.opts.recorder?.push(request);
    if (this.opts.throwOnce) {
      const err = this.opts.throwOnce;
      this.opts.throwOnce = undefined;
      throw err;
    }
    if (this.opts.latencyMs > 0) await new Promise(r => setTimeout(r, this.opts.latencyMs));
    return this.nextResponse();
  }

  async *chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
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
}

export interface MockLLMPluginConfig extends MockLLMOptions {}

export function createMockLLMPlugin(options: MockLLMOptions = {}) {
  const service = new MockLLMService(options);
  return {
    name: '@aalis/test-fixture-mock-llm',
    apply(ctx: Context, _config: Record<string, unknown>) {
      // 能力挂在 handle 自身的 `capabilities` 字段上，不是 provide 的选项——
      // `provide` 的第三参只有 `{ priority?, label?, entryId? }`。
      ctx.provide('llm', service, { entryId: `${service.providerId}/${service.id}` });
    },
    /** 直接访问以便断言 */
    service,
  };
}

export const mockLLMConfigSchema: ConfigSchema = {};
