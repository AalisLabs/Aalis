import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Context, VectorStoreService, VectorSearchResult, ConfigSchema } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-vectorstore-flat';
export const provides = ['vectorstore'];

export const configSchema: ConfigSchema = {
  path: { type: 'string', label: '存储目录', default: 'data/vectorstore', description: 'JSON 向量文件存储目录' },
};

export const defaultConfig = {
  path: 'data/vectorstore',
};

// ===== 配置 =====

interface VectorStoreConfig {
  /** 数据存储目录 */
  path: string;
}

// ===== 向量计算 =====

function dotProduct(a: number[], b: number[]): number {
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

class FlatVectorStore implements VectorStoreService {
  private entries: StoredEntry[] = [];
  private readonly dataPath: string;
  private dirty = false;

  constructor(private readonly storagePath: string, private readonly logger?: { warn: (msg: string, ...args: unknown[]) => void }) {
    this.dataPath = resolve(storagePath, 'vectors.json');

    try {
      if (!existsSync(storagePath)) {
        mkdirSync(storagePath, { recursive: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`无法创建存储目录 ${storagePath}: ${msg}`);
    }

    try {
      if (existsSync(this.dataPath)) {
        this.entries = JSON.parse(readFileSync(this.dataPath, 'utf-8'));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`向量数据文件损坏，将从空数据开始: ${msg}`);
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

  async search(queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
    if (this.entries.length === 0) return [];
    const q = normalize(queryVector);

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
      writeFileSync(this.dataPath, JSON.stringify(this.entries));
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
    path: (config.path as string) ?? 'data/vectorstore',
  };

  const storagePath = resolve(ctx.config.getConfigDir(), storeConfig.path);
  const store = new FlatVectorStore(storagePath, ctx.logger);

  ctx.logger.info(`向量数据库已加载: ${await store.size()} 条记录, 存储路径=${storagePath}`);

  ctx.provide('vectorstore', store, {
    capabilities: ['search', 'persistence'],
  });

  ctx.on('dispose', () => {
    store.save();
  });
}
