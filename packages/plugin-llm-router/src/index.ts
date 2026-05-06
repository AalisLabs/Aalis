import { LLMCapabilities } from '@aalis/core';
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

  // 以同名 facade 模式注册为 'llm' 服务：对外像普通 LLMService，内部聚合其他 LLM provider。
  ctx.provide('llm', router, {
    capabilities: [
      LLMCapabilities.Chat,
      LLMCapabilities.Streaming,
      LLMCapabilities.ToolCalling,
      LLMCapabilities.Vision,
      LLMCapabilities.Thinking,
      LLMCapabilities.Router,
    ],
  });
}

export { LLMRouter } from './router.js';
