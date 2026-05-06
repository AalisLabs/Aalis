import type { Context, Logger, AggregatedModelInfo, LLMCapability, LLMRouterService, ModelProviderInfo } from '@aalis/core';

interface LLMProviderShape {
  listModels?(): Promise<Array<{ id: string; capabilities: LLMCapability[] }>>;
  supportsModel?(modelId: string): boolean | Promise<boolean>;
  getDefaultModelId?(): string | undefined;
}

/**
 * LLM 路由器
 *
 * 同名 facade 模式（与 plugin-storage-router 对齐）：通过
 * `ctx.provide('llm', router, { capabilities: ['router'] })` 注册为 'llm' 服务
 * 的一个提供者，带 'router' 能力标记。消费者按需选择：
 * - getService('llm', ['router']) → 拿路由器本身（调用 listAllModels / resolveModelProvider）
 * - getService('llm') → 拿默认真提供者（由 servicePreferences.llm 指定）
 *
 * 自我排除：枚举 'llm' 服务时过滤掉 instance === this，避免无限递归。
 */
export class LLMRouter implements LLMRouterService {
  private _cache: Map<string, string> | null = null;
  private _cacheTime = 0;
  private _cachePromise: Promise<Map<string, string>> | null = null;
  private static readonly CACHE_TTL = 60_000;

  constructor(private readonly ctx: Context, private readonly logger: Logger) {}

  /** 仅枚举真正的 LLM provider，排除路由器自身 */
  private getProviders(): Array<{ instance: LLMProviderShape; contextId: string; label?: string }> {
    return this.ctx.getAllServices<LLMProviderShape>('llm')
      .filter(e => (e.instance as unknown) !== this);
  }

  async listAllModels(): Promise<AggregatedModelInfo[]> {
    const providers = this.getProviders();
    const results: AggregatedModelInfo[] = [];
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

  async resolveModelProvider(modelId: string): Promise<ModelProviderInfo | undefined> {
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

  invalidate(): void {
    this._cache = null;
    this._cachePromise = null;
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
