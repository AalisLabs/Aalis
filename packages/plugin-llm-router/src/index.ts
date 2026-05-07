import { LLMCapabilities } from '@aalis/core';
import type { Context, ModelInfo } from '@aalis/core';
import { LLMRouter } from './router.js';

export const name = '@aalis/plugin-llm-router';
export const displayName = 'LLM 路由器';
export const provides = ['llm'];

export const inject = {
  optional: ['llm'],
};

export function apply(ctx: Context): void {
  const router = new LLMRouter(ctx, ctx.logger.child('llm-router'));

  // 以同名 facade 模式注册为 'llm' 服务：对外像普通 LLMService，内部聚合其他 LLM provider。
  ctx.provide('llm', router, {
    capabilities: [
      LLMCapabilities.Chat,
      LLMCapabilities.Router,
    ],
  });
}

export { LLMRouter } from './router.js';

/**
 * 默认 supportsModel 推导：以 listModels 返回的 id 集合为准。
 *
 * 适合**不需要通配/直通语义**的 provider 直接复用，例如：
 *
 * ```ts
 * class MyLLMProvider implements LLMService {
 *   async listModels() { return [...]; }
 *   supportsModel = defaultSupportsModel(() => this.listModels());
 * }
 * ```
 *
 * 注意事项：
 * - 该 helper 内部缓存首次 listModels 结果（首次后变为同步）。如果 listModels 会动态变化，
 *   provider 应自己实现 supportsModel 而不是用此 helper。
 * - 如果 provider 想表达"任意 id 我都接"（OpenAI 兼容 endpoint 的通配直通），
 *   不要用此 helper，自己写 `supportsModel = () => true` 之类。
 */
export function defaultSupportsModel(
  listModels: () => Promise<Array<Pick<ModelInfo, 'id'>>>,
): (modelId: string) => Promise<boolean> {
  let cache: Set<string> | undefined;
  return async (modelId: string) => {
    if (!cache) {
      try {
        cache = new Set((await listModels()).map(m => m.id));
      } catch {
        cache = new Set();
      }
    }
    return cache.has(modelId);
  };
}
