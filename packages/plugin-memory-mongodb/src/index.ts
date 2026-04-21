import { MongoClient, type Collection, type Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import type { Context, Message, ConfigSchema } from '@aalis/core';
import type { MemoryService, ConversationTurn } from '@aalis/core';
import { MemoryCapabilities } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-mongodb';
export const displayName = 'MongoDB 记忆';
export const provides = ['memory'];
export const reusable = true;

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
  reasoningContent?: string | null;
  timestamp: number;
  archived?: boolean;
  createdAt: Date;
}

interface TurnDocument {
  turnId: string;
  sessionId: string;
  userId?: string;
  platform?: string;
  userContent: string;
  assistantContent: string;
  timestamp: number;
  createdAt: Date;
}

// ===== MongoDB 实现 =====

interface MetadataDocument {
  namespace: string;
  key: string;
  data: Record<string, unknown>;
  updatedAt: Date;
}

class MongoMemoryService implements MemoryService {
  private collection: Collection<MessageDocument>;
  private turns: Collection<TurnDocument>;
  private meta: Collection<MetadataDocument>;

  constructor(collection: Collection<MessageDocument>, turns: Collection<TurnDocument>, meta: Collection<MetadataDocument>) {
    this.collection = collection;
    this.turns = turns;
    this.meta = meta;
  }

  async saveMessage(sessionId: string, message: Message): Promise<void> {
    await this.collection.insertOne({
      sessionId,
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name,
      reasoningContent: message.reasoningContent ?? null,
      timestamp: message.timestamp ?? Date.now(),
      createdAt: new Date(),
    });
  }

  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    const docs = await this.collection
      .find({ sessionId, archived: { $ne: true } })
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
      reasoningContent: doc.reasoningContent ?? undefined,
    }));
  }

  async getFullHistory(sessionId: string, limit = 200): Promise<Message[]> {
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
      reasoningContent: doc.reasoningContent ?? undefined,
    }));
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.collection.deleteMany({ sessionId });
  }

  // ----- 对话轮次归档 -----

  async saveTurn(turn: Omit<ConversationTurn, 'id'>): Promise<string> {
    const turnId = randomUUID();
    await this.turns.insertOne({
      turnId,
      sessionId: turn.sessionId,
      userId: turn.userId,
      platform: turn.platform,
      userContent: turn.userContent,
      assistantContent: turn.assistantContent,
      timestamp: turn.timestamp,
      createdAt: new Date(),
    });
    return turnId;
  }

  async getTurns(turnIds: string[]): Promise<ConversationTurn[]> {
    if (turnIds.length === 0) return [];
    const docs = await this.turns.find({ turnId: { $in: turnIds } }).toArray();
    return docs.map(doc => ({
      id: doc.turnId,
      sessionId: doc.sessionId,
      userId: doc.userId,
      platform: doc.platform,
      userContent: doc.userContent,
      assistantContent: doc.assistantContent,
      timestamp: doc.timestamp,
    }));
  }

  async deleteTurns(sessionId: string): Promise<number> {
    const result = await this.turns.deleteMany({ sessionId });
    return result.deletedCount;
  }

  async trimHistory(sessionId: string, keepRecent: number): Promise<number> {
    // 找到要保留的最近消息（仅在未归档消息中）
    const keepDocs = await this.collection
      .find({ sessionId, archived: { $ne: true } })
      .sort({ timestamp: -1 })
      .limit(keepRecent)
      .project({ _id: 1 })
      .toArray();
    const keepIds = keepDocs.map(d => d._id);
    if (keepIds.length === 0) return 0;
    const result = await this.collection.updateMany(
      { sessionId, archived: { $ne: true }, _id: { $nin: keepIds } },
      { $set: { archived: true } },
    );
    return result.modifiedCount;
  }

  async clearAll(): Promise<void> {
    await this.collection.deleteMany({});
    await this.turns.deleteMany({});
    await this.meta.deleteMany({});
  }

  // ----- 结构化元数据存储 -----

  async saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void> {
    await this.meta.updateOne(
      { namespace, key },
      { $set: { data, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  async getMetadata(namespace: string, key: string): Promise<Record<string, unknown> | undefined> {
    const doc = await this.meta.findOne({ namespace, key });
    return doc?.data;
  }

  async listMetadata(namespace: string): Promise<Array<{ key: string; data: Record<string, unknown> }>> {
    const docs = await this.meta.find({ namespace }).toArray();
    return docs.map(d => ({ key: d.key, data: d.data }));
  }

  async deleteMetadata(namespace: string, key: string): Promise<void> {
    await this.meta.deleteOne({ namespace, key });
  }

  async updateMessageContent(sessionId: string, oldText: string, newText: string, recentLimit = 100): Promise<number> {
    // 找到最近含 oldText 的消息
    const docs = await this.collection
      .find({ sessionId, content: { $regex: oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } })
      .sort({ timestamp: -1 })
      .limit(recentLimit)
      .toArray();
    if (docs.length === 0) return 0;

    let count = 0;
    for (const doc of docs) {
      if (doc.content && doc.content.includes(oldText)) {
        const updated = doc.content.replace(oldText, newText);
        await this.collection.updateOne({ _id: doc._id }, { $set: { content: updated } });
        count++;
      }
    }
    return count;
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
    const turnsCollection = db.collection<TurnDocument>('conversation_turns');
    const metaCollection = db.collection<MetadataDocument>('metadata');

    // 创建索引
    await collection.createIndex({ sessionId: 1, timestamp: 1 });
    await turnsCollection.createIndex({ turnId: 1 }, { unique: true });
    await turnsCollection.createIndex({ sessionId: 1, timestamp: 1 });
    await metaCollection.createIndex({ namespace: 1, key: 1 }, { unique: true });

    const service = new MongoMemoryService(collection, turnsCollection, metaCollection);
    ctx.provide('memory', service, {
      capabilities: [
        MemoryCapabilities.History,
        MemoryCapabilities.TurnArchive,
        MemoryCapabilities.Metadata,
        MemoryCapabilities.ContentUpdate,
      ],
    });

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
