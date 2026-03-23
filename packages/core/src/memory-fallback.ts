import type { MemoryService, Message } from './types.js';

/**
 * 内存 fallback 记忆服务 —— 核心内置
 *
 * 当没有任何记忆插件提供 memory 服务时，
 * App 会自动注册这个 fallback。
 * 数据仅存在于内存中，重启后丢失。
 */
export class InMemoryFallbackService implements MemoryService {
  private sessions = new Map<string, Message[]>();

  async saveMessage(sessionId: string, message: Message): Promise<void> {
    let history = this.sessions.get(sessionId);
    if (!history) {
      history = [];
      this.sessions.set(sessionId, history);
    }
    history.push({
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name,
      timestamp: message.timestamp ?? Date.now(),
    });
  }

  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    const history = this.sessions.get(sessionId);
    if (!history) return [];
    return history.slice(-limit);
  }

  async clearSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
