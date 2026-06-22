import type { ConfigSchema, Context } from '@aalis/core';
import type { MemoryService, RecentMessageRecord, RecentMessagesAcrossSessionsQuery } from '@aalis/plugin-memory-api';
import type { ContentSegment, Message } from '@aalis/plugin-message-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import Database from 'better-sqlite3';

function toUri(input: string): string {
  const s = String(input ?? '').trim();
  if (!s) return 'data:/aalis.db';
  if (s.includes(':/')) return s;
  const cleaned = s.replace(/^\.?\/+/, '');
  const idx = cleaned.indexOf('/');
  return idx > 0 ? `${cleaned.slice(0, idx)}:/${cleaned.slice(idx + 1)}` : `data:/${cleaned}`;
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-sqlite';
export const displayName = 'SQLite 记忆';
export const subsystem = 'memory';
export const provides = ['memory'];
export const reusable = true;
export const inject = {
  required: ['storage'],
};

export const configSchema: ConfigSchema = {
  path: {
    type: 'string',
    label: '数据库路径',
    default: 'data/aalis.db',
    description: 'SQLite 数据库文件路径，相对于项目根目录',
  },
  rangeQueryLimit: {
    type: 'number',
    label: '范围查询返回上限',
    default: 500,
    description: '区间消息查询（向量召回的上下文窗口扩展等）单次返回的最大条数。命中上限会静默截断',
  },
  crossSessionMaxLimit: {
    type: 'number',
    label: '跨会话查询返回上限',
    default: 1000,
    description: '跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限',
  },
};

export const defaultConfig = {
  path: 'data/aalis.db',
  rangeQueryLimit: 500,
  crossSessionMaxLimit: 1000,
};

// ===== 配置 =====

interface SQLiteMemoryConfig {
  /** 数据库文件路径（相对于配置目录或绝对路径） */
  path: string;
  /** 区间消息查询返回上限（默认 500） */
  rangeQueryLimit?: number;
  /** 跨会话查询返回上限（默认 1000） */
  crossSessionMaxLimit?: number;
}

// ===== SQLite MemoryService 实现 =====

class SQLiteMemoryService implements MemoryService {
  private db: Database.Database;
  private readonly rangeQueryLimit: number;
  private readonly crossSessionMaxLimit: number;

  constructor(db: Database.Database, opts: { rangeQueryLimit?: number; crossSessionMaxLimit?: number } = {}) {
    this.db = db;
    this.rangeQueryLimit = Math.max(1, opts.rangeQueryLimit ?? 500);
    this.crossSessionMaxLimit = Math.max(1, opts.crossSessionMaxLimit ?? 1000);

    // 创建表（如果不存在）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT,
        content TEXT,
        toolCalls TEXT,
        toolCallId TEXT,
        name TEXT,
        timestamp INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(sessionId, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_recent
        ON messages(archived, timestamp);

      CREATE TABLE IF NOT EXISTS metadata (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        data TEXT NOT NULL,
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (namespace, key)
      );
    `);

    // 迁移：为旧数据库添加 archived 列
    const columns = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
    if (!columns.some(c => c.name === 'archived')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    }
    // 迁移：为旧数据库添加 reasoningContent 列
    if (!columns.some(c => c.name === 'reasoningContent')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reasoningContent TEXT');
    }
    // 迁移：为旧数据库添加 metadata 列
    if (!columns.some(c => c.name === 'metadata')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN metadata TEXT');
    }
    // 迁移：为旧数据库添加 segments 列（存放统一时间线 JSON）
    if (!columns.some(c => c.name === 'segments')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN segments TEXT');
    }
    // 迁移：为旧数据库添加 kind 列（Message.kind 统一子分类）
    if (!columns.some(c => c.name === 'kind')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN kind TEXT');
    }
  }

  private static parseMetadata(raw: string | null): Record<string, unknown> | undefined {
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private static parseSegments(raw: string | null): ContentSegment[] | undefined {
    if (!raw) return undefined;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? (arr as ContentSegment[]) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 统一的 row → Message 映射（包含 kind）。 */
  private static rowToMessage(row: {
    role: string;
    kind?: string | null;
    content: string | null;
    toolCalls: string | null;
    toolCallId: string | null;
    name: string | null;
    timestamp: number;
    reasoningContent: string | null;
    metadata: string | null;
    segments: string | null;
  }): Message {
    return {
      role: row.role as Message['role'],
      kind: row.kind ?? undefined,
      content: row.content,
      toolCalls: row.toolCalls ? JSON.parse(row.toolCalls) : undefined,
      toolCallId: row.toolCallId ?? undefined,
      name: row.name ?? undefined,
      timestamp: row.timestamp,
      reasoningContent: row.reasoningContent ?? undefined,
      segments: SQLiteMemoryService.parseSegments(row.segments),
      metadata: SQLiteMemoryService.parseMetadata(row.metadata),
    };
  }

  async saveMessage(sessionId: string, message: Message): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO messages (sessionId, role, kind, content, toolCalls, toolCallId, name, timestamp, reasoningContent, metadata, segments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId,
      message.role,
      message.kind ?? null,
      message.content,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolCallId ?? null,
      message.name ?? null,
      message.timestamp ?? Date.now(),
      message.reasoningContent ?? null,
      message.metadata ? JSON.stringify(message.metadata) : null,
      message.segments ? JSON.stringify(message.segments) : null,
    );
  }

  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    const stmt = this.db.prepare(`
      SELECT role, kind, content, toolCalls, toolCallId, name, timestamp, reasoningContent, metadata, segments
      FROM (
        SELECT role, kind, content, toolCalls, toolCallId, name, timestamp, reasoningContent, metadata, segments
        FROM messages
        WHERE sessionId = ? AND archived = 0
        ORDER BY timestamp DESC
        LIMIT ?
      ) sub ORDER BY timestamp ASC
    `);
    const rows = stmt.all(sessionId, limit) as Array<Parameters<typeof SQLiteMemoryService.rowToMessage>[0]>;
    return rows.map(SQLiteMemoryService.rowToMessage);
  }

  async clearSession(sessionId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM messages WHERE sessionId = ?');
    stmt.run(sessionId);
  }

  async getMessagesBySessionRange(
    sessionId: string,
    fromTs: number,
    toTs: number,
    roles?: Array<Message['role']>,
    excludeKinds?: string[],
  ): Promise<Message[]> {
    let sql = `SELECT role, kind, content, toolCalls, toolCallId, name, timestamp, reasoningContent, metadata, segments
               FROM messages
               WHERE sessionId = ? AND timestamp BETWEEN ? AND ?`;
    const params: unknown[] = [sessionId, fromTs, toTs];
    if (roles && roles.length > 0) {
      sql += ` AND role IN (${roles.map(() => '?').join(',')})`;
      params.push(...roles);
    }
    if (excludeKinds && excludeKinds.length > 0) {
      // kind 为 NULL 不被排除（与 MongoDB $nin 一致的保守语义）
      sql += ` AND (kind IS NULL OR kind NOT IN (${excludeKinds.map(() => '?').join(',')}))`;
      params.push(...excludeKinds);
    }
    sql += ' ORDER BY timestamp ASC LIMIT ?';
    params.push(this.rangeQueryLimit);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<Parameters<typeof SQLiteMemoryService.rowToMessage>[0]>;
    return rows.map(SQLiteMemoryService.rowToMessage);
  }

  async getRecentMessagesAcrossSessions(query: RecentMessagesAcrossSessionsQuery): Promise<RecentMessageRecord[]> {
    const limit = Math.max(1, Math.min(query.limit, this.crossSessionMaxLimit));
    const roles = query.roles && query.roles.length > 0 ? query.roles : (['user', 'assistant'] as Message['role'][]);
    // platform / excludeSessionIds 走内存过滤；为保证 limit 命中，先用 overscan 倍率拉取候选。
    const needsPostFilter =
      typeof query.platform === 'string' || (query.excludeSessionIds && query.excludeSessionIds.length > 0);
    const overscan = needsPostFilter ? 8 : 1;
    const candidateLimit = Math.min(limit * overscan, 5000);

    let sql = `SELECT sessionId, role, kind, content, toolCalls, toolCallId, name, timestamp, reasoningContent, metadata, segments
               FROM messages
               WHERE archived = 0
                 AND role IN (${roles.map(() => '?').join(',')})`;
    const params: unknown[] = [...roles];
    if (query.kinds && query.kinds.length > 0) {
      sql += ` AND kind IN (${query.kinds.map(() => '?').join(',')})`;
      params.push(...query.kinds);
    }
    if (query.excludeKinds && query.excludeKinds.length > 0) {
      sql += ` AND (kind IS NULL OR kind NOT IN (${query.excludeKinds.map(() => '?').join(',')}))`;
      params.push(...query.excludeKinds);
    }
    if (typeof query.sinceTs === 'number') {
      sql += ' AND timestamp >= ?';
      params.push(query.sinceTs);
    }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(candidateLimit);

    const rows = this.db.prepare(sql).all(...params) as Array<
      Parameters<typeof SQLiteMemoryService.rowToMessage>[0] & { sessionId: string }
    >;

    const excludeSet =
      query.excludeSessionIds && query.excludeSessionIds.length > 0 ? new Set(query.excludeSessionIds) : null;

    const out: RecentMessageRecord[] = [];
    for (const row of rows) {
      if (excludeSet?.has(row.sessionId)) continue;
      const message = SQLiteMemoryService.rowToMessage(row);
      if (typeof query.platform === 'string' && message.metadata?.platform !== query.platform) continue;
      out.push({
        sessionId: row.sessionId,
        message,
      });
      if (out.length >= limit) break;
    }
    // rows 为 DESC，截取后反转为升序
    return out.reverse();
  }

  async trimHistory(sessionId: string, keepRecent: number): Promise<number> {
    const stmt = this.db.prepare(`
      UPDATE messages SET archived = 1
      WHERE sessionId = ? AND archived = 0 AND id NOT IN (
        SELECT id FROM messages WHERE sessionId = ? AND archived = 0 ORDER BY timestamp DESC LIMIT ?
      )
    `);
    const result = stmt.run(sessionId, sessionId, keepRecent);
    return result.changes;
  }

  async getFullHistory(sessionId: string, limit = 200): Promise<Message[]> {
    const stmt = this.db.prepare(`
      SELECT role, kind, content, toolCalls, toolCallId, name, timestamp, reasoningContent, metadata, segments
      FROM (
        SELECT role, kind, content, toolCalls, toolCallId, name, timestamp, reasoningContent, metadata, segments
        FROM messages
        WHERE sessionId = ?
        ORDER BY timestamp DESC
        LIMIT ?
      ) sub ORDER BY timestamp ASC
    `);
    const rows = stmt.all(sessionId, limit) as Array<Parameters<typeof SQLiteMemoryService.rowToMessage>[0]>;
    return rows.map(SQLiteMemoryService.rowToMessage);
  }

  async clearAll(): Promise<void> {
    this.db.exec('DELETE FROM messages');
    this.db.exec('DELETE FROM metadata');
  }

  // ----- 结构化元数据存储 -----

  async saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO metadata (namespace, key, data, updatedAt) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(namespace, key) DO UPDATE SET data = excluded.data, updatedAt = datetime('now')
    `);
    stmt.run(namespace, key, JSON.stringify(data));
  }

  async getMetadata(namespace: string, key: string): Promise<Record<string, unknown> | undefined> {
    const stmt = this.db.prepare('SELECT data FROM metadata WHERE namespace = ? AND key = ?');
    const row = stmt.get(namespace, key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  async listMetadata(namespace: string): Promise<Array<{ key: string; data: Record<string, unknown> }>> {
    const stmt = this.db.prepare('SELECT key, data FROM metadata WHERE namespace = ?');
    const rows = stmt.all(namespace) as Array<{ key: string; data: string }>;
    return rows.map(row => ({ key: row.key, data: JSON.parse(row.data) }));
  }

  async deleteMetadata(namespace: string, key: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM metadata WHERE namespace = ? AND key = ?');
    stmt.run(namespace, key);
  }

  async updateMessageContent(sessionId: string, oldText: string, newText: string, recentLimit = 100): Promise<number> {
    // 找到最近 N 条消息中含 oldText 的记录 ID
    const findStmt = this.db.prepare(`
      SELECT id, content FROM (
        SELECT id, content FROM messages
        WHERE sessionId = ? AND content LIKE ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `);
    const rows = findStmt.all(sessionId, `%${oldText}%`, recentLimit) as Array<{ id: number; content: string }>;
    if (rows.length === 0) return 0;

    const updateStmt = this.db.prepare('UPDATE messages SET content = ? WHERE id = ?');
    let count = 0;
    for (const row of rows) {
      const updated = row.content.replaceAll(oldText, newText);
      if (updated !== row.content) {
        updateStmt.run(updated, row.id);
        count++;
      }
    }
    return count;
  }

  async deleteMessagesByTimestamps(sessionId: string, timestamps: number[]): Promise<number> {
    if (timestamps.length === 0) return 0;
    // SQLite 变量限制 999，分批处理
    const chunkSize = 500;
    let total = 0;
    const txn = this.db.transaction((tsChunks: number[][]) => {
      for (const chunk of tsChunks) {
        const placeholders = chunk.map(() => '?').join(',');
        const stmt = this.db.prepare(`DELETE FROM messages WHERE sessionId = ? AND timestamp IN (${placeholders})`);
        const r = stmt.run(sessionId, ...chunk);
        total += r.changes;
      }
    });
    const chunks: number[][] = [];
    for (let i = 0; i < timestamps.length; i += chunkSize) chunks.push(timestamps.slice(i, i + chunkSize));
    txn(chunks);
    return total;
  }

  close(): void {
    this.db.close();
  }
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const sqliteConfig: SQLiteMemoryConfig = {
    path: (config.path as string) ?? 'data:/aalis.db',
  };

  // 解析数据库路径：storage URI → 本地路径
  const storage = createStorageGateway(ctx);
  const dbUri = toUri(sqliteConfig.path);
  if (!storage.resolveLocalPath) {
    throw new Error('存储实现未提供 resolveLocalPath 能力，无法打开 SQLite 数据库');
  }
  let dbPath: string;
  try {
    dbPath = await storage.resolveLocalPath(dbUri, 'write');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`无法解析数据库路径 ${dbUri}: ${msg}`);
  }

  ctx.logger.info(`正在打开 SQLite 数据库: ${dbPath}`);

  try {
    const db = new Database(dbPath);
    // 设置 WAL 模式提升并发性能
    db.pragma('journal_mode = WAL');

    const service = new SQLiteMemoryService(db, {
      rangeQueryLimit: config.rangeQueryLimit as number | undefined,
      crossSessionMaxLimit: config.crossSessionMaxLimit as number | undefined,
    });

    ctx.provide('memory', service, {
      priority: 10,
    });

    ctx.logger.info(`SQLite 数据库已就绪: ${dbPath}`);

    ctx.onDispose(() => {
      service.close();
      ctx.logger.info('SQLite 数据库已关闭');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`SQLite 打开失败: ${message}`);
  }
}
