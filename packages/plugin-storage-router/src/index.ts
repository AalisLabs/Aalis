import type { Context } from '@aalis/core';
import { StorageRouter } from './router.js';

export const name = '@aalis/plugin-storage-router';
export const displayName = '存储路由器';
export const provides = ['storage'];

// router 不强依赖任何 provider —— 没有 provider 时仍能正常存在（listRoots 返回空）
export const inject = {
  optional: ['storage'],
};

export function apply(ctx: Context): void {
  const router = new StorageRouter(ctx, ctx.logger.child('storage-router'));

  // 服务注册/注销时自动失效根名映射缓存
  ctx.on('service:registered', svcName => {
    if (svcName === 'storage') router.invalidate();
  });
  ctx.on('service:unregistered', svcName => {
    if (svcName === 'storage') router.invalidate();
  });

  // 用 'router' capability 标记：消费者可通过 capability 过滤获得 router；
  // 不指定 capability 时按服务偏好/优先级解析（默认即可拿到 router）。
  ctx.provide('storage', router, { capabilities: ['router'] });
}

export type { AggregatedStorageRoot, StorageRootConflict } from './router.js';
export { StorageRouter } from './router.js';
