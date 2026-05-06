import type { Context } from '@aalis/core';
import { LLMRouter } from './router.js';

export const name = '@aalis/plugin-llm-router';
export const displayName = 'LLM 路由器';
export const provides = ['llm-router'];

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

  ctx.provide('llm-router', router);
}

export { LLMRouter } from './router.js';
