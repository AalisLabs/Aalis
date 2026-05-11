// ----- 平台适配器接口 -----

/** 单个平台连接的状态 */
export interface PlatformConnection {
  /** 连接唯一标识 */
  id: string;
  /** 平台名称 (如 'cli', 'webui', 'onebot') */
  platform: string;
  /** 机器人自身 ID（仅协议平台使用） */
  selfId?: string;
  /** 机器人自身昵称/显示名（仅协议平台使用） */
  selfNickname?: string;
  /** 连接状态 */
  status: 'online' | 'offline' | 'connecting';
  /** 额外信息 (如 OneBot 的实现名称、版本等) */
  detail?: Record<string, unknown>;
}

/** 平台自身身份（机器人/账号），用于 prompt 注入和历史消息归档 */
export interface PlatformSelfIdentity {
  /** 平台名称 (如 'onebot', 'cli', 'webui') */
  platform: string;
  /** 平台账号 ID（协议平台通常可用） */
  selfId?: string;
  /** 平台账号昵称/显示名 */
  nickname?: string;
}

/**
 * 平台适配器 —— 每个平台插件实现此接口
 *
 * 提供统一的平台抽象，使核心可以查询所有已接入平台的连接状态，
 * 也使其他插件可以向指定平台发送消息。
 *
 * 第三方平台接入只需实现此接口并通过 `ctx.provide('platform', adapter)` 注册即可。
 */
export interface PlatformAdapter {
  /** 适配器显示名称 */
  adapterName: string;
  /** 平台标识 (如 'cli', 'webui', 'onebot', 'telegram', 'discord') */
  platform: string;
  /**
   * 平台可能发出的 IncomingMessage.sessionType 枚举。
   *
   * 消费者（如 plugin-flow-control / plugin-trigger-policy）可以从中汇总出
   * 真实可选作用域，避免在 UI 上臆造不存在的选项。
   *
   * 未声明表示适配器不区分 sessionType（如 cli / webui 都是单会话）。
   */
  sessionTypes?: readonly string[];
  /** 获取当前所有连接 */
  getConnections(): PlatformConnection[];
  /** 向指定 sessionId 发送纯文本消息 */
  sendMessage(sessionId: string, content: string, options?: { skipSplit?: boolean }): Promise<void>;
  /**
   * 判断该 adapter 是否能处理给定 sessionId（**路由用**）。
   *
   * - PlatformRouter 按 sessionId 路由时枚举所有 adapter 调此方法定位归属
   * - 未实现时 router 默认 fallback 为 `sessionId.startsWith(this.platform + ':')`
   *   —— 适合 sessionId 形如 `<platform>:<...>` 的协议平台（如 onebot）
   * - sessionId 不携带 platform 前缀的 adapter（如 cli 的自定义 sessionId）
   *   **必须**显式实现此方法
   *
   * 与 LLMService.supportsModel 的设计意图对称：每个 provider 自报"我接不接这个 key"，
   * router 不假设 key 的格式约定。
   */
  canHandle?(sessionId: string): boolean | Promise<boolean>;
  /** 获取当前平台账号自身身份；多连接平台可用 sessionId 定位具体连接 */
  getSelfIdentity?(sessionId?: string): PlatformSelfIdentity | undefined;
  /**
   * 适配器是否至少有一个可用连接
   * 默认实现：检查 getConnections() 中是否有 status === 'online'
   */
  isReady?(): boolean;
  /**
   * 调用平台原生 API（可选，由具体适配器实现）
   *
   * 例如 OneBot 适配器通过此接口调用 set_group_ban 等 Action。
   * @param sessionId 用于定位连接的 sessionId
   * @param action    API 名称
   * @param params    API 参数
   */
  callAction?(sessionId: string, action: string, params: Record<string, unknown>): Promise<unknown>;
}

// ----- 平台聚合服务接口（同名 facade） -----

import type { PluginGroupInfo } from '@aalis/core';

/**
 * 平台聚合服务 —— 同名 facade，对外暴露为 `'platform'`
 *
 * 与 storage-router / llm-router 同模式：以 `capability:['router']`
 * 注册到 `'platform'` 服务名下，consumer 通过 `ctx.getService('platform')`
 * 拿到聚合层；如需访问具体某个 adapter，可用
 * `ctx.getService<PlatformAdapter>('platform', ['<platform-name>'])`。
 *
 * 默认由 plugin-platform 提供。
 */
export interface PlatformService {
  /** 获取平台子系统的插件分组（基于 provides ∩ inject 自动计算） */
  getPluginGroups(): PluginGroupInfo[];
  /** 获取所有平台的聚合连接列表 */
  getConnections(): PlatformConnection[];
  /** 获取所有已注册的平台名称 */
  getPlatformNames(): string[];
  /** 获取所有合规的平台适配器实例（不含 router 自身） */
  getAdapters(): PlatformAdapter[];
  /** 获取所有平台适配器及其连接详情 */
  getDetails(): Array<{
    adapterName: string;
    platform: string;
    contextId: string;
    capabilities: string[];
    connections: PlatformConnection[];
  }>;
  /** 获取指定平台在当前会话中的自身身份 */
  getSelfIdentity?(platform: string, sessionId?: string): PlatformSelfIdentity | undefined;
}

// ----- 平台能力声明 -----

export interface PlatformCapabilityRegistry {
  Router: 'router';
}

export type PlatformCapability = PlatformCapabilityRegistry[keyof PlatformCapabilityRegistry];

export const PlatformCapabilities = {
  Router: 'router',
} as const satisfies PlatformCapabilityRegistry;

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    platform: PlatformCapability | string;
  }
}
