// ============================================================
// @aalis/util-bounded-map — 有界 Map：max 上限 + 可选滑动 TTL + onEvict
//
// 治理"裸 Map 只增不清"的进程内瞬态缓存：必填 max 作护栏，超限逐出最久未访问的；
// 可选 ttlMs 做滑动过期（get/set 刷新），过期条目在 get/values 时惰性逐出——
// 不开后台 sweeper（sweeper 自身会成泄漏源），不引第三方依赖。
//
// 仅适用于【派生/可重算/可丢】的缓存；权威状态（丢了改行为）不要用它。
// ============================================================

export interface BoundedMapOptions<K, V> {
  /** 最多保留的条目数（必填）。超出时逐出"最久未访问"的条目。 */
  max: number;
  /** 可选滑动 TTL（毫秒）：每次 get/set 刷新过期时刻；过期条目在 get/values 时惰性逐出。 */
  ttlMs?: number;
  /** 可选：条目被逐出（超限/过期/delete/clear）时回调，用于释放底层资源（如句柄）。 */
  onEvict?: (value: V, key: K) => void;
}

export interface BoundedMap<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
  /** 当前未过期条目的值（顺带惰性清理过期项）。 */
  values(): V[];
  readonly size: number;
}

/**
 * 创建一个有界 Map。Map 自身保持插入序 → 队首即"最久未访问"；
 * get/set 命中时把条目移到队尾（LRU），故超限逐出队首是真正的冷条目。
 */
export function createBoundedMap<K, V>(opts: BoundedMapOptions<K, V>): BoundedMap<K, V> {
  const { max, ttlMs, onEvict } = opts;
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error(`createBoundedMap: max 必须为正数，收到 ${max}`);
  }
  const store = new Map<K, { value: V; expireAt: number }>();

  const isExpired = (e: { expireAt: number }): boolean => ttlMs !== undefined && e.expireAt <= Date.now();

  const evict = (key: K, e: { value: V; expireAt: number }): void => {
    store.delete(key);
    onEvict?.(e.value, key);
  };

  return {
    get(key: K): V | undefined {
      const e = store.get(key);
      if (e === undefined) return undefined;
      if (isExpired(e)) {
        evict(key, e);
        return undefined;
      }
      // LRU + 滑动 TTL：移到队尾（最近）并刷新过期时刻
      store.delete(key);
      if (ttlMs !== undefined) e.expireAt = Date.now() + ttlMs;
      store.set(key, e);
      return e.value;
    },

    set(key: K, value: V): void {
      if (store.has(key)) store.delete(key); // 重设：移到队尾
      store.set(key, { value, expireAt: ttlMs !== undefined ? Date.now() + ttlMs : Number.POSITIVE_INFINITY });
      // 超上限：逐出队首（最久未访问）
      while (store.size > max) {
        const oldestKey = store.keys().next().value as K;
        const oldest = store.get(oldestKey);
        if (oldest === undefined) break;
        evict(oldestKey, oldest);
      }
    },

    delete(key: K): boolean {
      const e = store.get(key);
      if (e === undefined) return false;
      evict(key, e);
      return true;
    },

    clear(): void {
      if (onEvict) for (const [k, e] of store) onEvict(e.value, k);
      store.clear();
    },

    values(): V[] {
      const out: V[] = [];
      for (const [k, e] of [...store]) {
        if (isExpired(e)) evict(k, e);
        else out.push(e.value);
      }
      return out;
    },

    get size(): number {
      return store.size;
    },
  };
}
