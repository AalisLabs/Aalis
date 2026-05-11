// ----- 记忆服务接口 -----

import type { Message } from '@aalis/core';

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

  /** 范围查询：取指定会话内 [fromTs, toTs] 区间的消息（按时间升序，可按 role 过滤） */
  getMessagesBySessionRange?(sessionId: string, fromTs: number, toTs: number, roles?: Array<Message['role']>): Promise<Message[]>;

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
}

export type MemoryCapability = MemoryCapabilityRegistry[keyof MemoryCapabilityRegistry];

export const MemoryCapabilities = {
  History: 'history',
  Metadata: 'metadata',
  ContentUpdate: 'content-update',
  MessageDelete: 'message-delete',
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
  typeof (inst as { getHistory?: unknown }).getHistory === 'function'
    && typeof (inst as { saveMessage?: unknown }).saveMessage === 'function'
    ? true
    : 'MemoryService.saveMessage()/getHistory() are required for capability "history"');

registerCapabilityProbe('memory', MemoryCapabilities.Metadata, inst =>
  typeof (inst as { saveMetadata?: unknown }).saveMetadata === 'function'
    ? true
    : 'MemoryService.saveMetadata() is required for capability "metadata"');

registerCapabilityProbe('memory', MemoryCapabilities.ContentUpdate, inst =>
  typeof (inst as { updateMessageContent?: unknown }).updateMessageContent === 'function'
    ? true
    : 'MemoryService.updateMessageContent() is required for capability "content-update"');

registerCapabilityProbe('memory', MemoryCapabilities.MessageDelete, inst =>
  typeof (inst as { deleteMessagesByTimestamps?: unknown }).deleteMessagesByTimestamps === 'function'
    ? true
    : 'MemoryService.deleteMessagesByTimestamps() is required for capability "message-delete"');
