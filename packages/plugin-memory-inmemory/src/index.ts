import type { Context, MemoryService, Message } from '@aalis/core';

// ===== InMemoryFallbackService 实现 =====

class InMemoryFallbackService implements MemoryService {
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
      reasoningContent: message.reasoningContent,
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

  async trimHistory(sessionId: string, keepRecent: number): Promise<number> {
    const history = this.sessions.get(sessionId);
    if (!history || history.length <= keepRecent) return 0;
    const removed = history.length - keepRecent;
    this.sessions.set(sessionId, history.slice(-keepRecent));
    return removed;
  }
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-inmemory';
export const provides = ['memory'];

// ===== 插件入口 =====

export function apply(ctx: Context, _config: Record<string, unknown>): void {
  const service = new InMemoryFallbackService();
  ctx.provide('memory', service, {
    capabilities: ['history'],
    priority: -100,
  });
  ctx.logger.info('内存记忆服务已启用 (数据不会持久化)');
}
