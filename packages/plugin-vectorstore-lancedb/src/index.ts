import { connect, type Connection, type Table as LanceTable } from '@lancedb/lancedb';
import { resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import type { Context, VectorStoreService, VectorSearchResult, ConfigSchema } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-vectorstore-lancedb';
export const provides = ['vectorstore'];

export const configSchema: ConfigSchema = {
  path: { type: 'string', label: '数据库目录', default: 'data/lancedb' },
  tableName: { type: 'string', label: '表名', default: 'vectors' },
};

export const defaultConfig = {
  path: 'data/lancedb',
  tableName: 'vectors',
};

// ===== 配置 =====

interface LanceDBConfig {
  /** 数据库存储目录 */
  path: string;
  /** 表名 */
  tableName: string;
}

// ===== LanceDB 向量存储实现 =====

class LanceDBVectorStore implements VectorStoreService {
  private db!: Connection;
  private table: LanceTable | null = null;
  private readonly dbPath: string;
  private readonly tableName: string;
  private logger?: { info: (msg: string, ...a: unknown[]) => void; warn: (msg: string, ...a: unknown[]) => void };

  constructor(dbPath: string, tableName: string, logger?: LanceDBVectorStore['logger']) {
    this.dbPath = dbPath;
    this.tableName = tableName;
    this.logger = logger;
  }

  /** 初始化连接（必须在使用前调用） */
  async init(): Promise<void> {
    if (!existsSync(this.dbPath)) {
      mkdirSync(this.dbPath, { recursive: true });
    }

    this.db = await connect(this.dbPath);

    // 尝试打开已有表
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);
    }
  }

  async add(vector: number[], metadata: Record<string, unknown>): Promise<void> {
    const record = {
      vector,
      metadata_json: JSON.stringify(metadata),
    };

    if (!this.table) {
      // 首次写入时创建表
      this.table = await this.db.createTable(this.tableName, [record]);
      this.logger?.info(`LanceDB 表 "${this.tableName}" 已创建`);
    } else {
      await this.table.add([record]);
    }
  }

  async search(queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
    if (!this.table) return [];

    const count = await this.table.countRows();
    if (count === 0) return [];

    const results = await this.table
      .search(queryVector)
      .limit(topK)
      .toArray();

    return results.map(row => ({
      score: 1 - (row._distance ?? 0), // LanceDB 返回 L2 距离，转换为相似度
      metadata: JSON.parse(row.metadata_json as string) as Record<string, unknown>,
    }));
  }

  async size(): Promise<number> {
    if (!this.table) return 0;
    return this.table.countRows();
  }

  async clear(): Promise<void> {
    if (this.table) {
      this.table.close();
      this.table = null;
    }
    // 删除旧表并重置
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(this.tableName)) {
      await this.db.dropTable(this.tableName);
    }
  }

  async save(): Promise<void> {
    // LanceDB 自动持久化，无需手动 save
  }

  async close(): Promise<void> {
    if (this.table) {
      this.table.close();
      this.table = null;
    }
  }
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const cfg: LanceDBConfig = {
    path: (config.path as string) ?? 'data/lancedb',
    tableName: (config.tableName as string) ?? 'vectors',
  };

  const dbPath = resolve(ctx.config.getConfigDir(), cfg.path);
  const store = new LanceDBVectorStore(dbPath, cfg.tableName, ctx.logger);

  await store.init();

  const count = await store.size();
  ctx.logger.info(`LanceDB 向量数据库已加载: ${count} 条记录, 路径=${dbPath}, 表=${cfg.tableName}`);

  ctx.provide('vectorstore', store, {
    capabilities: ['search', 'persistence', 'ann_index'],
    priority: 10, // 优先级高于 flat 实现
  });

  ctx.on('dispose', async () => {
    await store.close();
  });
}
