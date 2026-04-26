import type { ServiceContainer } from './service.js';
import type { PlatformAdapter, PlatformConnection, PlatformSelfIdentity, PlatformSessionCandidate } from './types/index.js';

/**
 * 平台注册表
 *
 * 从 ServiceContainer 中聚合 `'platform'` 服务的所有条目，返回按不同视角
 * 的平台信息快照。不持有状态——每次调用直接从容器读取。
 *
 * 提取动机：把"领域聚合查询"从 Context 里抽出，与 LLMRouter 同风格。
 */
export class PlatformRegistry {
  constructor(private readonly services: ServiceContainer) {}

  /**
   * 获取所有已注册的平台适配器实例（过滤掉不合规的）。
   */
  listAdapters(): PlatformAdapter[] {
    return this.services.getEntries('platform')
      .map(e => e.instance as PlatformAdapter)
      .filter(a => a && typeof a.getConnections === 'function');
  }

  /**
   * 获取所有已注册的平台名称（去重）。
   *
   * 基于各 platform 服务的 capabilities 聚合，而非 adapter.platform 字段，
   * 因此一个 adapter 可以声明承载多个 platform（罕见）。
   */
  listPlatformNames(): string[] {
    const names = new Set<string>();
    for (const entry of this.services.getEntries('platform')) {
      for (const cap of entry.capabilities) names.add(cap);
    }
    return [...names];
  }

  /**
   * 获取所有平台适配器及其连接详情
   */
  listDetails(): Array<{
    adapterName: string;
    platform: string;
    contextId: string;
    capabilities: string[];
    connections: PlatformConnection[];
  }> {
    return this.services.getEntries('platform').map(entry => {
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

  /**
   * 获取某个平台账号自身身份。
   */
  getSelfIdentity(platform: string, sessionId?: string): PlatformSelfIdentity | undefined {
    for (const entry of this.services.getEntries('platform')) {
      const adapter = entry.instance as PlatformAdapter;
      if (!adapter || adapter.platform !== platform) continue;
      return adapter.getSelfIdentity?.(sessionId);
    }
    return undefined;
  }

  /**
   * 收集所有平台（或指定平台）的会话候选快照。
   */
  listSessionCandidates(platform?: string): PlatformSessionCandidate[] {
    const out: PlatformSessionCandidate[] = [];
    for (const entry of this.services.getEntries('platform')) {
      const adapter = entry.instance as PlatformAdapter;
      if (!adapter || typeof adapter.listSessionCandidates !== 'function') continue;
      if (platform && adapter.platform !== platform) continue;
      try {
        for (const c of adapter.listSessionCandidates()) out.push(c);
      } catch {
        // 单个 adapter 失败不影响其他
      }
    }
    return out;
  }
}
