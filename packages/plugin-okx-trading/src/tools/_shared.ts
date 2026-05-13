import type { ScopedToolService } from '@aalis/plugin-tools-api';

export type RegFn = ScopedToolService['register'];

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
