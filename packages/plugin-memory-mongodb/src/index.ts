import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Context, MemoryService, Message } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-mongodb';
export const provides = ['memory'];

// ===== 配置 =====

interface MongoMemoryConfig {
  uri: string;
  database: string;
  collection?: string;
  connectTimeoutMs?: number;
}

// ===== 数据库文档类型 =====

interface MessageDocument {
  sessionId: string;
  role: string;
  content: string | null;
  toolCalls?: unknown[];
  toolCallId?: string;
  name?: string;
  timestamp: number;
  createdAt: Date;
}

// ===== MongoDB 实现 =====

class MongoMemoryService implements MemoryService {
  private collection: Collection<MessageDocument>;

  constructor(collection: Collection<MessageDocument>) {
    this.collection = collection;
  }

  async saveMessage(sessionId: string, message: Message): Promise<void> {
    await this.collection.insertOne({
      sessionId,
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name,
      timestamp: message.timestamp ?? Date.now(),
      createdAt: new Date(),
    });
  }

  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    const docs = await this.collection
      .find({ sessionId })
      .sort({ timestamp: 1 })
      .limit(limit)
      .toArray();

    return docs.map(doc => ({
      role: doc.role as Message['role'],
      content: doc.content,
      toolCalls: doc.toolCalls as Message['toolCalls'],
      toolCallId: doc.toolCallId,
      name: doc.name,
      timestamp: doc.timestamp,
    }));
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.collection.deleteMany({ sessionId });
  }
}

// ===== 内存 fallback 实现 =====

class InMemoryService implements MemoryService {
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

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const mongoConfig: MongoMemoryConfig = {
    uri: (config.uri as string) ?? 'mongodb://localhost:27017',
    database: (config.database as string) ?? 'aalis',
    collection: (config.collection as string) ?? 'messages',
    connectTimeoutMs: (config.connectTimeoutMs as number) ?? 5000,
  };

  ctx.logger.info(`正在连接 MongoDB: ${mongoConfig.uri} (超时: ${mongoConfig.connectTimeoutMs}ms)`);

  const client = new MongoClient(mongoConfig.uri, {
    serverSelectionTimeoutMS: mongoConfig.connectTimeoutMs,
    connectTimeoutMS: mongoConfig.connectTimeoutMs,
  });

  try {
    await client.connect();
    const db: Db = client.db(mongoConfig.database);
    const collection = db.collection<MessageDocument>(mongoConfig.collection!);

    // 创建索引
    await collection.createIndex({ sessionId: 1, timestamp: 1 });

    const service = new MongoMemoryService(collection);
    ctx.provide('memory', service, {
      capabilities: ['history', 'persistence'],
    });

    ctx.logger.info(`MongoDB 已连接: ${mongoConfig.database}/${mongoConfig.collection}`);

    // 在上下文销毁时关闭连接
    ctx.on('dispose', async () => {
      await client.close();
      ctx.logger.info('MongoDB 连接已关闭');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`MongoDB 连接失败: ${message}`);
    await client.close().catch(() => {});

    // 回退到内存模式
    ctx.logger.info('回退到内存记忆模式 (数据不会持久化，重启后丢失)');
    const fallback = new InMemoryService();
    ctx.provide('memory', fallback, {
      capabilities: ['history'],
    });
  }
}
