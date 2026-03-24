import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { Context, MemoryService, Message, ConfigSchema, VectorStoreService } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-sqlite';
export const provides = ['memory'];

export const configSchema: ConfigSchema = {
  path: { type: 'string', label: '数据库路径', default: 'data/aalis.db' },
};

export const defaultConfig = {
  path: 'data/aalis.db',
};

// ===== 配置 =====

interface SQLiteMemoryConfig {
  /** 数据库文件路径（相对于配置目录或绝对路径） */
  path: string;
}

// ===== SQLite MemoryService 实现 =====

class SQLiteMemoryService implements MemoryService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;

    // 创建表（如果不存在）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        toolCalls TEXT,
        toolCallId TEXT,
        name TEXT,
        timestamp INTEGER NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(sessionId, timestamp);
    `);
  }

  async saveMessage(sessionId: string, message: Message): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO messages (sessionId, role, content, toolCalls, toolCallId, name, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId,
      message.role,
      message.content,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolCallId ?? null,
      message.name ?? null,
      message.timestamp ?? Date.now(),
    );
  }

  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    const stmt = this.db.prepare(`
      SELECT role, content, toolCalls, toolCallId, name, timestamp
      FROM messages
      WHERE sessionId = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `);
    const rows = stmt.all(sessionId, limit) as Array<{
      role: string;
      content: string | null;
      toolCalls: string | null;
      toolCallId: string | null;
      name: string | null;
      timestamp: number;
    }>;

    return rows.map(row => ({
      role: row.role as Message['role'],
      content: row.content,
      toolCalls: row.toolCalls ? JSON.parse(row.toolCalls) : undefined,
      toolCallId: row.toolCallId ?? undefined,
      name: row.name ?? undefined,
      timestamp: row.timestamp,
    }));
  }

  async clearSession(sessionId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM messages WHERE sessionId = ?');
    stmt.run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const sqliteConfig: SQLiteMemoryConfig = {
    path: (config.path as string) ?? 'data/aalis.db',
  };

  // 解析数据库路径
  const dbPath = resolve(ctx.config.getConfigDir(), sqliteConfig.path);
  const dbDir = resolve(dbPath, '..');
  try {
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`无法创建数据库目录 ${dbDir}: ${msg}`);
    return;
  }

  ctx.logger.info(`正在打开 SQLite 数据库: ${dbPath}`);

  try {
    const db = new Database(dbPath);
    // 设置 WAL 模式提升并发性能
    db.pragma('journal_mode = WAL');

    const service = new SQLiteMemoryService(db);

    ctx.provide('memory', service, {
      capabilities: ['history', 'persistence'],
      priority: 10, // 比 MongoDB 和 fallback 优先级高
    });

    // 注册 /clear 指令 —— 由 memory 服务提供者负责
    ctx.command('clear', '清空当前会话历史及长期记忆', async (cmdCtx) => {
      await service.clearSession(cmdCtx.sessionId);
      // 同时清空向量记忆
      const vectorstore = ctx.getService<VectorStoreService>('vectorstore');
      if (vectorstore) {
        await vectorstore.clear();
        ctx.logger.info('向量记忆已清空');
      }
      return '会话历史与长期记忆已清空。';
    });

    ctx.logger.info(`SQLite 数据库已就绪: ${dbPath}`);

    ctx.on('dispose', () => {
      service.close();
      ctx.logger.info('SQLite 数据库已关闭');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`SQLite 打开失败: ${message}`);
    // 不提供服务 — core 的 fallback 会接管
  }
}
