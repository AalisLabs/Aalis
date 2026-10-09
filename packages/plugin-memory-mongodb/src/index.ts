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
import { type Message, WellKnownMetadataKeys } from '@aalis/schema-message';
import { type Collection, type Db, MongoClient } from 'mongodb';

const configSchema = defineConfig({
  uri: {
    type: 'string',
    label: 'MongoDB URI',
    required: true,
    default: 'mongodb://localhost:27017',
    onInvalid: 'error',
    secret: true,
    description: 'MongoDB 连接字符串（可能带账号密码，存进 secrets.yaml，WebUI 不回显）',
  },
  database: {
    type: 'string',
    label: '数据库名',
    default: '',
    onInvalid: 'error',
    description:
      '存储消息历史与元数据（固定名为 metadata 的集合）的数据库。留空按家目录与实例派生：主家目录用 aalis，' +
      'profile 家目录（~/.aalis-<profile>）用 aalis_<profile>；带后缀的实例再加后缀（如 `:b` 实例用 aalis-b、aalis_<profile>_b）。' +
      '同一连接串下两个实例不能用同一个库，后激活的那个会报配置错误；库里记着它归哪个家目录，别的家目录连上来也会报错',
  },
  claimFrom: {
    type: 'string',
    label: '认领库的归属',
    default: '',
    onInvalid: 'error',
    description:
      '平时留空。库已归另一个家目录（例如家目录搬了位置）时，先停掉那个家目录的实例，再填它的路径；' +
      '库里已有数据却还没有归属记录时填 unowned。启动一次就把归属改到这个家目录，认领后删掉这一项：' +
      '留着的 unowned 会让以后指向的任何库都跳过「已有数据」的检查',
  },
  collection: { type: 'string', label: '集合名', default: 'messages', onInvalid: 'error', description: '消息集合名称' },
  connectTimeoutMs: {
    type: 'number',
    label: '连接超时（毫秒）',
    default: 5000,
    description: '建立连接与服务器选择（serverSelection）的超时时间，两者共用此值',
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
    // sort 必须带 _id 次键：同毫秒写入的消息（如同一轮的 assistant+tool 合成对）
    // 在纯 timestamp 排序下平票顺序不稳定，读回时 tool 可能排到 assistant 前面，
    // 被 sanitizeToolCallHistory 当作孤儿整组丢弃。_id 单调递增即插入序。
    const docs = await this.collection
      .find({ sessionId, archived: { $ne: true } })
      .sort({ timestamp: -1, _id: -1 })
      .limit(limit)
      .toArray();
    docs.reverse();
    return docs.map(doc => this.docToMessage(doc));
  }

  async getFullHistory(sessionId: string, limit = 200): Promise<Message[]> {
    // 同 getHistory：_id 次键保证同毫秒消息按插入序稳定返回
    const docs = await this.collection.find({ sessionId }).sort({ timestamp: -1, _id: -1 }).limit(limit).toArray();
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
    const limit = Math.max(1, Math.min(query.limit, this.crossSessionMaxLimit));
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
    const docs = await this.collection
      .find({ sessionId, content: { $regex: oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } })
      .sort({ timestamp: -1 })
      .limit(recentLimit)
      .toArray();
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
  displayName: 'MongoDB 记忆',
  subsystem: 'memory',
  configSchema,
  reusable: true,
  provides: [memory],
  uses,
  apply: connectAndProvide,
});

async function connectAndProvide(caps: Caps): Promise<void> {
  const { logger, lifecycle, provide } = caps;
  const cfg = parseConfig(configSchema, caps.config, logger);
  const mongoConfig: MongoMemoryConfig = { ...cfg, database: cfg.database.trim(), claimFrom: cfg.claimFrom.trim() };

  logger.info(`正在连接 MongoDB: ${redactMongoUri(mongoConfig.uri)} (超时: ${mongoConfig.connectTimeoutMs}ms)`);

  const client = new MongoClient(mongoConfig.uri, {
    serverSelectionTimeoutMS: mongoConfig.connectTimeoutMs,
    connectTimeoutMS: mongoConfig.connectTimeoutMs,
  });
  await openAndProvide(client, mongoConfig, { logger, lifecycle, provide }, caps.paths.current);
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
  const { suffix } = parseInstanceId(lifecycle.id);
  const database = mongoConfig.database || deriveDatabase(owner?.profile, suffix);
  if (Buffer.byteLength(database) > 63) {
    throw configError(`MongoDB 库名 ${database} 超过 63 字节的上限：请给 ${lifecycle.id} 另配一个短些的 database`);
  }
  const location = `${mongoConfig.uri}\n${database}`;
  const holder = openedBy.get(location);
  if (holder && holder.id !== lifecycle.id) {
    throw configError(
      `MongoDB 库 ${database} 已被实例 ${holder.id} 使用（同一连接串），两个实例不能共用一个库：请给 ${lifecycle.id} 另配 database`,
    );
  }
  openedBy.set(location, lifecycle);
  lifecycle.onDispose(() => {
    if (openedBy.get(location) === lifecycle) openedBy.delete(location);
  });

  // 监听器同步执行、不得抛错：close 的拒绝吞掉
  const onAbort = (): void => void client.close().catch(() => {});
  lifecycle.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect();
    // mongodb+srv 在 SRV 解析期间 close 不生效，连接会在 abort 之后照常建成：由这里抛出、下方 catch 关闭
    lifecycle.signal.throwIfAborted();
    const db: Db = client.db(database);
    const collection = db.collection<MessageDocument>(mongoConfig.collection!);
    const metaCollection = db.collection<MetadataDocument>('metadata');

    await metaCollection.createIndex({ namespace: 1, key: 1 }, { unique: true });
    if (owner)
      await claimOwnership(
        db,
        metaCollection,
        { home: owner.home, instance: lifecycle.id },
        database,
        mongoConfig.claimFrom ?? '',
        logger,
      );
    lifecycle.signal.throwIfAborted();

    // 创建索引
    await collection.createIndex({ sessionId: 1, timestamp: 1 });
    await collection.createIndex({ archived: 1, timestamp: -1 });
    await collection.createIndex({ [`metadata.${WellKnownMetadataKeys.Platform}`]: 1, timestamp: -1 });
    lifecycle.signal.throwIfAborted();

    const service = new MongoMemoryService(collection, metaCollection, {
      rangeQueryLimit: mongoConfig.rangeQueryLimit,
      crossSessionMaxLimit: mongoConfig.crossSessionMaxLimit,
      logger,
    });
    provide(memory, service, {
      // priority 与同类 memory provider 自文档化对照：
      //   sqlite=10（零配置默认）, mongodb=5（需服务，但更强）, inmemory=-100（仅测试）
      // 用户通过 servicePreferences 显式偏好时该字段不影响选择。
      priority: 5,
    });

    logger.info(`MongoDB 已连接: ${database}/${mongoConfig.collection}`);

    // 连接握手跨 await，关闭可能已开始；迟到的清理照样被执行
    lifecycle.onDispose(async () => {
      await client.close();
      logger.info('MongoDB 连接已关闭');
    }, 'mongodb:client.close');
  } catch (err) {
    await client.close().catch(() => {});
    // 库的归属不对是配置问题，不是连接失败：原样抛出，宿主按配置错误报一行
    if ((err as { name?: unknown } | null)?.name === 'ConfigError') throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`MongoDB 连接失败（确认 MongoDB 在运行、配置项 uri 写对）: ${message}`, { cause: err });
  } finally {
    lifecycle.signal.removeEventListener('abort', onAbort);
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
      throw configError(
        `MongoDB 库 ${database} 里已有数据，但没有记录它归哪个家目录。若这就是本家目录的数据，在 ${me.instance} 的配置里写 claimFrom: unowned 后重启认领；否则给它另配 database`,
      );
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
      `MongoDB 库 ${database} 的归属记录坏了（metadata 集合里命名空间 ${OWNER_NAMESPACE}、键 ${OWNER_KEY} 的那条缺家目录或实例）。` +
        `确认这是本家目录的数据后，在 ${me.instance} 的配置里写 claimFrom: unowned 后重启认领；否则给它另配 database`,
    );
  }
  if (owner.home === me.home) {
    throw configError(
      `MongoDB 库 ${database} 归本家目录的实例 ${owner.instance}，两个实例不能共用一个库：请给 ${me.instance} 另配 database。` +
        `若是实例改了名、要把库转给 ${me.instance}，先停掉 ${owner.instance}，再写 claimFrom: ${owner.home} 后重启认领`,
    );
  }
  throw configError(
    `MongoDB 库 ${database} 已归家目录 ${owner.home}（实例 ${owner.instance}）。` +
      `若本家目录是从那里搬来的，先停掉那个家目录的实例，再在 ${me.instance} 的配置里写 claimFrom: ${owner.home} 后重启认领；否则给它另配 database`,
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
