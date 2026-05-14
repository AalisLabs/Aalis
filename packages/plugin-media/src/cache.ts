// ============================================================
// cache.ts — 图片描述 LRU 缓存（24h TTL，1000 条上限）
//
// 同一张图片在多处被引用（聊天 + analyze_image + 引用消息）时
// 复用 vision 识别结果。key 是 url / data uri / 本地路径。
// ============================================================

interface CachedDescription {
  desc: string;
  expiresAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ENTRIES = 1000;

const cache = new Map<string, CachedDescription>();

/** 写入缓存（空串、占位符 `[图片: ...]` 不缓存）。 */
export function rememberDescription(key: string, raw: string): void {
  if (!raw) return;
  if (raw.startsWith('[图片:') || raw.startsWith('[动图:')) return;
  if (cache.size >= MAX_ENTRIES) {
    // 简单 LRU：删除最早插入项
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { desc: raw, expiresAt: Date.now() + TTL_MS });
}

/** 查询缓存。命中且未过期返回字符串，否则返回 null。 */
export function lookupCachedDescription(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.desc;
}
