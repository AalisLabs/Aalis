import type { ConfigSchema, Context } from '@aalis/core';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import type { VectorSearchResult, VectorStoreService } from '@aalis/plugin-vectorstore-api';
import { type Connection, connect, type Table as LanceTable } from '@lancedb/lancedb';

function toUri(input: string): string {
  const s = String(input ?? '').trim();
  if (!s) return 'data:/lancedb';
  if (s.includes(':/')) return s;
  const cleaned = s.replace(/^\.?\/+/, '');
  const idx = cleaned.indexOf('/');
  return idx > 0 ? `${cleaned.slice(0, idx)}:/${cleaned.slice(idx + 1)}` : `data:/${cleaned}`;
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-vectorstore-lancedb';
export const displayName = 'LanceDB 向量库';
export const subsystem = 'embedding';
export const provides = ['vectorstore'];

export const configSchema: ConfigSchema = {
  path: {
    type: 'string',
    label: '数据库目录',
    default: 'data:/lancedb',
    description: 'LanceDB 数据存储 storage URI（也兼容裸名/相对路径）',
  },
  tableName: { type: 'string', label: '表名', default: 'vectors', description: '向量表名称' },
};

export const defaultConfig = {
  path: 'data:/lancedb',
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
  /** 首次建表的 single-flight promise：并发 add 复用它，避免「table already exists」丢向量 */
  private tableInit: Promise<LanceTable> | null = null;
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
      // single-flight 建表：并发 add（索引 concurrency=10 + embed I/O 让出事件循环）会同时进此分支；
      // 旧实现各自 createTable → 第二个抛「table already exists」被吞、向量永久丢失。复用同一 promise，
      // 首条随建表写入，其余等建表完成后 add 自己。
      if (!this.tableInit) {
        this.tableInit = this.db.createTable(this.tableName, [record]);
        this.table = await this.tableInit;
        this.logger?.info(`LanceDB 表 "${this.tableName}" 已创建`);
        return; // 首条已随 createTable 落库
      }
      await this.tableInit; // 并发后续条目：等建表完成再 add 自己
    }
    await this.table!.add([record]);
  }

  async search(queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
    if (!this.table) return [];

    const count = await this.table.countRows();
    if (count === 0) return [];

    // 显式用余弦度量：默认是 L2，1-L2 既非相似度也与 flat 后端（归一化点积=余弦）量纲不一致，
    // 会让 memory-vector 的 minScore 阈值与时间加权融合在两后端含义不同。余弦距离 = 1-余弦相似度，
    // 故下面 1 - _distance = 余弦相似度，与 flat 完全一致（余弦 scale-invariant，无需归一化）。
    const results = await this.table.query().nearestTo(queryVector).distanceType('cosine').limit(topK).toArray();

    return results.map(row => ({
      score: 1 - (row._distance ?? 0),
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
    this.tableInit = null; // 必须与 table 同步重置，否则下次 add 会 await 到指向已删表的旧 promise → 崩
    // 删除旧表并重置
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(this.tableName)) {
      await this.db.dropTable(this.tableName);
    }
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    if (!this.table) return 0;
    const before = await this.table.countRows();
    if (before === 0) return 0;
    // LanceDB 的 metadata 存储在 metadata_json 字段中，需要通过全表扫描过滤
    // 读取全部记录，过滤后重建表
    const allRows = await this.table.query().toArray();
    const keep = allRows.filter(row => {
      const meta = JSON.parse(row.metadata_json as string) as Record<string, unknown>;
      // 保留条件：filter 中任一 key 不匹配则保留（即全部匹配才删除）
      return Object.entries(filter).some(([key, value]) => meta[key] !== value);
    });
    const deleted = before - keep.length;
    if (deleted > 0 && keep.length > 0) {
      // 将 Arrow 格式行转换为纯 JS 对象，避免 schema 推断失败
      const plainRows = keep.map(row => ({
        vector: Array.from(row.vector as Iterable<number>),
        metadata_json: row.metadata_json as string,
      }));
      // 重建表
      this.table.close();
      await this.db.dropTable(this.tableName);
      this.table = await this.db.createTable(this.tableName, plainRows);
    } else if (deleted > 0 && keep.length === 0) {
      await this.clear();
    }
    return deleted;
  }

  async save(): Promise<void> {
    // LanceDB 自动持久化，无需手动 save
  }

  async close(): Promise<void> {
    if (this.table) {
      this.table.close();
      this.table = null;
    }
    this.tableInit = null;
  }
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const cfg: LanceDBConfig = {
    path: (config.path as string) ?? 'data:/lancedb',
    tableName: (config.tableName as string) ?? 'vectors',
  };

  const storage = createStorageGateway(ctx);
  const dbUri = toUri(cfg.path);
  if (!storage.resolveLocalPath) {
    ctx.logger.error('存储实现未提供 resolveLocalPath 能力，无法初始化 LanceDB');
    return;
  }
  const dbPath = await storage.resolveLocalPath(dbUri, 'write');
  const store = new LanceDBVectorStore(dbPath, cfg.tableName, ctx.logger);

  await store.init();

  const count = await store.size();
  ctx.logger.info(`LanceDB 向量数据库已加载: ${count} 条记录, URI=${dbUri}, 表=${cfg.tableName}`);

  ctx.provide('vectorstore', store, { priority: 10 });

  ctx.onDispose(async () => {
    await store.close();
  });
}
