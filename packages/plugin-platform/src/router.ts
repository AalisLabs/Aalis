import type { App, Context, Logger } from '@aalis/core';
import type { PluginGroupInfo } from '@aalis/plugin-agent-api';
import type { PlatformAdapter, PlatformConnection, PlatformSelfIdentity, PlatformService } from './types.js';

/** 经 ctx.getAllServices 枚举出的 platform adapter 条目 */
interface PlatformAdapterEntry {
  instance: PlatformAdapter;
  contextId: string;
  capabilities: string[];
  label?: string;
}

/**
 * 平台路由器
 *
 * 同名 facade 模式（与 plugin-llm-router / plugin-storage-router 对齐）：通过
 * `ctx.provide('platform', router, { capabilities: ['router'] })` 注册成 'platform' 服务的
 * "高优先级聚合层"。底层 adapter 仍以 `provide('platform', adapter)` 单独存在，router
 * 通过 `ctx.getAllServices('platform')` 枚举它们并按 sessionId 分发。
 *
 * 对外 API（消费者视角）：
 * - `getService<PlatformAdapter>('platform')?.sendMessage(sessionId, content)` —— router 内部按 sessionId 路由
 * - `getService<PlatformService>('platform')?.getAdapters()` —— 聚合视图（连接列表 / 平台名 / 详情等），introspection 用
 *
 * 自我排除：枚举 'platform' 服务时过滤掉 instance === this，避免无限递归。
 *
 * 路由策略：每个 adapter 通过 `canHandle(sessionId)` 自报是否接管。未实现时 fallback 为
 * `sessionId.startsWith(adapter.platform + ':')`（适配协议平台如 onebot 的 sessionId 形如
 * `onebot:<selfId>:group:<id>`）。sessionId 不带前缀的 adapter（如 cli）必须显式实现 canHandle。
 *
 * 与 LLM/Storage 的对称性：sessionId 之于 platform，等价于 model id 之于 llm / root 之于 storage。
 */
export class PlatformRouter implements PlatformService, PlatformAdapter {
  // ---- PlatformAdapter 字段（router 自身的占位身份） ----
  readonly adapterName = 'platform-router';
  readonly platform = '*';

  constructor(
    private readonly ctx: Context,
    private readonly logger: Logger,
  ) {}

  /** 仅枚举真正的 platform adapter，排除 router 自身 */
  private getProviders(): PlatformAdapterEntry[] {
    return this.ctx
      .getAllServices<PlatformAdapter>('platform')
      .filter(e => (e.instance as unknown) !== this)
      .filter(e => typeof e.instance?.getConnections === 'function');
  }

  // ---- PlatformAdapter 实现：按 sessionId 路由到具体 adapter ----

  async sendMessage(sessionId: string, content: string, options?: { skipSplit?: boolean }): Promise<void> {
    const adapter = await this.resolveBySession(sessionId);
    return adapter.sendMessage(sessionId, content, options);
  }

  async callAction(sessionId: string, action: string, params: Record<string, unknown>): Promise<unknown> {
    const adapter = await this.resolveBySession(sessionId);
    if (typeof adapter.callAction !== 'function') {
      throw new Error(`platform adapter "${adapter.adapterName}" 不支持 callAction`);
    }
    return adapter.callAction(sessionId, action, params);
  }

  /** 聚合所有 adapter 的连接 */
  getConnections(): PlatformConnection[] {
    return this.getProviders().flatMap(({ instance }) => instance.getConnections());
  }

  /** 任一 adapter ready 即视为整体 ready */
  isReady(): boolean {
    return this.getProviders().some(({ instance }) => instance.isReady?.() ?? false);
  }

  /** router 自身能处理 = 至少有一个底层 adapter 能处理 */
  async canHandle(sessionId: string): Promise<boolean> {
    return (await this.tryResolveBySession(sessionId)) !== undefined;
  }

  // ---- PlatformService 聚合视图：introspection 用 ----

  getPluginGroups(): PluginGroupInfo[] {
    const app = this.ctx.getService<App>('app');
    if (!app) return [];
    const targetServices = new Set(['platform']);
    const grouped: string[] = [];
    for (const p of app.plugins.getStatus()) {
      if (p.provides?.some(s => targetServices.has(s))) grouped.push(p.instanceId);
    }
    return [{ label: '平台接入', plugins: grouped }];
  }

  getAdapters(): PlatformAdapter[] {
    return this.getProviders().map(e => e.instance);
  }

  getPlatformNames(): string[] {
    const names = new Set<string>();
    for (const entry of this.getProviders()) {
      for (const cap of entry.capabilities) names.add(cap);
    }
    return [...names];
  }

  getDetails(): Array<{
    adapterName: string;
    platform: string;
    contextId: string;
    capabilities: string[];
    connections: PlatformConnection[];
  }> {
    return this.getProviders().map(({ instance, contextId, capabilities }) => ({
      adapterName: instance.adapterName,
      platform: instance.platform,
      contextId,
      capabilities: [...capabilities],
      connections: instance.getConnections(),
    }));
  }

  /** 按平台名查询 adapter 自身身份（PlatformService 签名，与 PlatformAdapter.getSelfIdentity 不冲突） */
  getSelfIdentity(platform: string, sessionId?: string): PlatformSelfIdentity | undefined {
    for (const { instance } of this.getProviders()) {
      if (instance.platform !== platform) continue;
      return instance.getSelfIdentity?.(sessionId);
    }
    return undefined;
  }

  // ---- 内部 ----

  /** 按 sessionId 查找接管 adapter；未命中抛错 */
  private async resolveBySession(sessionId: string): Promise<PlatformAdapter> {
    const adapter = await this.tryResolveBySession(sessionId);
    if (!adapter) {
      throw new Error(`没有 platform adapter 能处理 sessionId="${sessionId}"`);
    }
    return adapter;
  }

  private async tryResolveBySession(sessionId: string): Promise<PlatformAdapter | undefined> {
    for (const { instance, contextId } of this.getProviders()) {
      try {
        const ok =
          typeof instance.canHandle === 'function'
            ? await instance.canHandle(sessionId)
            : sessionId.startsWith(`${instance.platform}:`);
        if (ok) return instance;
      } catch (err) {
        this.logger.warn(`canHandle 抛错 [${contextId}]:`, err);
      }
    }
    return undefined;
  }
}
