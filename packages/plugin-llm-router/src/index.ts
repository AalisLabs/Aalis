import type { Context } from '@aalis/core';
import { ServicePriority } from '@aalis/core';
import { LLMCapabilities } from '@aalis/plugin-llm-api';
import { LLMRouter } from './router.js';

export const name = '@aalis/plugin-llm-router';
export const displayName = 'LLM 路由器';
export const subsystem = 'llm';
export const provides = ['llm'];

export const inject = {
  optional: ['llm'],
};

export function apply(ctx: Context): void {
  const router = new LLMRouter(ctx, ctx.logger.child('llm-router'));

  // 以同名 facade 模式注册为 'llm' 服务：对外像普通 LLMService，内部聚合其他 LLM provider。
  // priority: Router（100）保证默认 getService('llm') 拿到 router 而非任意后端。
  ctx.provide('llm', router, {
    capabilities: [LLMCapabilities.Chat, LLMCapabilities.Router],
    priority: ServicePriority.Router,
  });
}

export { LLMRouter } from './router.js';
