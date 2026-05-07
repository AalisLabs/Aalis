import type { ServiceContainer, ServiceEntry, PlatformAdapter, PlatformConnection, PlatformSelfIdentity } from '@aalis/core';

/**
 * 平台注册表
 *
 * 从 ServiceContainer 中聚合 `'platform'` 服务的所有条目，返回按不同视角
 * 的平台信息快照。不持有状态——每次调用直接从容器读取。
 *
 * facade 自身也注册到 `'platform'`（capability:'router'），需排除。
 */
export class PlatformRegistry {
  constructor(private readonly services: ServiceContainer) {}

  /** 获取所有 'platform' entry，排除 router facade 自身 */
  private getAdapterEntries(): ServiceEntry[] {
    return this.services.getEntries('platform').filter(e => !e.capabilities.has('router'));
  }

  /** 所有合规的平台适配器实例 */
  listAdapters(): PlatformAdapter[] {
    return this.getAdapterEntries()
      .map(e => e.instance as PlatformAdapter)
      .filter(a => a && typeof a.getConnections === 'function');
  }

  /** 所有已注册的平台名称（去重，基于 capability 聚合） */
  listPlatformNames(): string[] {
    const names = new Set<string>();
    for (const entry of this.getAdapterEntries()) {
      for (const cap of entry.capabilities) names.add(cap);
    }
    return [...names];
  }

  /** 所有平台适配器及其连接详情 */
  listDetails(): Array<{
    adapterName: string;
    platform: string;
    contextId: string;
    capabilities: string[];
    connections: PlatformConnection[];
  }> {
    return this.getAdapterEntries().map(entry => {
      const adapter = entry.instance as PlatformAdapter;
      return {
        adapterName: adapter.adapterName,
        platform: adapter.platform,
        contextId: entry.contextId,
        capabilities: [...entry.capabilities],
        connections: adapter.getConnections(),
      };
    });
  }

  /** 某个平台账号自身身份 */
  getSelfIdentity(platform: string, sessionId?: string): PlatformSelfIdentity | undefined {
    for (const entry of this.getAdapterEntries()) {
      const adapter = entry.instance as PlatformAdapter;
      if (!adapter || adapter.platform !== platform) continue;
      return adapter.getSelfIdentity?.(sessionId);
    }
    return undefined;
  }
}
