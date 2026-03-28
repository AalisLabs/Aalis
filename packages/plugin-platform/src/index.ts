import type { Context, PlatformConnection, PlatformManagerService, App } from '@aalis/core';

// ----- 元数据 -----

export const name = '@aalis/plugin-platform';
export const displayName = '平台管理';
export const provides = ['platform-manager'];

export const inject = {
  optional: ['platform'],
};

// ----- 入口 -----

export function apply(ctx: Context): void {
  const getApp = (): App | undefined => ctx.getService<App>('app');

  const manager: PlatformManagerService = {
    getPluginGroups() {
      const app = getApp();
      if (!app) return [];

      // 本插件 inject.optional = ['platform']
      // 找到所有 provides 包含 'platform' 的活跃插件 → 归入平台子系统
      const targetServices = new Set(['platform']);
      const grouped: string[] = [];

      for (const p of app.plugins.getStatus()) {
        if (p.provides?.some(s => targetServices.has(s))) {
          grouped.push(p.instanceId);
        }
      }

      return [{ label: '平台接入', plugins: grouped }];
    },

    getConnections(): PlatformConnection[] {
      return ctx.getPlatformDetails().flatMap(d => d.connections);
    },

    getPlatformNames(): string[] {
      return ctx.getPlatformNames();
    },
  };

  ctx.provide('platform-manager', manager);
}
