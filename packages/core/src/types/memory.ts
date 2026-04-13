// ----- 记忆服务接口 -----

import type { Message } from './core.js';

/** 对话轮次归档条目（长期存储） */
export interface ConversationTurn {
  /** 唯一标识 */
  id: string;
  sessionId: string;
  userId?: string;
  platform?: string;
  userContent: string;
  assistantContent: string;
  timestamp: number;
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

  // ----- 对话轮次归档（长期存储，供向量检索引用） -----

  /** 保存一个对话轮次，返回 turnId */
  saveTurn?(turn: Omit<ConversationTurn, 'id'>): Promise<string>;
  /** 根据 turnId 批量获取轮次内容 */
  getTurns?(turnIds: string[]): Promise<ConversationTurn[]>;
  /** 删除指定会话的所有轮次归档 */
  deleteTurns?(sessionId: string): Promise<number>;

  // ----- 结构化元数据存储（供会话管理等场景使用） -----

  /** 保存结构化元数据（namespace 隔离，key 唯一） */
  saveMetadata?(namespace: string, key: string, data: Record<string, unknown>): Promise<void>;
  /** 读取元数据 */
  getMetadata?(namespace: string, key: string): Promise<Record<string, unknown> | undefined>;
  /** 列出指定 namespace 下所有元数据条目 */
  listMetadata?(namespace: string): Promise<Array<{ key: string; data: Record<string, unknown> }>>;
  /** 删除元数据条目 */
  deleteMetadata?(namespace: string, key: string): Promise<void>;

  // ----- 消息内容更新（图片描述回写等） -----

  /** 在指定会话的最近 N 条消息中，将 content 里的 oldText 替换为 newText，返回受影响的条数 */
  updateMessageContent?(sessionId: string, oldText: string, newText: string, recentLimit?: number): Promise<number>;
}
