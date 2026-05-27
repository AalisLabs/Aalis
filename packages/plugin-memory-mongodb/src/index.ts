import type { ConfigSchema, Context } from '@aalis/core';
import type { MemoryService, RecentMessageRecord, RecentMessagesAcrossSessionsQuery } from '@aalis/plugin-memory-api';
import { MemoryCapabilities } from '@aalis/plugin-memory-api';
import type { Message } from '@aalis/plugin-message-api';
import { type Collection, type Db, MongoClient } from 'mongodb';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-mongodb';
export const displayName = 'MongoDB 记忆';
export const subsystem = 'memory';
export const provides = ['memory'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  uri: {
    type: 'string',
    label: 'MongoDB URI',
    required: true,
    default: 'mongodb://localhost:27017',
    description: 'MongoDB 连接字符串',
  },
  database: {
    type: 'string',
    label: '数据库名',
    required: true,
    default: 'aalis',
    description: '存储消息历史的数据库',
  },
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
  /** Message.kind（与 role 正交的子分类，如 'event-marker' / 'cross-session-delegation' / 'outbound-image' / 'poke' 等） */
  kind?: string;
  content: string | null;
  toolCalls?: unknown[];
  toolCallId?: string;
  name?: string;
  reasoningContent?: string | null;
  timestamp: number;
  archived?: boolean;
  metadata?: Record<string, unknown>;
  segments?: unknown[];
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
  private meta: Collection<MetadataDocument>;

  constructor(collection: Collection<MessageDocument>, meta: Collection<MetadataDocument>) {
    this.collection = collection;
    this.meta = meta;
  }

  async saveMessage(sessionId: string, message: Message): Promise<void> {
    await this.collection.insertOne({
      sessionId,
      role: message.role,
      kind: message.kind,
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name,
      reasoningContent: message.reasoningContent ?? null,
      timestamp: message.timestamp ?? Date.now(),
      metadata: message.metadata,
      segments: message.segments,
      createdAt: new Date(),
    });
  }

  private docToMessage(doc: MessageDocument): Message {
    return {
      role: doc.role as Message['role'],
      kind: doc.kind,
      content: doc.content,
      toolCalls: doc.toolCalls as Message['toolCalls'],
      toolCallId: doc.toolCallId,
      name: doc.name,
      timestamp: doc.timestamp,
      reasoningContent: doc.reasoningContent ?? undefined,
      segments: doc.segments as Message['segments'],
      metadata: doc.metadata,
    };
  }

  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    const docs = await this.collection
      .find({ sessionId, archived: { $ne: true } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    docs.reverse();
    return docs.map(doc => this.docToMessage(doc));
  }

  async getFullHistory(sessionId: string, limit = 200): Promise<Message[]> {
    const docs = await this.collection.find({ sessionId }).sort({ timestamp: -1 }).limit(limit).toArray();
    docs.reverse();
    return docs.map(doc => this.docToMessage(doc));
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.collection.deleteMany({ sessionId });
  }

  async getMessagesBySessionRange(
    sessionId: string,
    fromTs: number,
    toTs: number,
    roles?: Array<Message['role']>,
    excludeKinds?: string[],
  ): Promise<Message[]> {
    const filter: Record<string, unknown> = { sessionId, timestamp: { $gte: fromTs, $lte: toTs } };
    if (roles && roles.length > 0) filter.role = { $in: roles };
    if (excludeKinds && excludeKinds.length > 0) filter.kind = { $nin: excludeKinds };
    const docs = await this.collection.find(filter).sort({ timestamp: 1 }).limit(500).toArray();
    return docs.map(doc => this.docToMessage(doc));
  }

  async getRecentMessagesAcrossSessions(query: RecentMessagesAcrossSessionsQuery): Promise<RecentMessageRecord[]> {
    const limit = Math.max(1, Math.min(query.limit, 1000));
    const roles = query.roles && query.roles.length > 0 ? query.roles : (['user', 'assistant'] as Message['role'][]);
    const filter: Record<string, unknown> = {
      archived: { $ne: true },
      role: { $in: roles },
    };
    if (query.kinds && query.kinds.length > 0) filter.kind = { $in: query.kinds };
    if (query.excludeKinds && query.excludeKinds.length > 0) {
      // 与已有 kind 条件 AND：MongoDB 注意 $nin 不排除不存在 kind 的文档，恢复性友好。
      filter.kind = { ...(filter.kind as Record<string, unknown> | undefined), $nin: query.excludeKinds };
    }
    if (typeof query.sinceTs === 'number') {
      filter.timestamp = { $gte: query.sinceTs };
    }
    if (typeof query.platform === 'string') {
      filter['metadata.platform'] = query.platform;
    }
    if (query.excludeSessionIds && query.excludeSessionIds.length > 0) {
      filter.sessionId = { $nin: query.excludeSessionIds };
    }

    const docs = await this.collection.find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
    docs.reverse();

    return docs.map(d => ({
      sessionId: d.sessionId,
      message: this.docToMessage(d),
    }));
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
    await this.meta.deleteMany({});
  }

  // ----- 结构化元数据存储 -----

  async saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void> {
    await this.meta.updateOne({ namespace, key }, { $set: { data, updatedAt: new Date() } }, { upsert: true });
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
      if (doc.content?.includes(oldText)) {
        const updated = doc.content.replace(oldText, newText);
        await this.collection.updateOne({ _id: doc._id }, { $set: { content: updated } });
        count++;
      }
    }
    return count;
  }

  async deleteMessagesByTimestamps(sessionId: string, timestamps: number[]): Promise<number> {
    if (timestamps.length === 0) return 0;
    const r = await this.collection.deleteMany({ sessionId, timestamp: { $in: timestamps } });
    return r.deletedCount ?? 0;
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
    const metaCollection = db.collection<MetadataDocument>('metadata');

    // 创建索引
    await collection.createIndex({ sessionId: 1, timestamp: 1 });
    await collection.createIndex({ archived: 1, timestamp: -1 });
    await collection.createIndex({ 'metadata.platform': 1, timestamp: -1 });
    await metaCollection.createIndex({ namespace: 1, key: 1 }, { unique: true });

    const service = new MongoMemoryService(collection, metaCollection);
    ctx.provide('memory', service, {
      // priority 与同类 memory provider 自文档化对照：
      //   sqlite=10（零配置默认）, mongodb=5（需服务，但更强）, inmemory=-100（仅测试）
      // 用户通过 servicePreferences 显式偏好时该字段不影响选择。
      priority: 5,
      capabilities: [
        MemoryCapabilities.History,
        MemoryCapabilities.Metadata,
        MemoryCapabilities.ContentUpdate,
        MemoryCapabilities.MessageDelete,
        MemoryCapabilities.RecentAcrossSessions,
      ],
    });

    ctx.logger.info(`MongoDB 已连接: ${mongoConfig.database}/${mongoConfig.collection}`);

    // 在上下文销毁时关闭连接
    ctx.onDispose(async () => {
      await client.close();
      ctx.logger.info('MongoDB 连接已关闭');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await client.close().catch(() => {});
    throw new Error(`MongoDB 连接失败: ${message}`);
  }
}
