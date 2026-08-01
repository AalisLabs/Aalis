import type {
  MemoryService,
  MetadataEntry,
  MetadataOp,
  RecentMessageRecord,
  RecentMessagesAcrossSessionsQuery,
} from '@aalis/api-memory';
import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import type { Message } from '@aalis/schema-message';

// ===== InMemoryFallbackService 实现 =====

class InMemoryFallbackService implements MemoryService {
  private sessions = new Map<string, Message[]>();
  private archivedSessions = new Map<string, Message[]>();
  /** namespace → key → { data, updatedAt }。带上写入时间，与另两家后端的返回结构对齐。 */
  private metadata = new Map<string, Map<string, { data: Record<string, unknown>; updatedAt: number }>>();
  private readonly rangeQueryLimit: number;
  private readonly crossSessionMaxLimit: number;

  constructor(opts: { rangeQueryLimit?: number; crossSessionMaxLimit?: number } = {}) {
    this.rangeQueryLimit = Math.max(1, opts.rangeQueryLimit ?? 500);
    this.crossSessionMaxLimit = Math.max(1, opts.crossSessionMaxLimit ?? 1000);
  }

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
      kind: message.kind,
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
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
      .slice(0, this.rangeQueryLimit);
  }

  async getRecentMessagesAcrossSessions(query: RecentMessagesAcrossSessionsQuery): Promise<RecentMessageRecord[]> {
    const limit = Math.max(1, Math.min(query.limit, this.crossSessionMaxLimit));
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

  /**
   * 同步写入的内部实现。`commitMetadata` 直接调它 —— 中间不能有 `await`，否则每条 op 后面
   * 都是一个微任务让出点，并发的 listMetadata 就能读到批的中间态（实测过：5 条 put 的批，
   * 并发读采到 1 条），而另两家后端在同样的用例下不撕裂。
   */
  private putSync(namespace: string, key: string, data: Record<string, unknown>): void {
    let ns = this.metadata.get(namespace);
    if (!ns) {
      ns = new Map();
      this.metadata.set(namespace, ns);
    }
    // 存**深拷贝**而非引用。sqlite/mongodb 都经序列化，天然是拷贝；inmemory 若直接存引用，
    // 调用方事后改原对象就会静默改到「已落盘」的内容 —— 那会让刷盘类缺陷在本后端上原理性
    // 地测不出来（session-manager 传的正是 this.sessions 里的活对象）。
    // 顺带把「data 必须可 JSON 序列化」这条约束也逼平：不可序列化的值在这里就抛，与另两家一致。
    ns.set(key, { data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>, updatedAt: Date.now() });
  }

  private deleteSync(namespace: string, key: string): void {
    const ns = this.metadata.get(namespace);
    if (!ns) return;
    ns.delete(key);
    if (ns.size === 0) this.metadata.delete(namespace);
  }

  async saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void> {
    this.putSync(namespace, key, data);
  }

  async getMetadata(namespace: string, key: string): Promise<Record<string, unknown> | undefined> {
    const d = this.metadata.get(namespace)?.get(key)?.data;
    // 同样返回拷贝：调用方改读回来的对象不该污染存储（另两家经序列化，本就如此）。
    return d === undefined ? undefined : (JSON.parse(JSON.stringify(d)) as Record<string, unknown>);
  }

  async listMetadata(namespace: string): Promise<MetadataEntry[]> {
    const ns = this.metadata.get(namespace);
    if (!ns) return [];
    // 按 key 升序：另两家都走 (namespace,key) 索引扫、天然有序，本家的 Map 是插入序。
    // 契约不承诺顺序，但三家不一致会让「在 inmemory 上写的测试到 sqlite 上换个顺序」这类
    // 问题只在生产暴露。
    return [...ns.entries()]
      .map(([key, e]) => ({
        key,
        data: JSON.parse(JSON.stringify(e.data)) as Record<string, unknown>,
        updatedAt: e.updatedAt,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async commitMetadata(ops: readonly MetadataOp[]): Promise<void> {
    // 先把全部 op 序列化一遍再落，任一条不可序列化就整批不生效 —— 与 sqlite（事务内
    // JSON.stringify 抛错则回滚）、mongodb（BSON 序列化抛错则一条不执行）语义一致。
    const puts = ops.map(o => (o.op === 'put' ? JSON.parse(JSON.stringify(o.data)) : undefined));
    // 循环体内无 await：这一段跑完之前没有别的代码能观察到中间态，故整批原子。
    ops.forEach((o, i) => {
      if (o.op === 'put') this.putSync(o.namespace, o.key, puts[i] as Record<string, unknown>);
      else this.deleteSync(o.namespace, o.key);
    });
  }

  async deleteMetadata(namespace: string, key: string): Promise<void> {
    this.deleteSync(namespace, key);
  }

  async updateMessageContent(sessionId: string, oldText: string, newText: string, recentLimit = 100): Promise<number> {
    const history = this.sessions.get(sessionId);
    if (!history) return 0;
    let count = 0;
    const start = Math.max(0, history.length - recentLimit);
    for (let i = start; i < history.length; i++) {
      if (history[i].content && history[i].content!.includes(oldText)) {
        history[i] = { ...history[i], content: history[i].content!.replaceAll(oldText, newText) };
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

export const configSchema: ConfigSchema = {
  rangeQueryLimit: {
    type: 'number',
    label: '范围查询返回上限',
    default: 500,
    description: '区间消息查询单次返回的最大条数。命中上限会静默截断（与 sqlite/mongodb 后端对齐）',
  },
  crossSessionMaxLimit: {
    type: 'number',
    label: '跨会话查询返回上限',
    default: 1000,
    description: '跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限',
  },
};

export const defaultConfig = {
  rangeQueryLimit: 500,
  crossSessionMaxLimit: 1000,
};

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const service = new InMemoryFallbackService({
    rangeQueryLimit: config.rangeQueryLimit as number | undefined,
    crossSessionMaxLimit: config.crossSessionMaxLimit as number | undefined,
  });
  ctx.provide('memory', service, {
    priority: -100,
  });
  ctx.logger.info('内存记忆服务已启用 (数据不会持久化)');
}
