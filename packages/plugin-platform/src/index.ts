import type { Context } from '@aalis/core';
import { PlatformCapabilities } from './types.js';
import { PlatformRouter } from './router.js';

export type { PlatformConnection, PlatformSelfIdentity, PlatformAdapter, PlatformService, PlatformCapability, PlatformCapabilityRegistry } from './types.js';
export { PlatformCapabilities } from './types.js';

// ----- 元数据 -----

export const name = '@aalis/plugin-platform';
export const displayName = '平台管理';
// 同名 facade：以 'platform' 服务名注册聚合层，capability='router'
export const provides = ['platform'];

export const inject = {
  optional: ['platform'],
};

// ----- 入口 -----

export function apply(ctx: Context): void {
  // PlatformRouter 同时实现 PlatformService（聚合视图）和 PlatformAdapter（按 sessionId 路由），
  // 直接以同名 facade 注册。consumer 按需以两种接口之一获取。
  const router = new PlatformRouter(ctx, ctx.logger.child('platform-router'));
  ctx.provide('platform', router, { capabilities: [PlatformCapabilities.Router] });
}

export { PlatformRouter } from './router.js';
