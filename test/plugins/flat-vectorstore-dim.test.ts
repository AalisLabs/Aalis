import { describe, expect, it, vi } from 'vitest';
import type { StorageService } from '../../packages/plugin-storage-api/src/index.js';
import { FlatVectorStore } from '../../packages/plugin-vectorstore-flat/src/index.js';

// ════════════════════════════════════════════════════════════
// H7: 向量维度不匹配（换 embedding 模型复用旧库）不再静默产 NaN
//   —— dotProduct 维度守卫 → -Infinity；search 维度不符告警一次。
//   search/add 不触 storage，用空桩即可。
// ════════════════════════════════════════════════════════════

const stubStorage = {} as unknown as StorageService;

describe('FlatVectorStore 维度守卫（H7）', () => {
  it('同维：按相似度排序、分数有限（无 NaN）', async () => {
    const store = new FlatVectorStore(stubStorage, 'data:/x.json');
    await store.add([1, 0, 0], { id: 'a' });
    await store.add([0, 1, 0], { id: 'b' });
    const r = await store.search([1, 0, 0], 2);
    expect(r[0].metadata.id).toBe('a'); // 最近
    expect(r.every(x => Number.isFinite(x.score))).toBe(true);
  });

  it('查询维度不符：分数为 -Infinity 而非 NaN，且告警一次', async () => {
    const warn = vi.fn();
    const store = new FlatVectorStore(stubStorage, 'data:/x.json', { warn });
    await store.add([1, 0, 0], { id: 'a' });
    const r = await store.search([1, 0, 0, 0], 1); // 4 维查询 vs 3 维库
    expect(r.some(x => Number.isNaN(x.score))).toBe(false);
    expect(r.every(x => x.score === Number.NEGATIVE_INFINITY)).toBe(true);
    await store.search([1, 0, 0, 0], 1); // 再查一次
    expect(warn).toHaveBeenCalledTimes(1); // 只告警一次，不刷屏
  });
});
