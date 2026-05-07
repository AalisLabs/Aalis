import type { Context, PlatformConnection, PlatformAdapter, PlatformService, App } from '@aalis/core';
import { PlatformCapabilities } from '@aalis/core';
import { PlatformRegistry } from './registry.js';

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
  const getApp = (): App | undefined => ctx.getService<App>('app');
  const registry = new PlatformRegistry(ctx.serviceContainer);

  const facade: PlatformService = {
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
      return registry.listDetails().flatMap(d => d.connections);
    },

    getPlatformNames(): string[] {
      return registry.listPlatformNames();
    },

    getAdapters(): PlatformAdapter[] {
      return registry.listAdapters();
    },

    getDetails() {
      return registry.listDetails();
    },

    getSelfIdentity(platform: string, sessionId?: string) {
      return registry.getSelfIdentity(platform, sessionId);
    },
  };

  ctx.provide('platform', facade, { capabilities: [PlatformCapabilities.Router] });
}
