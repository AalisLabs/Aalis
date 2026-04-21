import type { Context } from './context.js';
import type { Logger } from './logger.js';
import type { LLMCapability } from './types/llm.js';

/** 模型路由解析结果 */
export interface ModelProviderInfo {
  instance: unknown;
  model: string;
  contextId: string;
}

/** 聚合后的模型条目（携带提供者标识） */
export interface AggregatedModelInfo {
  id: string;
  capabilities: LLMCapability[];
  provider: string;
  contextId: string;
}

/** LLM 提供者形状（LLMRouter 只依赖这几个可选方法，避免对 LLMService 强耦合） */
interface LLMProviderShape {
  listModels?(): Promise<Array<{ id: string; capabilities: LLMCapability[] }>>;
  /** 提供者自报是否支持指定模型 ID（未实现则回退到 listModels 枚举） */
  supportsModel?(modelId: string): boolean | Promise<boolean>;
  /** 提供者自报默认模型 ID（未实现则返回 undefined） */
  getDefaultModelId?(): string | undefined;
}

/**
 * LLM 路由器
 *
 * 负责：
 * 1. 聚合所有已注册 'llm' 服务的模型列表。
 * 2. 按 model ID 反查所属提供者（带缓存，服务变更时自动失效）。
 * 3. 作为后续扩展点（负载均衡、能力过滤、成本路由等）的载体。
 *
 * 本类不持有全局状态：每个 Context 拥有一份实例，缓存在实例上。
 * 由 ServiceContainer 共享真实数据源，所以同一 App 下不同子 Context
 * 的路由结果一致。
 */
export class LLMRouter {
  private _cache: Map<string, string> | null = null;
  private _cacheTime = 0;
  private _cachePromise: Promise<Map<string, string>> | null = null;

  private static readonly CACHE_TTL = 60_000;

  constructor(private readonly ctx: Context, private readonly logger: Logger) {}

  /**
   * 聚合所有 LLM 提供者的模型列表
   *
   * @example
   * const models = await router.listAllModels();
   * // [{ id: 'gpt-4o', capabilities: [...], provider: 'OpenAI', contextId: '...' }, ...]
   */
  async listAllModels(): Promise<AggregatedModelInfo[]> {
    const providers = this.ctx.getAllServices<LLMProviderShape>('llm');
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

  /**
   * 按 model ID 查找拥有该模型的 LLM 提供者
   *
   * 解析顺序：
   * 1. 若提供者实现了 `supportsModel(id)`，优先按此同步判断；
   * 2. 否则回退到 `listModels()` 枚举构建缓存（TTL 60s）。
   *
   * @example
   * const result = await router.resolveModelProvider('gpt-4o');
   * if (result) await (result.instance as LLMService).chat({ messages, model: result.model });
   */
  async resolveModelProvider(modelId: string): Promise<ModelProviderInfo | undefined> {
    // 快路径：提供者自报支持
    const providers = this.ctx.getAllServices<LLMProviderShape>('llm');
    for (const { instance, contextId } of providers) {
      if (typeof instance.supportsModel === 'function') {
        try {
          if (await instance.supportsModel(modelId)) {
            return { instance, model: modelId, contextId };
          }
        } catch { /* ignore, fall back to enumeration */ }
      }
    }

    // 慢路径：缓存 + listModels 枚举
    const cache = await this._ensureCache();
    const targetContextId = cache.get(modelId);
    if (!targetContextId) return undefined;

    const found = providers.find(p => p.contextId === targetContextId);
    return found ? { instance: found.instance, model: modelId, contextId: targetContextId } : undefined;
  }

  /**
   * 获取完整的 model→contextId 映射（带缓存）
   * 供需要批量查找或自行路由的插件使用。
   */
  getModelProviderMap(): Promise<Map<string, string>> {
    return this._ensureCache();
  }

  /** 使 model→provider 缓存立即失效（服务注册/注销时应当调用） */
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
      const providers = this.ctx.getAllServices<LLMProviderShape>('llm');
      for (const { instance, contextId } of providers) {
        if (typeof instance.listModels !== 'function') continue;
        try {
          const models = await instance.listModels();
          for (const m of models) {
            if (!map.has(m.id)) map.set(m.id, contextId);
          }
        } catch { /* skip unavailable provider */ }
      }
      this._cache = map;
      this._cacheTime = Date.now();
      this._cachePromise = null;
      return map;
    })();

    return this._cachePromise;
  }
}
