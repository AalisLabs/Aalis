import { createStorageGateway, type StorageService, toStorageUri } from '@aalis/api-storage';
import type { VectorSearchResult, VectorStoreService } from '@aalis/api-vectorstore';
import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-vectorstore-flat';
export const displayName = 'Flat 向量库';
export const subsystem = 'embedding';
export const provides = ['vectorstore'];
// storage 是必需依赖而非可选：向量全部存在 storage 上的 vectors.json 里，没有 storage
// 连冷启动读取都做不到，更不可能落盘。声明 required 同时挣到停机拓扑保证——
// 消费者先关、提供者后关，flat 的 onDispose 落盘时 storage 一定还在。
export const inject = {
  required: ['storage'],
};

export const configSchema: ConfigSchema = {
  path: {
    type: 'string',
    label: '存储目录',
    default: 'data:/vectorstore',
    description: 'JSON 向量文件存储目录（storage URI）。也兼容旧格式 “data/vectorstore”。',
  },
};

// ===== 配置 =====

interface VectorStoreConfig {
  /** 数据存储目录 */
  path: string;
}

// ===== 向量计算 =====

function dotProduct(a: number[], b: number[]): number {
  // 维度不一致（多半换了 embedding 模型却复用旧库）→ 返回 -Infinity 而非读越界产 NaN：
  // 不匹配项自然排到末尾、并被下游 minScore 过滤掉，不污染排序、不静默清空。
  if (a.length !== b.length) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map(v => v / norm);
}

// ===== 平面向量存储实现 =====

interface StoredEntry {
  vector: number[];
  metadata: Record<string, unknown>;
}

export class FlatVectorStore implements VectorStoreService {
  private entries: StoredEntry[] = [];
  private readonly storage: StorageService;
  private readonly dataUri: string;
  private dirty = false;
  /** 维度不匹配只告警一次，避免每次召回刷屏 */
  private warnedDimMismatch = false;
  /** save 串行链：并发索引会并发调 save()，串行化避免裸 writeFile 同路径并发写损坏 JSON */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    storage: StorageService,
    dataUri: string,
    private readonly logger?: { warn: (msg: string, ...args: unknown[]) => void },
  ) {
    this.storage = storage;
    this.dataUri = dataUri;
  }

  /** 启动加载（由 apply 调用） */
  async init(): Promise<void> {
    try {
      const raw = (await this.storage.readFile(this.dataUri, 'utf-8')) as string;
      const parsed = JSON.parse(raw);
      // 合法 JSON 但不是数组（被别的东西写过 / 手工改坏）→ 按空库处理并告警：
      // 否则 entries 变成对象，size() 返回 undefined、search() 在 entries[0] 上抛。
      if (!Array.isArray(parsed)) {
        this.logger?.warn(`向量数据文件不是数组（${typeof parsed}），将从空数据开始: ${this.dataUri}`);
        this.entries = [];
        return;
      }
      this.entries = parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 文件不存在 = 冷启动，不警告；其他错误才警
      if (!/ENOENT|not found|不存在/i.test(msg)) {
        this.logger?.warn(`向量数据文件损坏，将从空数据开始: ${msg}`);
      }
      this.entries = [];
    }
  }

  async size(): Promise<number> {
    return this.entries.length;
  }

  async add(vector: number[], metadata: Record<string, unknown>): Promise<void> {
    this.entries.push({ vector: normalize(vector), metadata });
    this.dirty = true;
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.dirty = true;
    await this.save();
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    // 空过滤器不删任何东西（防误清全库；与 lancedb 后端保护行为一致）。
    if (Object.keys(filter).length === 0) return 0;
    const before = this.entries.length;
    this.entries = this.entries.filter(e => {
      for (const [key, value] of Object.entries(filter)) {
        if (e.metadata[key] !== value) return true;
      }
      return false;
    });
    const deleted = before - this.entries.length;
    if (deleted > 0) this.dirty = true;
    return deleted;
  }

  async search(queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
    if (this.entries.length === 0) return [];
    const q = normalize(queryVector);

    // 维度不符：疑似更换了 embedding 模型却复用旧库。告警一次（可操作），不匹配项由 dotProduct 返回 -Infinity 自然剔除。
    if (q.length !== this.entries[0].vector.length && !this.warnedDimMismatch) {
      this.warnedDimMismatch = true;
      this.logger?.warn(
        `向量维度不匹配（查询 ${q.length} 维 vs 库 ${this.entries[0].vector.length} 维）：疑似更换了 embedding 模型，记忆召回将失效。请清空向量库（${this.dataUri}）后重建。`,
      );
    }

    const scored = this.entries.map(e => ({
      score: dotProduct(q, e.vector),
      metadata: e.metadata,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.min(topK, scored.length));
  }

  async save(): Promise<void> {
    // 串行化：并发索引（默认 concurrency=10）会并发调 save()，裸 writeFile 同路径并发写可交错损坏 JSON
    // → 下次 init 时 JSON.parse 失败、整库静默清空。链式确保同一时刻只有一个写在跑。
    this.saveChain = this.saveChain.then(() => this.doSave());
    return this.saveChain;
  }

  /**
   * 不变量：**本方法永不 reject**。
   *
   * save() 把它挂在 saveChain 上，而 `.then(onFulfilled)` 在已 rejected 的链上只会原样传递
   * 拒因、不再调用回调——一旦 doSave 抛一次，saveChain 就永久中毒，此后每次 save 都是空转，
   * 连 clear() 都写不出去（只能人工删 vectors.json）。所以整个方法体必须在 try 内：
   * JSON.stringify 会抛：entries 里混进不可序列化值（metadata 是 Record<string, unknown>，
   * BigInt 直接 TypeError、循环引用同理），或库涨到 V8 字符串上限（约 5.4 亿字符）时 RangeError。
   * 它此前在 try 之外。
   */
  private async doSave(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false; // 先清脏；期间新 add 会重新置脏，触发下一次链式 save
    try {
      const data = JSON.stringify(this.entries);
      await this.storage.writeFile(this.dataUri, data);
    } catch (err) {
      this.dirty = true; // 失败重标脏，下次重试
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`向量数据保存失败: ${msg}`);
    }
  }
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const storeConfig: VectorStoreConfig = {
    path: (config.path as string) ?? 'data:/vectorstore',
  };

  // 兼容旧格式 “data/vectorstore”
  const toUri = (input: string): string => toStorageUri(input);

  const dirUri = toUri(storeConfig.path);
  const dataUri = dirUri.endsWith('/') ? `${dirUri}vectors.json` : `${dirUri}/vectors.json`;
  const storage = createStorageGateway(ctx);
  const store = new FlatVectorStore(storage, dataUri, ctx.logger);
  await store.init();

  ctx.logger.info(`向量数据库已加载: ${await store.size()} 条记录, 存储 URI=${dataUri}`);

  ctx.provide('vectorstore', store);

  // 必须 await：onDispose 支持异步（同组 lancedb 就是 await close），
  // void 化会让停机时最后一批向量来不及落盘就退出。
  ctx.onDispose(async () => {
    await store.save();
  }, 'flat:store.save');
}
