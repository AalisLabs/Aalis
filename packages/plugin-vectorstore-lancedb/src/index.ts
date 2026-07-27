import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/plugin-config-api';
import { createStorageGateway, toStorageUri } from '@aalis/plugin-storage-api';
import type { VectorSearchResult, VectorStoreService } from '@aalis/plugin-vectorstore-api';
import { type Connection, connect, type Table as LanceTable } from '@lancedb/lancedb';

function toUri(input: string): string {
  const s = String(input ?? '').trim();
  return s ? toStorageUri(s) : 'data:/lancedb';
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
  optimizeEvery: {
    type: 'number',
    label: '压实间隔',
    default: 500,
    description:
      '每写入多少条向量后后台压实一次（合并碎片 + 回收作废数据文件）。LanceDB 每次 add 产生一个新碎片与版本，' +
      '不压实会让 data/ 与 _versions/ 无界膨胀、写入越来越慢；设 0 关闭',
  },
  cleanupRetentionMinutes: {
    type: 'number',
    label: '数据文件保留窗（分钟）',
    default: 60,
    description:
      '压实时回收「此分钟数以前」的作废数据文件。比它更新的文件（含可能在途的写入）一律保留，故对单进程写入安全。' +
      '默认 LanceDB 保留 7 天，高频压实下会让 data/ 累到数百 GB —— 收紧到分钟级即可把库压回真实大小。调大更保守、更占盘。',
  },
};

export const defaultConfig = {
  path: 'data:/lancedb',
  tableName: 'vectors',
  optimizeEvery: 500,
  cleanupRetentionMinutes: 60,
};

// ===== 配置 =====

interface LanceDBConfig {
  /** 数据库存储目录 */
  path: string;
  /** 表名 */
  tableName: string;
  /** 每写入多少条后台压实一次；<=0 关闭 */
  optimizeEvery: number;
  /** 压实时回收多久以前的作废数据文件（分钟）；带时间缓冲保护在途写入 */
  cleanupRetentionMinutes: number;
}

/**
 * 构造匹配 metadata_json 里某个 JSON 字段的 SQL LIKE 谓词（供 LanceDB 原生 delete 用，不载入 JS）。
 * metadata 以紧凑 JSON.stringify 存于 metadata_json 字符串列，字段形如 `"key":<json值>`，其后必跟 `,` 或 `}`。
 * 故按 `"key":<json值>` + 边界 子串匹配：字符串值自带引号（自定界），数字值靠尾随 `,`/`}` 定界，
 * 杜绝「"timestamp":1751 误配 17510」这类数字前缀误删。转义 LIKE 特殊字符（\ % _）与 SQL 单引号。
 */
export function metaJsonFieldPredicate(key: string, value: unknown): string {
  const kv = `"${key}":${JSON.stringify(value)}`;
  const esc = (s: string): string => s.replace(/([\\%_])/g, '\\$1').replace(/'/g, "''");
  const e = esc(kv);
  return `(metadata_json LIKE '%${e},%' ESCAPE '\\' OR metadata_json LIKE '%${e}}%' ESCAPE '\\')`;
}

// ===== LanceDB 向量存储实现 =====

class LanceDBVectorStore implements VectorStoreService {
  private db!: Connection;
  private table: LanceTable | null = null;
  /** 首次建表的 single-flight promise：并发 add 复用它，避免「table already exists」丢向量 */
  private tableInit: Promise<LanceTable> | null = null;
  private readonly dbPath: string;
  private readonly tableName: string;
  /** 每写入多少条后台压实一次；<=0 关闭 */
  private readonly optimizeEvery: number;
  /** 压实时回收多久以前的旧数据文件（分钟）。带时间缓冲，保护可能在途的写入/读取；见 maybeOptimize。 */
  private readonly cleanupRetentionMs: number;
  /** 自上次压实以来的写入计数 */
  private addsSinceOptimize = 0;
  /** 压实 single-flight：在途压实期间跳过新一轮，避免叠加（LanceDB 压实与并发写本身安全） */
  private optimizing: Promise<void> | null = null;
  /**
   * 结构性表操作串行锁。optimize / deleteByFilter / clear 都会重建或压实整张表文件，
   * 彼此并发会踩踏同一表目录 —— 典型即「后台压实与 /clear 的 dropTable+createTable 重叠」，
   * 导致向量删除不生效（旧向量残留被继续召回）甚至表损坏。三者一律排到本链上串行执行。
   */
  private structuralOps: Promise<unknown> = Promise.resolve();
  private logger?: { info: (msg: string, ...a: unknown[]) => void; warn: (msg: string, ...a: unknown[]) => void };

  constructor(
    dbPath: string,
    tableName: string,
    optimizeEvery: number,
    cleanupRetentionMinutes: number,
    logger?: LanceDBVectorStore['logger'],
  ) {
    this.dbPath = dbPath;
    this.tableName = tableName;
    this.optimizeEvery = optimizeEvery;
    this.cleanupRetentionMs = Math.max(1, cleanupRetentionMinutes) * 60_000;
    this.logger = logger;
  }

  /** 把结构性表操作排到同一条串行链上执行，杜绝压实与重建互相踩踏。 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.structuralOps.then(fn, fn);
    this.structuralOps = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    this.maybeOptimize();
  }

  /**
   * 达到间隔阈值后后台压实：合并每条 add 产生的碎片，并回收 cleanupRetentionMinutes 以前的作废数据文件
   * （见 optimize 调用处注释——不显式传窗口会吃默认 7 天保留、data/ 膨胀到数百 GB）。
   * 不 await（不阻塞写入延迟）、single-flight（在途压实期间跳过）、经 serialize 与 delete/clear 互斥、
   * 吞错（压实失败不影响写入，下轮重试）。
   */
  private maybeOptimize(): void {
    if (this.optimizeEvery <= 0 || this.optimizing) return;
    if (++this.addsSinceOptimize < this.optimizeEvery) return;
    this.addsSinceOptimize = 0;
    if (!this.table) return;
    // 经串行锁执行：与 deleteByFilter/clear 互斥。锁内读 this.table（而非捕获旧引用），
    // 确保压实的是当前表——若排队期间 /clear 重建了表，则压实新表；若表已被清空则跳过。
    this.optimizing = this.serialize(async () => {
      const t = this.table;
      if (!t) return null;
      // 关键：显式传 cleanupOlderThan（否则吃默认 7 天保留窗 → 压实作废的数据文件要留 7 天，
      // 高频压实下 data/ 累到数百 GB）。cleanupOlderThan = 现在 - 保留窗，deleteUnverified 才能真正
      // 回收 <7 天的作废文件。保留窗留足时间缓冲：比它更新的文件(含可能在途写入)一律不动，故对
      // Aalis 单进程写入安全。回收现在-保留窗之前的全部作废数据文件。
      return t.optimize({ cleanupOlderThan: new Date(Date.now() - this.cleanupRetentionMs), deleteUnverified: true });
    })
      .then(stats => {
        if (!stats) return;
        const removed = stats.compaction.fragmentsRemoved;
        const freedMB = Math.round(stats.prune.bytesRemoved / 1024 / 1024);
        if (removed > 0 || freedMB > 0) {
          this.logger?.info(
            `LanceDB 压实完成：合并 ${removed} 碎片、清理 ${stats.prune.oldVersionsRemoved} 旧版本、回收 ${freedMB} MB`,
          );
        }
      })
      .catch(err => {
        this.logger?.warn(
          `LanceDB 压实失败（不影响写入，下轮重试）：${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.optimizing = null;
      });
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

  /** 内部清空（不加串行锁）：供已持锁的 deleteByFilter 复用，避免自锁死。 */
  private async clearInternal(): Promise<void> {
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

  async clear(): Promise<void> {
    await this.serialize(() => this.clearInternal());
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    // 走串行锁：与后台压实/clear 互斥。用 LanceDB 原生 delete(SQL 谓词) 原地删除 ——
    // 绝不把整表读进 JS。旧实现 query().toArray() 全表载入 + 复制重建，在大库（十万+条向量）上
    // 直接 OOM 硬崩（进程被杀、不留日志、终端未复原），且逐轮回滚会 N 次触发。改原生删除后无此风险。
    return this.serialize(async () => {
      if (!this.table) return 0;
      const clauses = Object.entries(filter).map(([key, value]) => metaJsonFieldPredicate(key, value));
      if (clauses.length === 0) return 0; // 空过滤器不删（防误清全库）
      const before = await this.table.countRows();
      if (before === 0) return 0;
      await this.table.delete(clauses.join(' AND '));
      const after = await this.table.countRows();
      return before - after;
    });
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
    optimizeEvery: (config.optimizeEvery as number) ?? 500,
    cleanupRetentionMinutes: (config.cleanupRetentionMinutes as number) ?? 60,
  };

  const storage = createStorageGateway(ctx);
  const dbUri = toUri(cfg.path);
  if (!storage.resolveLocalPath) {
    ctx.logger.error('存储实现未提供 resolveLocalPath 能力，无法初始化 LanceDB');
    return;
  }
  const dbPath = await storage.resolveLocalPath(dbUri, 'write');
  const store = new LanceDBVectorStore(
    dbPath,
    cfg.tableName,
    cfg.optimizeEvery,
    cfg.cleanupRetentionMinutes,
    ctx.logger,
  );

  await store.init();

  const count = await store.size();
  ctx.logger.info(`LanceDB 向量数据库已加载: ${count} 条记录, URI=${dbUri}, 表=${cfg.tableName}`);

  ctx.provide('vectorstore', store, { priority: 10 });

  ctx.onDispose(async () => {
    await store.close();
  });
}
