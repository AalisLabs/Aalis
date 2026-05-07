import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  Context,
  LLMCapability,
  LLMService,
  Logger,
  ModelInfo,
} from '@aalis/core';

/** Provider 端额外可选方法（不强制写入 LLMService 主接口） */
interface LLMProviderShape extends Partial<LLMService> {
  listModels?(): Promise<Array<{ id: string; capabilities: LLMCapability[] }>>;
  supportsModel?(modelId: string): boolean | Promise<boolean>;
  getDefaultModelId?(): string | undefined;
}

/** 经 ctx.getAllServices 枚举出的 provider 条目 */
interface LLMProviderEntry {
  instance: LLMProviderShape;
  contextId: string;
  capabilities: string[];
  label?: string;
}

/**
 * LLM 路由器
 *
 * 同名 facade 模式（与 plugin-storage-router 对齐）：通过
 * `ctx.provide('llm', router, { capabilities: ['router'] })` 注册成 'llm' 服务的
 * "高优先级聚合层"。底层 provider 仍以 `provide('llm', impl)` 单独存在，router
 * 通过 `ctx.getAllServices('llm')` 枚举它们并按 ChatRequest.model 分发。
 *
 * 对外 API（消费者视角）：
 * - `getService<LLMService>('llm')?.chat({ model, ... })` —— router 内部按 model 路由
 * - `getService<LLMService>('llm', ['router'])?.listModels()` —— 聚合所有 provider 的模型，
 *   返回 ModelInfo[]（带 provider/contextId），供 introspection 使用
 *
 * 自我排除：枚举 'llm' 服务时过滤掉 instance === this，避免无限递归。
 *
 * 路由策略：当 ChatRequest 指定了 model，router 调用各 provider 的 supportsModel(id)
 * 同步快路径定位归属；未指定 model 时回退到默认 provider（首个满足能力要求的）。
 * provider 必须实现 supportsModel —— 没实现则该 provider 永远拿不到按 model 路由的请求。
 */
export class LLMRouter implements LLMService {
  constructor(private readonly ctx: Context, private readonly logger: Logger) {}

  /** 仅枚举真正的 LLM provider，排除 router 自身 */
  private getProviders(): LLMProviderEntry[] {
    return this.ctx.getAllServices<LLMProviderShape>('llm')
      .filter(e => (e.instance as unknown) !== this);
  }

  // ---- LLMService 实现：按 model 路由到具体 provider ----

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { instance, routedRequest, contextId } = await this.resolveProviderForRequest(request);
    if (typeof instance.chat !== 'function') {
      throw new Error(`LLM provider ${contextId} 不支持 chat()`);
    }
    return instance.chat(routedRequest);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const { instance, routedRequest, contextId } = await this.resolveProviderForRequest(request, ['streaming']);
    if (typeof instance.chatStream !== 'function') {
      throw new Error(`LLM provider ${contextId} 不支持 chatStream()`);
    }
    yield* instance.chatStream(routedRequest);
  }

  getTemperature(): number {
    return this.getDefaultProviderOrThrow().instance.getTemperature?.() ?? 0.7;
  }

  getMaxTokens(): number {
    return this.getDefaultProviderOrThrow().instance.getMaxTokens?.() ?? 4096;
  }

  getContextLength(): number {
    return this.getDefaultProviderOrThrow().instance.getContextLength?.() ?? 8192;
  }

  getDefaultModelId(): string | undefined {
    return this.getDefaultProvider()?.instance.getDefaultModelId?.();
  }

  /** 聚合所有 provider 的模型；同 ID 出现在多个 provider 时合并 capabilities */
  async listModels(): Promise<ModelInfo[]> {
    const seen = new Map<string, ModelInfo>();
    for (const { instance, contextId, label } of this.getProviders()) {
      if (typeof instance.listModels !== 'function') continue;
      try {
        const models = await instance.listModels();
        for (const m of models) {
          const existing = seen.get(m.id);
          if (!existing) {
            seen.set(m.id, { id: m.id, capabilities: m.capabilities, provider: label ?? contextId, contextId });
          } else {
            const caps = new Set<LLMCapability>([...existing.capabilities, ...m.capabilities]);
            existing.capabilities = [...caps];
          }
        }
      } catch (err) {
        this.logger.warn(`获取模型列表失败 [${contextId}]:`, err);
      }
    }
    return [...seen.values()];
  }

  async supportsModel(modelId: string): Promise<boolean> {
    return (await this.resolveModelProvider(modelId)) !== undefined;
  }

  // ---- 内部 ----

  /** 按 model ID 查找拥有该模型的 provider；未命中返回 undefined */
  private async resolveModelProvider(modelId: string): Promise<LLMProviderEntry | undefined> {
    for (const provider of this.getProviders()) {
      if (typeof provider.instance.supportsModel !== 'function') continue;
      try {
        if (await provider.instance.supportsModel(modelId)) return provider;
      } catch { /* fall through */ }
    }
    return undefined;
  }

  private async resolveProviderForRequest(
    request: ChatRequest,
    extraRequiredCapabilities: string[] = [],
  ): Promise<{ instance: LLMProviderShape; routedRequest: ChatRequest; contextId: string }> {
    const requiredCapabilities = this.getRequiredCapabilities(request, extraRequiredCapabilities);

    if (request.model) {
      const provider = await this.resolveModelProvider(request.model);
      if (provider) {
        if (!this.hasCapabilities(provider, requiredCapabilities)) {
          throw new Error(
            `模型 "${request.model}" 的 provider ${provider.contextId} 不满足请求能力 ` +
              `[${requiredCapabilities.join(', ')}]`,
          );
        }
        return { instance: provider.instance, routedRequest: request, contextId: provider.contextId };
      }
      this.logger.warn(`未找到模型 "${request.model}" 对应的 LLM provider，将回退到默认 provider`);
    }

    const provider = this.resolveDefaultProvider(requiredCapabilities);
    return { instance: provider.instance, routedRequest: request, contextId: provider.contextId };
  }

  private getRequiredCapabilities(request: ChatRequest, extra: string[]): string[] {
    const required = new Set(extra);
    if (request.tools && request.tools.length > 0) required.add('tool_calling');
    if (request.messages.some(m => m.images && m.images.length > 0)) required.add('vision');
    if (request.think === true) required.add('thinking');
    return [...required];
  }

  private resolveDefaultProvider(requiredCapabilities: string[]): LLMProviderEntry {
    const providers = this.getProviders();
    if (providers.length === 0) {
      throw new Error('没有可用的 LLM provider');
    }
    if (requiredCapabilities.length === 0) return providers[0];

    const found = providers.find(p => this.hasCapabilities(p, requiredCapabilities));
    if (found) return found;

    this.logger.warn(
      `没有找到同时满足能力 [${requiredCapabilities.join(', ')}] 的 LLM provider，回退到默认 provider ${providers[0].contextId}`,
    );
    return providers[0];
  }

  private hasCapabilities(provider: LLMProviderEntry, requiredCapabilities: string[]): boolean {
    return requiredCapabilities.every(c => provider.capabilities.includes(c));
  }

  private getDefaultProvider(): LLMProviderEntry | undefined {
    return this.getProviders()[0];
  }

  private getDefaultProviderOrThrow(): LLMProviderEntry {
    const provider = this.getDefaultProvider();
    if (!provider) throw new Error('没有可用的 LLM provider');
    return provider;
  }
}
