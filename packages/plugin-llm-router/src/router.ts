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

interface LLMProviderShape extends Partial<LLMService> {
  listModels?(): Promise<Array<{ id: string; capabilities: LLMCapability[] }>>;
  supportsModel?(modelId: string): boolean | Promise<boolean>;
  getDefaultModelId?(): string | undefined;
}

interface LLMProviderEntry {
  instance: LLMProviderShape;
  contextId: string;
  capabilities: string[];
  label?: string;
}

/** 模型路由解析结果（router 内部类型，不对外暴露） */
interface ResolvedProvider {
  instance: LLMProviderShape;
  model: string;
  contextId: string;
}

/**
 * LLM 路由器
 *
 * 同名 facade 模式（与 plugin-storage-router 对齐）：注册为 'llm' 服务的一个普通
 * provider，同时带 'router' 能力。对外实现 LLMService；对内聚合并转发到其他同名
 * LLM provider。
 *
 * 对外 API（消费者视角）：
 * - `getService<LLMService>('llm')?.chat({ model, ... })` —— router 内部按 model 路由
 * - `getService<LLMService>('llm', ['router'])?.listModels()` —— router 聚合后返回 ModelInfo[]（带 provider/contextId），只用于 introspection
 *
 * 内部细节（resolveModelProvider / getModelProviderMap / invalidate）不再作为公开 API；
 * 调用方应直接通过 LLMService.chat 让 router 路由，而不是手动解析 provider 后调 chat。
 *
 * 自我排除：枚举 'llm' 服务时过滤掉 instance === this，避免无限递归。
 */
export class LLMRouter implements LLMService {
  private _cache: Map<string, string> | null = null;
  private _cacheTime = 0;
  private _cachePromise: Promise<Map<string, string>> | null = null;
  private static readonly CACHE_TTL = 60_000;

  constructor(private readonly ctx: Context, private readonly logger: Logger) {}

  /** 仅枚举真正的 LLM provider，排除路由器自身 */
  private getProviders(): LLMProviderEntry[] {
    return this.ctx.getAllServices<LLMProviderShape>('llm')
      .filter(e => (e.instance as unknown) !== this);
  }

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
    const provider = this.getDefaultProviderOrThrow();
    return provider.instance.getTemperature?.() ?? 0.7;
  }

  getMaxTokens(): number {
    const provider = this.getDefaultProviderOrThrow();
    return provider.instance.getMaxTokens?.() ?? 4096;
  }

  getContextLength(): number {
    const provider = this.getDefaultProviderOrThrow();
    return provider.instance.getContextLength?.() ?? 8192;
  }

  async listModels(): Promise<ModelInfo[]> {
    const seen = new Map<string, ModelInfo>();
    for (const model of await this._listAllProviders()) {
      const existing = seen.get(model.id);
      if (!existing) {
        seen.set(model.id, { id: model.id, capabilities: model.capabilities, provider: model.provider, contextId: model.contextId });
      } else {
        const caps = new Set<LLMCapability>([...existing.capabilities, ...model.capabilities]);
        existing.capabilities = [...caps];
      }
    }
    return [...seen.values()];
  }

  getDefaultModelId(): string | undefined {
    return this.getDefaultProvider()?.instance.getDefaultModelId?.();
  }

  async supportsModel(modelId: string): Promise<boolean> {
    return (await this.resolveModelProvider(modelId)) !== undefined;
  }

  private async _listAllProviders(): Promise<ModelInfo[]> {
    const providers = this.getProviders();
    const results: ModelInfo[] = [];
    await Promise.all(providers.map(async ({ instance, contextId, label }) => {
      if (typeof instance.listModels !== 'function') return;
      try {
        const models = await instance.listModels();
        for (const m of models) {
          results.push({ ...m, provider: label ?? contextId, contextId });
        }
      } catch (err) {
        this.logger.warn(`获取模型列表失败 [${contextId}]:`, err);
      }
    }));
    return results;
  }

  /** 路由器内部：按 model ID 查找 provider；不对外暴露，调用方应使用 chat({model}) */
  private async resolveModelProvider(modelId: string): Promise<ResolvedProvider | undefined> {
    const providers = this.getProviders();
    for (const { instance, contextId } of providers) {
      if (typeof instance.supportsModel === 'function') {
        try {
          if (await instance.supportsModel(modelId)) {
            return { instance, model: modelId, contextId };
          }
        } catch { /* fall through */ }
      }
    }
    const cache = await this._ensureCache();
    const targetContextId = cache.get(modelId);
    if (!targetContextId) return undefined;
    const found = providers.find(p => p.contextId === targetContextId);
    return found ? { instance: found.instance, model: modelId, contextId: targetContextId } : undefined;
  }

  getModelProviderMap(): Promise<Map<string, string>> {
    return this._ensureCache();
  }

  /** 路由器内部缓存失效（由 plugin index 在 service 注册/注销时调用） */
  invalidate(): void {
    this._cache = null;
    this._cachePromise = null;
  }

  private async resolveProviderForRequest(
    request: ChatRequest,
    extraRequiredCapabilities: string[] = [],
  ): Promise<{ instance: LLMProviderShape; routedRequest: ChatRequest; contextId: string }> {
    const requiredCapabilities = this.getRequiredCapabilities(request, extraRequiredCapabilities);

    if (request.model) {
      const resolved = await this.resolveModelProvider(request.model);
      if (resolved) {
        const provider = this.getProviders().find(p => p.contextId === resolved.contextId);
        if (provider && !this.hasCapabilities(provider, requiredCapabilities)) {
          throw new Error(
            `模型 "${request.model}" 的 provider ${resolved.contextId} 不满足请求能力 ` +
              `[${requiredCapabilities.join(', ')}]`,
          );
        }
        return {
          instance: resolved.instance as LLMProviderShape,
          routedRequest: request,
          contextId: resolved.contextId,
        };
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

  private _ensureCache(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this._cache && (now - this._cacheTime) < LLMRouter.CACHE_TTL) {
      return Promise.resolve(this._cache);
    }
    if (this._cachePromise) return this._cachePromise;

    this._cachePromise = (async () => {
      const map = new Map<string, string>();
      const providers = this.getProviders();
      for (const { instance, contextId } of providers) {
        if (typeof instance.listModels !== 'function') continue;
        try {
          const models = await instance.listModels();
          for (const m of models) {
            if (!map.has(m.id)) map.set(m.id, contextId);
          }
        } catch { /* skip */ }
      }
      this._cache = map;
      this._cacheTime = Date.now();
      this._cachePromise = null;
      return map;
    })();

    return this._cachePromise;
  }
}
