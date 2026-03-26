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
  /** 删除旧消息，仅保留最近 keepRecent 条，返回被删除的条数 */
  trimHistory?(sessionId: string, keepRecent: number): Promise<number>;

  // ----- 对话轮次归档（长期存储，供向量检索引用） -----

  /** 保存一个对话轮次，返回 turnId */
  saveTurn?(turn: Omit<ConversationTurn, 'id'>): Promise<string>;
  /** 根据 turnId 批量获取轮次内容 */
  getTurns?(turnIds: string[]): Promise<ConversationTurn[]>;
  /** 删除指定会话的所有轮次归档 */
  deleteTurns?(sessionId: string): Promise<number>;
}
