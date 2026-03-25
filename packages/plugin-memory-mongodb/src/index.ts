import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Context, MemoryService, Message, ConfigSchema } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-mongodb';
export const provides = ['memory'];

export const configSchema: ConfigSchema = {
  uri: { type: 'string', label: 'MongoDB URI', required: true, default: 'mongodb://localhost:27017', description: 'MongoDB 连接字符串' },
  database: { type: 'string', label: '数据库名', required: true, default: 'aalis', description: '存储消息历史的数据库' },
  collection: { type: 'string', label: '集合名', default: 'messages', description: '消息集合名称' },
};

export const defaultConfig = {
  uri: 'mongodb://localhost:27017',
  database: 'aalis',
  collection: 'messages',
};

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
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    docs.reverse();

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
    ctx.provide('memory', service);

    ctx.logger.info(`MongoDB 已连接: ${mongoConfig.database}/${mongoConfig.collection}`);

    // 在上下文销毁时关闭连接
    ctx.on('dispose', async () => {
      await client.close();
      ctx.logger.info('MongoDB 连接已关闭');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await client.close().catch(() => {});
    throw new Error(`MongoDB 连接失败: ${message}`);
  }
}
