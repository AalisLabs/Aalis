// ----- 平台适配器接口 -----

/** 单个平台连接的状态 */
export interface PlatformConnection {
  /** 连接唯一标识 */
  id: string;
  /** 平台名称 (如 'cli', 'webui', 'onebot') */
  platform: string;
  /** 机器人自身 ID（仅协议平台使用） */
  selfId?: string;
  /** 连接状态 */
  status: 'online' | 'offline' | 'connecting';
  /** 额外信息 (如 OneBot 的实现名称、版本等) */
  detail?: Record<string, unknown>;
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
  /** 获取当前所有连接 */
  getConnections(): PlatformConnection[];
  /** 向指定 sessionId 发送纯文本消息 */
  sendMessage(sessionId: string, content: string): Promise<void>;
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

// ----- 平台管理服务接口 -----

import type { PluginGroupInfo } from './core.js';

/**
 * 平台管理服务 —— 平台子系统协调器
 *
 * 聚合所有平台适配器的连接状态，
 * 为 Dashboard 提供插件分组信息。
 *
 * 默认由 plugin-platform 提供。
 */
export interface PlatformManagerService {
  /** 获取平台子系统的插件分组（基于 provides ∩ inject 自动计算） */
  getPluginGroups(): PluginGroupInfo[];
  /** 获取所有平台的聚合连接列表 */
  getConnections(): PlatformConnection[];
  /** 获取所有已注册的平台名称 */
  getPlatformNames(): string[];
}
