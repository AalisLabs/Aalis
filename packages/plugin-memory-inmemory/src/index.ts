import type { Context } from '@aalis/core';
import type { MemoryService, RecentMessageRecord, RecentMessagesAcrossSessionsQuery } from '@aalis/plugin-memory-api';
import { MemoryCapabilities } from '@aalis/plugin-memory-api';
import type { Message } from '@aalis/plugin-message-api';

// ===== InMemoryFallbackService 实现 =====

class InMemoryFallbackService implements MemoryService {
  private sessions = new Map<string, Message[]>();
  private archivedSessions = new Map<string, Message[]>();
  private metadata = new Map<string, Map<string, Record<string, unknown>>>();

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
      metadata: message.metadata,
      segments: message.segments,
    });
  }

  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    const history = this.sessions.get(sessionId);
    if (!history) return [];
    return history.slice(-limit);
  }

  async clearSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.archivedSessions.delete(sessionId);
  }

  async clearAll(): Promise<void> {
    this.sessions.clear();
    this.archivedSessions.clear();
    this.metadata.clear();
  }

  async trimHistory(sessionId: string, keepRecent: number): Promise<number> {
    const history = this.sessions.get(sessionId);
    if (!history || history.length <= keepRecent) return 0;
    const removed = history.length - keepRecent;
    const archived = history.slice(0, -keepRecent);
    const existing = this.archivedSessions.get(sessionId) ?? [];
    this.archivedSessions.set(sessionId, [...existing, ...archived]);
    this.sessions.set(sessionId, history.slice(-keepRecent));
    return removed;
  }

  async getFullHistory(sessionId: string, limit = 200): Promise<Message[]> {
    const archived = this.archivedSessions.get(sessionId) ?? [];
    const active = this.sessions.get(sessionId) ?? [];
    const all = [...archived, ...active];
    return all.slice(-limit);
  }

  async getMessagesBySessionRange(
    sessionId: string,
    fromTs: number,
    toTs: number,
    roles?: Array<Message['role']>,
    excludeKinds?: string[],
  ): Promise<Message[]> {
    const archived = this.archivedSessions.get(sessionId) ?? [];
    const active = this.sessions.get(sessionId) ?? [];
    const all = [...archived, ...active];
    const excludeKindSet = excludeKinds && excludeKinds.length > 0 ? new Set(excludeKinds) : null;
    return all
      .filter(m => {
        const ts = m.timestamp ?? 0;
        if (ts < fromTs || ts > toTs) return false;
        if (roles && roles.length > 0 && !roles.includes(m.role)) return false;
        if (excludeKindSet && m.kind && excludeKindSet.has(m.kind)) return false;
        return true;
      })
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  async getRecentMessagesAcrossSessions(query: RecentMessagesAcrossSessionsQuery): Promise<RecentMessageRecord[]> {
    const limit = Math.max(1, Math.min(query.limit, 1000));
    const roles = query.roles && query.roles.length > 0 ? query.roles : (['user', 'assistant'] as Message['role'][]);
    const roleSet = new Set(roles);
    const excludeSet =
      query.excludeSessionIds && query.excludeSessionIds.length > 0 ? new Set(query.excludeSessionIds) : null;
    const kindSet = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null;
    const excludeKindSet = query.excludeKinds && query.excludeKinds.length > 0 ? new Set(query.excludeKinds) : null;

    const all: RecentMessageRecord[] = [];
    for (const [sessionId, msgs] of this.sessions) {
      if (excludeSet?.has(sessionId)) continue;
      for (const m of msgs) {
        if (!roleSet.has(m.role)) continue;
        if (kindSet && (!m.kind || !kindSet.has(m.kind))) continue;
        if (excludeKindSet && m.kind && excludeKindSet.has(m.kind)) continue;
        const ts = m.timestamp ?? 0;
        if (typeof query.sinceTs === 'number' && ts < query.sinceTs) continue;
        if (typeof query.platform === 'string') {
          const p = (m.metadata as { platform?: unknown } | undefined)?.platform;
          if (p !== query.platform) continue;
        }
        all.push({ sessionId, message: m });
      }
    }
    all.sort((a, b) => (b.message.timestamp ?? 0) - (a.message.timestamp ?? 0));
    return all.slice(0, limit).reverse();
  }

  // ----- 结构化元数据存储 -----

  async saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void> {
    let ns = this.metadata.get(namespace);
    if (!ns) {
      ns = new Map();
      this.metadata.set(namespace, ns);
    }
    ns.set(key, data);
  }

  async getMetadata(namespace: string, key: string): Promise<Record<string, unknown> | undefined> {
    return this.metadata.get(namespace)?.get(key);
  }

  async listMetadata(namespace: string): Promise<Array<{ key: string; data: Record<string, unknown> }>> {
    const ns = this.metadata.get(namespace);
    if (!ns) return [];
    return [...ns.entries()].map(([key, data]) => ({ key, data }));
  }

  async deleteMetadata(namespace: string, key: string): Promise<void> {
    const ns = this.metadata.get(namespace);
    if (ns) {
      ns.delete(key);
      if (ns.size === 0) this.metadata.delete(namespace);
    }
  }

  async updateMessageContent(sessionId: string, oldText: string, newText: string, recentLimit = 100): Promise<number> {
    const history = this.sessions.get(sessionId);
    if (!history) return 0;
    let count = 0;
    const start = Math.max(0, history.length - recentLimit);
    for (let i = start; i < history.length; i++) {
      if (history[i].content && history[i].content!.includes(oldText)) {
        history[i] = { ...history[i], content: history[i].content!.replace(oldText, newText) };
        count++;
      }
    }
    return count;
  }

  async deleteMessagesByTimestamps(sessionId: string, timestamps: number[]): Promise<number> {
    if (timestamps.length === 0) return 0;
    const tsSet = new Set(timestamps);
    let removed = 0;
    const active = this.sessions.get(sessionId);
    if (active) {
      const kept = active.filter(m => {
        if (m.timestamp !== undefined && tsSet.has(m.timestamp)) {
          removed++;
          return false;
        }
        return true;
      });
      if (kept.length > 0) this.sessions.set(sessionId, kept);
      else this.sessions.delete(sessionId);
    }
    const archived = this.archivedSessions.get(sessionId);
    if (archived) {
      const kept = archived.filter(m => {
        if (m.timestamp !== undefined && tsSet.has(m.timestamp)) {
          removed++;
          return false;
        }
        return true;
      });
      if (kept.length > 0) this.archivedSessions.set(sessionId, kept);
      else this.archivedSessions.delete(sessionId);
    }
    return removed;
  }
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-inmemory';
export const displayName = '内存记忆';
export const subsystem = 'memory';
export const provides = ['memory'];

// ===== 插件入口 =====

export function apply(ctx: Context, _config: Record<string, unknown>): void {
  const service = new InMemoryFallbackService();
  ctx.provide('memory', service, {
    capabilities: [
      MemoryCapabilities.History,
      MemoryCapabilities.Metadata,
      MemoryCapabilities.ContentUpdate,
      MemoryCapabilities.MessageDelete,
      MemoryCapabilities.RecentAcrossSessions,
    ],
    priority: -100,
  });
  ctx.logger.info('内存记忆服务已启用 (数据不会持久化)');
}
