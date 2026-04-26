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
 * 跨会话决策候选 —— 平台向 advisor / 调度器暴露当前所有可用会话的快照。
 *
 * 仅描述会话级元数据（活跃度/限速/禁言等），不携带消息内容。
 * 内容获取由调用方按需通过 memory / 摘要服务自行查询。
 */
export interface PlatformSessionCandidate {
  /** 平台会话 ID（含平台前缀） */
  sessionId: string;
  /** 平台名（与 sessionId 前缀一致） */
  platform: string;
  /** 会话类型（'group' / 'private' / 'channel' 或平台自定义） */
  sessionType: string;
  /** 该会话最近一条消息的时间戳（含用户消息与 bot 自身消息） */
  lastActivityAt?: number;
  /** 该会话上 bot 最近一次发送消息的时间戳 */
  lastBotSentAt?: number;
  /** 当前是否处于禁言状态（无法发送） */
  isMuted?: boolean;
  /** 当前是否处于 cooldown（短期不应再发） */
  isOnCooldown?: boolean;
  /** 限速窗口内剩余可发条数；undefined 表示未启用限速 */
  replyBudgetRemaining?: number;
  /** 简短描述（如群名 / 对端昵称），用于 LLM 决策时识别 */
  hint?: string;
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
  sendMessage(sessionId: string, content: string, options?: { skipSplit?: boolean }): Promise<void>;
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
  /**
   * 列出当前活跃的会话候选（仅元数据，不含消息内容）。
   *
   * 供 plugin-advisor 等跨会话决策插件使用：在判断「现在是否应该向某个
   * 群/私聊主动说话」时，先拿到所有候选会话快照，再按 advisor 自己的策略
   * 召回内容、做 LLM 决策。
   */
  listSessionCandidates?(): PlatformSessionCandidate[];
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
  /** 获取指定平台在当前会话中的自身身份 */
  getSelfIdentity?(platform: string, sessionId?: string): PlatformSelfIdentity | undefined;
  /** 列出（指定平台或所有平台的）会话候选，供 advisor 等跨会话决策使用 */
  listSessionCandidates?(platform?: string): PlatformSessionCandidate[];
}
