import type { ConfigSchema, Context } from '@aalis/core';
import { createStorageGateway, type StorageService } from '@aalis/plugin-storage-api';
import type { VectorSearchResult, VectorStoreService } from '@aalis/plugin-vectorstore-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-vectorstore-flat';
export const displayName = 'Flat 向量库';
export const subsystem = 'embedding';
export const provides = ['vectorstore'];

export const configSchema: ConfigSchema = {
  path: {
    type: 'string',
    label: '存储目录',
    default: 'data:/vectorstore',
    description: 'JSON 向量文件存储目录（storage URI）。也兼容旧格式 “data/vectorstore”。',
  },
};

export const defaultConfig = {
  path: 'data:/vectorstore',
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
      this.entries = JSON.parse(raw);
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
    if (!this.dirty) return;
    try {
      await this.storage.writeFile(this.dataUri, JSON.stringify(this.entries));
      this.dirty = false;
    } catch (err) {
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
  function toUri(input: string): string {
    if (input.includes(':/')) return input;
    const s = input.trim().replace(/^\.?\/+/, '');
    const idx = s.indexOf('/');
    return idx > 0 ? `${s.slice(0, idx)}:/${s.slice(idx + 1)}` : `${s}:/`;
  }

  const dirUri = toUri(storeConfig.path);
  const dataUri = dirUri.endsWith('/') ? `${dirUri}vectors.json` : `${dirUri}/vectors.json`;
  const storage = createStorageGateway(ctx);
  const store = new FlatVectorStore(storage, dataUri, ctx.logger);
  await store.init();

  ctx.logger.info(`向量数据库已加载: ${await store.size()} 条记录, 存储 URI=${dataUri}`);

  ctx.provide('vectorstore', store);

  ctx.onDispose(() => {
    void store.save();
  });
}
