// ============================================================
// cache.ts — 图片描述缓存（24h 滑动 TTL，1000 条上限）
//
// 同一张图片在多处被引用（聊天 + analyze_image + 引用消息 + 合并转发）时
// 复用 vision 识别结果。key 是 url / data uri / 本地路径——落盘附件是内容寻址
// 路径，归档路径与转发/工具路径因此共用同一键空间。
// 值**只存裸描述**：ref 标记等包装由各消费点按自己的形态重建，
// 存格式化文本会让另一侧拿到嵌套包装（[图片: [图片 | ref:...]]）。
// 用 @aalis/util-bounded-map（有界 + 滑动 TTL + LRU），不再手写 Map+FIFO。
// ============================================================

import { createBoundedMap } from '@aalis/util-bounded-map';

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ENTRIES = 1000;

const cache = createBoundedMap<string, string>({ max: MAX_ENTRIES, ttlMs: TTL_MS });

/** 写入缓存（空串、占位符 `[图片: ...]` 不缓存）。 */
export function rememberDescription(key: string, raw: string): void {
  if (!raw) return;
  if (raw.startsWith('[图片:') || raw.startsWith('[动图:')) return;
  cache.set(key, raw);
}

/** 查询缓存。命中且未过期返回字符串，否则返回 null（有界 Map 自行处理过期与淘汰）。 */
export function lookupCachedDescription(key: string): string | null {
  return cache.get(key) ?? null;
}
