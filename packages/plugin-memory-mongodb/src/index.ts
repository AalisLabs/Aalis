import { type HostPaths, hostPaths } from '@aalis/api-host-paths';
import {
  type MemoryService,
  type MetadataEntry,
  type MetadataOp,
  memory,
  type RecentMessageRecord,
  type RecentMessagesAcrossSessionsQuery,
} from '@aalis/api-memory';
import {
  type BoundOf,
  config,
  definePlugin,
  type LifecycleCap,
  type Logger,
  lifecycle,
  logger,
  optional,
  parseInstanceId,
  provide,
} from '@aalis/core';
import { type ConfigOf, configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { TextError, textOf } from '@aalis/schema-i18n';
import { CONTROL_KINDS, type Message, WellKnownMetadataKeys } from '@aalis/schema-message';
import { type Collection, type Db, type FindCursor, MongoClient } from 'mongodb';
import { t } from './texts.js';

const configSchema = defineConfig({
  uri: {
    type: 'string',
    label: 'MongoDB URI',
    required: true,
    default: 'mongodb://localhost:27017',
    onInvalid: 'error',
    secret: true,
    description: t('uriDescription'),
  },
  database: {
    type: 'string',
    label: t('databaseLabel'),
    default: '',
    onInvalid: 'error',
    description: t('databaseDescription'),
  },
  claimFrom: {
    type: 'string',
    label: t('claimFromLabel'),
    default: '',
    onInvalid: 'error',
    description: t('claimFromDescription'),
  },
  collection: {
    type: 'string',
    label: t('collectionLabel'),
    default: 'messages',
    onInvalid: 'error',
    description: t('collectionDescription'),
  },
  connectTimeoutMs: {
    type: 'number',
    label: t('connectTimeoutMsLabel'),
    default: 5000,
    description: t('connectTimeoutMsDescription'),
  },
  rangeQueryLimit: {
    type: 'number',
    label: t('rangeQueryLimitLabel'),
    default: 500,
    description: t('rangeQueryLimitDescription'),
  },
  crossSessionMaxLimit: {
    type: 'number',
    label: t('crossSessionMaxLimitLabel'),
    default: 1000,
    description: t('crossSessionMaxLimitDescription'),
  },
});

// ===== 配置 =====

type MongoMemoryConfig = Pick<ConfigOf<typeof configSchema>, 'uri' | 'database'> &
  Partial<Omit<ConfigOf<typeof configSchema>, 'uri' | 'database'>>;

/** 库的归属记录：元数据集合里的一条，命名空间专用，不与插件的元数据混在一起 */
const OWNER_NAMESPACE = 'aalis.home';
const OWNER_KEY = 'owner';

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
  /** 本插件写入时总会带上；手工导入等外部写入的文档可能缺 */
  updatedAt?: Date;
}

/**
 * 游标按 limit 取前若干条：limit 为 0 时为空（MongoDB 的 limit(0) 表示不限条数，不能透传）；为 Infinity 时不设
 * （limit 要是整数）
 */
async function limited<T>(cursor: FindCursor<T>, limit: number): Promise<T[]> {
  if (limit === 0) return [];
  return (limit === Infinity ? cursor : cursor.limit(limit)).toArray();
}

/** 对话消息：kind 不属于 CONTROL_KINDS（没有 kind 的也算，$nin 不排除缺这个字段的文档） */
const SAID = { kind: { $nin: [...CONTROL_KINDS] } };

/** @internal 只为测试导出：以替身集合直接构造（经 apply 会连真实的 mongod），不是公开 API */
export class MongoMemoryService implements MemoryService {
  private collection: Collection<MessageDocument>;
  private meta: Collection<MetadataDocument>;
  private readonly rangeQueryLimit: number;
  private readonly crossSessionMaxLimit: number;
  /** listMetadata 跳过读不出的文档时由它点名 */
  private readonly logger: Pick<Logger, 'warn'>;

  constructor(
    collection: Collection<MessageDocument>,
    meta: Collection<MetadataDocument>,
    opts: { rangeQueryLimit?: number; crossSessionMaxLimit?: number; logger: Pick<Logger, 'warn'> },
  ) {
    this.collection = collection;
    this.meta = meta;
    this.logger = opts.logger;
    this.rangeQueryLimit = Math.max(1, opts.rangeQueryLimit ?? 500);
    this.crossSessionMaxLimit = Math.max(1, opts.crossSessionMaxLimit ?? 1000);
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
    // 条数为 0 时为空，不带最后一条对话消息之后的标记
    if (limit === 0) return [];
    const active = { sessionId, archived: { $ne: true } };
    // 只数对话消息：读出第 limit+1 新的那条对话消息之后的全部，夹在其间的标记一并带回；没有这一条（不超过 limit 条）时是全部
    const [before] =
      limit === Infinity
        ? []
        : await this.collection
            .find({ ...active, ...SAID })
            .sort({ timestamp: -1, _id: -1 })
            .skip(limit)
            .limit(1)
            .toArray();
    // sort 必须带 _id 次键：同毫秒写入的消息（如同一轮的 assistant+tool 合成对）
    // 在纯 timestamp 排序下平票顺序不稳定，读回时 tool 可能排到 assistant 前面，
    // 被 sanitizeToolCallHistory 当作孤儿整组丢弃。_id 单调递增即插入序。
    const docs = await this.collection
      .find(
        before
          ? {
              ...active,
              $or: [
                { timestamp: { $gt: before.timestamp } },
                { timestamp: before.timestamp, _id: { $gt: before._id } },
              ],
            }
          : active,
      )
      .sort({ timestamp: -1, _id: -1 })
      .toArray();
    docs.reverse();
    return docs.map(doc => this.docToMessage(doc));
  }

  async countHistory(sessionId: string): Promise<number> {
    return this.collection.countDocuments({ sessionId, archived: { $ne: true }, ...SAID });
  }

  async getFullHistory(sessionId: string, limit = 200): Promise<Message[]> {
    // 同 getHistory：_id 次键保证同毫秒消息按插入序稳定返回
    const docs = await limited(this.collection.find({ sessionId }).sort({ timestamp: -1, _id: -1 }), limit);
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
    const docs = await this.collection.find(filter).sort({ timestamp: 1 }).limit(this.rangeQueryLimit).toArray();
    return docs.map(doc => this.docToMessage(doc));
  }

  async getRecentMessagesAcrossSessions(query: RecentMessagesAcrossSessionsQuery): Promise<RecentMessageRecord[]> {
    const limit = Math.max(0, Math.min(query.limit, this.crossSessionMaxLimit));
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
      filter[`metadata.${WellKnownMetadataKeys.Platform}`] = query.platform;
    }
    if (query.excludeSessionIds && query.excludeSessionIds.length > 0) {
      filter.sessionId = { $nin: query.excludeSessionIds };
    }

    const docs = await limited(this.collection.find(filter).sort({ timestamp: -1 }), limit);
    docs.reverse();

    return docs.map(d => ({
      sessionId: d.sessionId,
      message: this.docToMessage(d),
    }));
  }

  async archiveSpan(sessionId: string, { count, keep }: { count: number; keep: readonly number[] }): Promise<number> {
    // 与 getHistory 同序：_id 次键让同毫秒的消息按插入序数位置
    const docs = await limited(
      this.collection
        .find({ sessionId, archived: { $ne: true } })
        .sort({ timestamp: 1, _id: 1 })
        .project({ _id: 1 }),
      count,
    );
    const kept = new Set(keep);
    const result = await this.collection.updateMany(
      { _id: { $in: docs.filter((_, i) => !kept.has(i)).map(d => d._id) } },
      { $set: { archived: true } },
    );
    return result.modifiedCount;
  }

  /** 只清消息（含归档）；元数据由归属插件经 memory:clear 自行清理（见 api-memory 的 clearAll 契约） */
  async clearAll(): Promise<void> {
    await this.collection.deleteMany({});
  }

  // ----- 结构化元数据存储 -----

  async saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void> {
    await this.meta.updateOne({ namespace, key }, { $set: { data, updatedAt: new Date() } }, { upsert: true });
  }

  async getMetadata(namespace: string, key: string): Promise<Record<string, unknown> | undefined> {
    const doc = await this.meta.findOne({ namespace, key });
    return doc?.data;
  }

  async listMetadata(namespace: string): Promise<MetadataEntry[]> {
    const docs = await this.meta.find({ namespace }).toArray();
    // 外部写入的文档可能缺字段：data 不是对象的跳过并点名键，不让整个命名空间读失败（各插件整体清空命名空间时
    // 经 listMetadataKeys 列键，这些文档照样删掉）；写入时间缺失或不是日期的照常返回，updatedAt 记 0
    const entries: MetadataEntry[] = [];
    for (const d of docs) {
      const data: unknown = d.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        this.logger.warn(`元数据 ${namespace}/${d.key} 的 data 不是对象，已跳过`);
        continue;
      }
      entries.push({ key: d.key, data: d.data, updatedAt: d.updatedAt instanceof Date ? d.updatedAt.getTime() : 0 });
    }
    return entries;
  }

  async listMetadataKeys(namespace: string): Promise<string[]> {
    const docs = await this.meta.find({ namespace }).project<{ key: string }>({ _id: 0, key: 1 }).toArray();
    return docs.map(d => d.key);
  }

  async commitMetadata(ops: readonly MetadataOp[]): Promise<void> {
    if (ops.length === 0) return;
    // bulkWrite 是单次往返；**但它不是事务**——MongoDB 的多文档事务要求副本集，
    // 而本插件对单机部署也要能用。ordered:true 保证按序执行、遇错即停，
    // 于是失败点之前的写已生效、之后的未执行，不会出现乱序的半新半旧。
    await this.meta.bulkWrite(
      ops.map(o =>
        o.op === 'put'
          ? {
              updateOne: {
                filter: { namespace: o.namespace, key: o.key },
                update: { $set: { data: o.data, updatedAt: new Date() } },
                upsert: true,
              },
            }
          : { deleteOne: { filter: { namespace: o.namespace, key: o.key } } },
      ),
      { ordered: true },
    );
  }

  async deleteMetadata(namespace: string, key: string): Promise<void> {
    await this.meta.deleteOne({ namespace, key });
  }

  async updateMessageContent(sessionId: string, oldText: string, newText: string, recentLimit = 100): Promise<number> {
    // 找到最近含 oldText 的消息
    const docs = await limited(
      this.collection
        .find({ sessionId, content: { $regex: oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } })
        .sort({ timestamp: -1 }),
      recentLimit,
    );
    if (docs.length === 0) return 0;

    let count = 0;
    for (const doc of docs) {
      if (doc.content?.includes(oldText)) {
        const updated = doc.content.replaceAll(oldText, newText);
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

/**
 * 脱敏 MongoDB 连接串里的密码（userinfo 的 password 段），用于日志，避免明文口令泄漏。
 * `mongodb://user:pass@host` → `mongodb://user:***@host`；无凭证的串（如 localhost）原样返回。
 */
export function redactMongoUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^:@/]+:)[^@]*(@)/i, '$1***$2');
}

const uses = { logger, config, lifecycle, provide, paths: optional(hostPaths) };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-memory-mongodb',
  displayName: t('displayName'),
  subsystem: 'memory',
  configSchema,
  reusable: true,
  provides: [memory],
  uses,
  apply: connectAndProvide,
});

async function connectAndProvide(caps: Caps): Promise<void> {
  const { logger, lifecycle, provide } = caps;
  const cfg = parseConfig(configSchema, caps.config.use, logger.use);
  const mongoConfig: MongoMemoryConfig = { ...cfg, database: cfg.database.trim(), claimFrom: cfg.claimFrom.trim() };

  logger.use.info(`正在连接 MongoDB: ${redactMongoUri(mongoConfig.uri)} (超时: ${mongoConfig.connectTimeoutMs}ms)`);

  const client = new MongoClient(mongoConfig.uri, {
    serverSelectionTimeoutMS: mongoConfig.connectTimeoutMs,
    connectTimeoutMS: mongoConfig.connectTimeoutMs,
  });
  await openAndProvide(
    client,
    mongoConfig,
    { logger, lifecycle, provide },
    caps.paths.present ? caps.paths.use : undefined,
  );
}

/**
 * 本进程里各库（连接串 + 库名）由哪次激活使用。元数据集合固定名为 metadata、与消息集合同库，
 * 两个实例用同一个库就会共写，后激活的那个以配置错误失败；激活关闭时撤下自己的登记。
 */
const openedBy = new Map<string, LifecycleCap>();

/**
 * 库名留空时按家目录与实例派生（见 deriveDatabase），登记占用后连接、核对库的归属、建索引并发布服务。
 * 停用或停机（lifecycle.signal abort）时 `client.close()`，让在途的连接与建索引以错误返回。
 * @internal 只为测试导出：以替身客户端直接调用（经 apply 会连真实的 mongod），不是公开 API
 */
export async function openAndProvide(
  client: MongoClient,
  mongoConfig: MongoMemoryConfig,
  { logger, lifecycle, provide }: Omit<Caps, 'config' | 'paths'>,
  /** 本次激活所在的家目录（宿主经 host-paths 给出；宿主不提供时不做归属检查） */
  owner?: Pick<HostPaths, 'home' | 'profile'>,
): Promise<void> {
  const { suffix } = parseInstanceId(lifecycle.use.id);
  const database = mongoConfig.database || deriveDatabase(owner?.profile, suffix);
  if (Buffer.byteLength(database) > 63) {
    throw configError(t('databaseTooLong', { database, instance: lifecycle.use.id }));
  }
  const location = `${mongoConfig.uri}\n${database}`;
  const holder = openedBy.get(location);
  if (holder && holder.id !== lifecycle.use.id) {
    throw configError(t('databaseInUse', { database, holder: holder.id, instance: lifecycle.use.id }));
  }
  openedBy.set(location, lifecycle.use);
  lifecycle.use.onDispose(() => {
    if (openedBy.get(location) === lifecycle.use) openedBy.delete(location);
  });

  // 监听器同步执行、不得抛错：close 的拒绝吞掉
  const onAbort = (): void => void client.close().catch(() => {});
  lifecycle.use.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect();
    // mongodb+srv 在 SRV 解析期间 close 不生效，连接会在 abort 之后照常建成：由这里抛出、下方 catch 关闭
    lifecycle.use.signal.throwIfAborted();
    const db: Db = client.db(database);
    const collection = db.collection<MessageDocument>(mongoConfig.collection!);
    const metaCollection = db.collection<MetadataDocument>('metadata');

    await metaCollection.createIndex({ namespace: 1, key: 1 }, { unique: true });
    if (owner)
      await claimOwnership(
        db,
        metaCollection,
        { home: owner.home, instance: lifecycle.use.id },
        database,
        mongoConfig.claimFrom ?? '',
        logger.use,
      );
    lifecycle.use.signal.throwIfAborted();

    // 创建索引
    await collection.createIndex({ sessionId: 1, timestamp: 1 });
    await collection.createIndex({ archived: 1, timestamp: -1 });
    await collection.createIndex({ [`metadata.${WellKnownMetadataKeys.Platform}`]: 1, timestamp: -1 });
    lifecycle.use.signal.throwIfAborted();

    const service = new MongoMemoryService(collection, metaCollection, {
      rangeQueryLimit: mongoConfig.rangeQueryLimit,
      crossSessionMaxLimit: mongoConfig.crossSessionMaxLimit,
      logger: logger.use,
    });
    provide.use(memory, service, {
      // priority 与同类 memory provider 自文档化对照：
      //   sqlite=10（零配置默认）, mongodb=5（需服务，但更强）, inmemory=-100（仅测试）
      // 用户通过 servicePreferences 显式偏好时该字段不影响选择。
      priority: 5,
    });

    logger.use.info(`MongoDB 已连接: ${database}/${mongoConfig.collection}`);

    // 连接握手跨 await，关闭可能已开始；迟到的清理照样被执行
    lifecycle.use.onDispose(async () => {
      await client.close();
      logger.use.info('MongoDB 连接已关闭');
    }, 'mongodb:client.close');
  } catch (err) {
    await client.close().catch(() => {});
    // 库的归属不对是配置问题，不是连接失败：原样抛出，宿主按配置错误报一行
    if ((err as { name?: unknown } | null)?.name === 'ConfigError') throw err;
    throw new TextError(t('connectFailed', { error: textOf(err) }), { cause: err });
  } finally {
    lifecycle.use.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 库名留空时的派生：主家目录 aalis，profile 家目录 aalis_<p>，带后缀的实例再加后缀（aalis-b、aalis_<p>_b）。
 * profile 只含小写字母、数字与连字符，不含下划线：profile 与后缀之间用下划线接，两段拆得开，
 * profile test-b 的主实例（aalis_test-b）与 profile test 的 :b 实例（aalis_test_b）不会撞名。
 */
function deriveDatabase(profile: string | undefined, suffix: string | undefined): string {
  if (profile === undefined) return suffix ? `aalis-${suffix}` : 'aalis';
  return suffix ? `aalis_${profile}_${suffix}` : `aalis_${profile}`;
}

/**
 * 核对库的归属：库里记着它归哪个家目录与哪个实例。两个家目录（例如开发用的 .aalis-dev 与生产的 ~/.aalis，
 * 或复制出来的测试实例）连同一个 MongoDB、派生出同一个库名时，后来的那个以一行配置错误激活失败，不会共写。
 * 归属按家目录的路径认，不按随机 id：复制家目录时 id 会跟着复制，复制出来的实例就认不出来了。
 * 只在激活时核对一次：认领之后，原家目录里还在跑的实例不会察觉，所以认领前要先停掉它。
 * - 没有记录、库里也没有数据：记下本家目录，是新库。
 * - 没有记录、库里已有数据：不默认认走，要配置里写 claimFrom: unowned 才认领（迁移时由迁移脚本写好记录）。
 * - 记录是别的家目录或别的实例：报错并点名；claimFrom 写的正是记录里的家目录时改记到本家目录（搬迁后认领）。
 * - 记录坏了（缺家目录或实例）：报错；claimFrom: unowned 时改写。
 */
async function claimOwnership(
  db: Db,
  meta: Collection<MetadataDocument>,
  me: { home: string; instance: string },
  database: string,
  claimFrom: string,
  logger: Logger,
): Promise<void> {
  const filter = { namespace: OWNER_NAMESPACE, key: OWNER_KEY };
  const mine = { home: me.home, instance: me.instance };
  const doc = await meta.findOne(filter);
  if (!doc) {
    if (claimFrom !== 'unowned' && (await hasData(db))) {
      throw configError(t('unownedData', { database, instance: me.instance }));
    }
    try {
      await meta.insertOne({ ...filter, data: mine, updatedAt: new Date() });
    } catch (err) {
      // 另一个家目录同时在认领：唯一索引让后到的写入失败，按对方的记录重新核对
      if ((err as { code?: unknown }).code !== 11000) throw err;
      return claimOwnership(db, meta, me, database, claimFrom, logger);
    }
    logger.info(
      `MongoDB 库 ${database} 记下归属：家目录 ${me.home}，实例 ${me.instance}` +
        (claimFrom ? '；请从配置里删掉 claimFrom' : ''),
    );
    return;
  }
  const record = doc.data as { home?: unknown; instance?: unknown } | null | undefined;
  const owner =
    typeof record?.home === 'string' && typeof record.instance === 'string'
      ? { home: record.home, instance: record.instance }
      : undefined;
  if (owner?.home === me.home && owner.instance === me.instance) {
    if (claimFrom)
      logger.warn(`MongoDB 库 ${database} 本就归本家目录，claimFrom 用不上了：请从 ${me.instance} 的配置里删掉它`);
    return;
  }
  if (owner ? claimFrom === owner.home : claimFrom === 'unowned') {
    // 比对后写入：读到记录之后它被别人改了（两个家目录同时认领）就不覆盖，按新的记录重新核对
    const { matchedCount } = await meta.updateOne(
      { ...filter, data: doc.data },
      { $set: { data: mine, updatedAt: new Date() } },
    );
    if (matchedCount === 0) return claimOwnership(db, meta, me, database, claimFrom, logger);
    logger.info(
      `MongoDB 库 ${database} 的归属改到家目录 ${me.home}，实例 ${me.instance}；认领已完成，请从配置里删掉 claimFrom`,
    );
    return;
  }
  if (!owner) {
    throw configError(
      t('ownerRecordBroken', { database, namespace: OWNER_NAMESPACE, key: OWNER_KEY, instance: me.instance }),
    );
  }
  if (owner.home === me.home) {
    throw configError(
      t('ownedBySibling', { database, owner: owner.instance, instance: me.instance, home: owner.home }),
    );
  }
  throw configError(
    t('ownedByOtherHome', { database, home: owner.home, owner: owner.instance, instance: me.instance }),
  );
}

/**
 * 库里有没有数据（在还没有归属记录时调用）：任一集合里有文档。只看配置的消息集合不够：
 * 换过集合名的、只剩元数据的库，同样是别人的数据。只建了索引的空集合（上次激活中途失败留下的）不算。
 */
async function hasData(db: Db): Promise<boolean> {
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    if (await db.collection(name).findOne({}, { projection: { _id: 1 } })) return true;
  }
  return false;
}
