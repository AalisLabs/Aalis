import type { ScopedToolService } from '@aalis/plugin-tools-api';

export type RegFn = ScopedToolService['register'];

/** 分页 limit 参数的 default 与硬上限（OKX API 单页一般 100，个别 300）。 */
export interface PageLimitCfg {
  defaultLimit: number;
  maxLimit: number;
}

/** 从 args.limit 中读取并按 cfg cap。未传或非法值时走 default。 */
export function pickLimit(args: { limit?: unknown }, cfg: PageLimitCfg): number {
  const raw = Number(args.limit);
  const v = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : cfg.defaultLimit;
  return Math.max(1, Math.min(cfg.maxLimit, v));
}

/** 安全截断工具结果，避免长数据撑爆上下文 */
export function truncate(data: unknown, maxItems = 20): unknown {
  if (Array.isArray(data) && data.length > maxItems) {
    return [...data.slice(0, maxItems), `...（共 ${data.length} 条，已截断）`];
  }
  return data;
}

export function errJson(e: unknown): string {
  return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
}
