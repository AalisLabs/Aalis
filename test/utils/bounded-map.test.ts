import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoundedMap } from '../../packages/util-bounded-map/src/index.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createBoundedMap', () => {
  it('max 必填且为正，否则抛错', () => {
    expect(() => createBoundedMap({ max: 0 })).toThrow();
    expect(() => createBoundedMap({ max: -1 })).toThrow();
  });

  it('超 max 逐出最久未访问的条目', () => {
    const m = createBoundedMap<string, number>({ max: 2 });
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3); // 逐出 a（最久未访问）
    expect(m.get('a')).toBeUndefined();
    expect(m.get('b')).toBe(2);
    expect(m.get('c')).toBe(3);
    expect(m.size).toBe(2);
  });

  it('get 刷新 LRU：访问过的不被优先逐出', () => {
    const m = createBoundedMap<string, number>({ max: 2 });
    m.set('a', 1);
    m.set('b', 2);
    m.get('a'); // a 移到最近
    m.set('c', 3); // 逐出最久未访问 = b（非 a）
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBeUndefined();
    expect(m.get('c')).toBe(3);
  });

  it('TTL 过期：get 惰性逐出并触发 onEvict', () => {
    vi.useFakeTimers();
    const onEvict = vi.fn();
    const m = createBoundedMap<string, number>({ max: 10, ttlMs: 1000, onEvict });
    m.set('a', 1);
    vi.advanceTimersByTime(1500);
    expect(m.get('a')).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith(1, 'a');
    expect(m.size).toBe(0);
  });

  it('get 滑动刷新 TTL：持续访问的活跃条目不过期', () => {
    vi.useFakeTimers();
    const m = createBoundedMap<string, number>({ max: 10, ttlMs: 1000 });
    m.set('a', 1);
    vi.advanceTimersByTime(600);
    expect(m.get('a')).toBe(1); // 刷新
    vi.advanceTimersByTime(600);
    expect(m.get('a')).toBe(1); // 滑动后仍在（虽累计 1200 > 1000）
    vi.advanceTimersByTime(1500);
    expect(m.get('a')).toBeUndefined(); // 停止访问后过期
  });

  it('onEvict 在超限/delete/clear 都触发', () => {
    const onEvict = vi.fn();
    const m = createBoundedMap<string, number>({ max: 1, onEvict });
    m.set('a', 1);
    m.set('b', 2); // a 超限逐出
    expect(onEvict).toHaveBeenCalledWith(1, 'a');
    expect(m.delete('b')).toBe(true);
    expect(onEvict).toHaveBeenCalledWith(2, 'b');
    expect(m.delete('z')).toBe(false); // 不存在
    m.set('c', 3);
    m.clear();
    expect(onEvict).toHaveBeenCalledWith(3, 'c');
    expect(m.size).toBe(0);
  });

  it('values 返回未过期值并惰性清理过期项', () => {
    vi.useFakeTimers();
    const m = createBoundedMap<string, number>({ max: 10, ttlMs: 1000 });
    m.set('a', 1);
    m.set('b', 2);
    expect(m.values().sort()).toEqual([1, 2]);
    vi.advanceTimersByTime(1500);
    expect(m.values()).toEqual([]);
    expect(m.size).toBe(0);
  });
});
