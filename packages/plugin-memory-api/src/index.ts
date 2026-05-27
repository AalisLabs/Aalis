// ----- 记忆服务接口 -----
import type { Message } from '@aalis/plugin-message-api';

/** 跨会话最近消息查询参数 */
export interface RecentMessagesAcrossSessionsQuery {
  /** 最大返回条数（按 timestamp DESC 取最近 N 条；最终返回时升序） */
  limit: number;
  /** 仅返回 timestamp >= sinceTs 的消息（毫秒）；省略则不限 */
  sinceTs?: number;
  /** 按 `metadata.platform` 过滤；省略则不限平台 */
  platform?: string;
  /** 排除这些 sessionId（通常排除当前会话避免与会话内 history 重复） */
  excludeSessionIds?: string[];
  /** 角色过滤；省略时默认为 ['user', 'assistant']（system / tool 不会出现在跨会话注入里） */
  roles?: Array<Message['role']>;
  /**
   * Kind 白名单：仅返回 `message.kind ∈ kinds` 的条目；省略=不限。
   * 与 `roles` 配合用作"role + kind"双维度细筛（例如 `roles:['notice'], kinds:['cross-session-delegation']`）。
   */
  kinds?: string[];
  /**
   * Kind 黑名单：排除 `message.kind ∈ excludeKinds` 的条目（即使在 `kinds` 白名单内也排除）。
   * 典型用法：`excludeKinds: ['event-marker', 'cross-session-delegation']` 屏蔽控制类与委派类。
   */
  excludeKinds?: string[];
}

/** 跨会话查询结果条目 */
export interface RecentMessageRecord {
  sessionId: string;
  message: Message;
}

export interface MemoryService {
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
  /** 清空所有会话的所有消息和归档 */
  clearAll?(): Promise<void>;
  /** 归档旧消息，仅保留最近 keepRecent 条为活跃状态，返回被归档的条数 */
  trimHistory?(sessionId: string, keepRecent: number): Promise<number>;
  /** 获取完整历史（含已归档消息），用于 UI 展示 */
  getFullHistory?(sessionId: string, limit?: number): Promise<Message[]>;

  // ----- 范围查询（供向量检索的上下文窗口扩展使用） -----

  /**
   * 范围查询：取指定会话内 [fromTs, toTs] 区间的消息（按时间升序）。
   * - `roles`：role 白名单，省略=不限。
   * - `excludeKinds`：kind 黑名单（典型："event-marker" 等控制类标记），省略=不排除。
   */
  getMessagesBySessionRange?(
    sessionId: string,
    fromTs: number,
    toTs: number,
    roles?: Array<Message['role']>,
    excludeKinds?: string[],
  ): Promise<Message[]>;

  /**
   * 跨会话取最近 N 条消息（按 timestamp 升序返回），供"跨会话历史注入"等场景使用。
   *
   * 实现需保证：
   * - 仅返回未归档（archived=false）消息
   * - 按 `timestamp DESC` 取最近 `limit` 条后再升序输出
   * - 按 `query.platform` / `query.excludeSessionIds` / `query.roles` / `query.sinceTs` 过滤
   * - 返回结果中每条带 `sessionId`，调用方可据此区分来源
   */
  getRecentMessagesAcrossSessions?(query: RecentMessagesAcrossSessionsQuery): Promise<RecentMessageRecord[]>;

  // ----- 结构化元数据存储（供会话管理等场景使用） -----

  /** 保存结构化元数据（namespace 隔离，key 唯一） */
  saveMetadata?(namespace: string, key: string, data: Record<string, unknown>): Promise<void>;
  /** 读取元数据 */
  getMetadata?(namespace: string, key: string): Promise<Record<string, unknown> | undefined>;
  /** 列出指定 namespace 下所有元数据条目 */
  listMetadata?(namespace: string): Promise<Array<{ key: string; data: Record<string, unknown> }>>;
  /** 删除元数据条目 */
  deleteMetadata?(namespace: string, key: string): Promise<void>;

  /** 在指定会话的最近 N 条消息中，将 content 里的 oldText 替换为 newText，返回受影响的条数 */
  updateMessageContent?(sessionId: string, oldText: string, newText: string, recentLimit?: number): Promise<number>;

  /** 按时间戳批量删除指定会话的消息（用于回滚整轮对话），返回实际删除条数 */
  deleteMessagesByTimestamps?(sessionId: string, timestamps: number[]): Promise<number>;
}

// ----- 记忆能力声明（capability 框架）-----

/**
 * 记忆服务能力注册表
 *
 * 第三方可扩展：
 * ```ts
 * declare module '@aalis/core' {
 *   interface MemoryCapabilityRegistry { Persistent: 'persistent'; Encrypted: 'encrypted'; }
 * }
 * ```
 */
export interface MemoryCapabilityRegistry {
  /** 基础的消息历史保存/读取 */
  History: 'history';
  /** 支持结构化元数据存储（saveMetadata 等） */
  Metadata: 'metadata';
  /** 支持消息内容更新（updateMessageContent） */
  ContentUpdate: 'content-update';
  /** 支持按时间戳批量删除消息（deleteMessagesByTimestamps） */
  MessageDelete: 'message-delete';
  /** 支持跨会话最近消息查询（getRecentMessagesAcrossSessions） */
  RecentAcrossSessions: 'recent-across-sessions';
}

export type MemoryCapability = MemoryCapabilityRegistry[keyof MemoryCapabilityRegistry];

export const MemoryCapabilities = {
  History: 'history',
  Metadata: 'metadata',
  ContentUpdate: 'content-update',
  MessageDelete: 'message-delete',
  RecentAcrossSessions: 'recent-across-sessions',
} as const satisfies MemoryCapabilityRegistry;

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    memory: MemoryCapability;
  }
  interface HookContextMap {
    /** 记忆清除钩子（统一编排） */
    'memory:clear': {
      /** 清除范围: session=当前会话, all=全局 */
      scope: 'session' | 'all';
      /** 指定清除的子系统（为空则全部清除） */
      types?: string[];
      /** 当前会话 ID（scope=session 时必填） */
      sessionId?: string;
      /** 各子系统报告的结果（由中间件填充） */
      results: Array<{ source: string; success: boolean; message: string }>;
      /** 回滚函数列表（清除失败时依次执行） */
      rollbacks: Array<{ source: string; fn: () => Promise<void> }>;
    };
  }
}

import { registerCapabilityProbe } from '@aalis/core';

registerCapabilityProbe('memory', MemoryCapabilities.History, inst =>
  typeof (inst as { getHistory?: unknown }).getHistory === 'function' &&
  typeof (inst as { saveMessage?: unknown }).saveMessage === 'function'
    ? true
    : 'MemoryService.saveMessage()/getHistory() are required for capability "history"',
);

registerCapabilityProbe('memory', MemoryCapabilities.Metadata, inst =>
  typeof (inst as { saveMetadata?: unknown }).saveMetadata === 'function'
    ? true
    : 'MemoryService.saveMetadata() is required for capability "metadata"',
);

registerCapabilityProbe('memory', MemoryCapabilities.ContentUpdate, inst =>
  typeof (inst as { updateMessageContent?: unknown }).updateMessageContent === 'function'
    ? true
    : 'MemoryService.updateMessageContent() is required for capability "content-update"',
);

registerCapabilityProbe('memory', MemoryCapabilities.MessageDelete, inst =>
  typeof (inst as { deleteMessagesByTimestamps?: unknown }).deleteMessagesByTimestamps === 'function'
    ? true
    : 'MemoryService.deleteMessagesByTimestamps() is required for capability "message-delete"',
);

registerCapabilityProbe('memory', MemoryCapabilities.RecentAcrossSessions, inst =>
  typeof (inst as { getRecentMessagesAcrossSessions?: unknown }).getRecentMessagesAcrossSessions === 'function'
    ? true
    : 'MemoryService.getRecentMessagesAcrossSessions() is required for capability "recent-across-sessions"',
);

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    memory: MemoryService;
  }
}
