import type { Context } from '@aalis/core';
import { LLMRouter } from './router.js';

export const name = '@aalis/plugin-llm-router';
export const displayName = 'LLM 路由器';
export const provides = ['llm'];

export const inject = {
  optional: ['llm'],
};

export function apply(ctx: Context): void {
  const router = new LLMRouter(ctx, ctx.logger.child('llm-router'));

  // model→provider 映射缓存随 'llm' 服务变更失效
  ctx.on('service:registered', (svcName) => {
    if (svcName === 'llm') router.invalidate();
  });
  ctx.on('service:unregistered', (svcName) => {
    if (svcName === 'llm') router.invalidate();
  });

  // 以 'router' capability 注册为 'llm' 服务的提供者（与 storage-router 对齐）：
  // - 消费者拿路由器：getService('llm', ['router']) → router
  // - 默认 LLM：getService('llm') → 由 servicePreferences.llm 指定的真提供者
  ctx.provide('llm', router, { capabilities: ['router'] });
}

export { LLMRouter } from './router.js';
