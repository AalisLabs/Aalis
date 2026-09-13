import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { FlatVectorStore } from '../../packages/plugin-vectorstore-flat/src/index.js';

// ════════════════════════════════════════════════════════════
// save 串行链一旦 reject 就永久中毒：`.then(onFulfilled)` 在已 rejected 的链上只原样传递
// 拒因、不再调用回调，此后每次 save() 都是空转——连 clear() 也写不出去，只能人工删
// vectors.json。而 doSave 里的 JSON.stringify 曾在 try 之外：库涨到 V8 字符串上限时抛
// RangeError 正好命中这条路。本用例用 BigInt（JSON.stringify 对它抛 TypeError）在毫秒内
// 复现同一形状，不必造 5 亿字符。
// ════════════════════════════════════════════════════════════

function recordingStorage(): { storage: StorageService; writes: string[] } {
  const writes: string[] = [];
  const storage = {
    async writeFile(_uri: string, data: string | Uint8Array) {
      writes.push(typeof data === 'string' ? data : Buffer.from(data).toString());
    },
    async readFile() {
      throw new Error('不存在');
    },
  } as unknown as StorageService;
  return { storage, writes };
}

describe('flat 向量库：序列化失败不得毒死 save 链', () => {
  it('一次序列化失败后，链仍可用，后续 save 照常落盘', async () => {
    const { storage, writes } = recordingStorage();
    const warns: string[] = [];
    const store = new FlatVectorStore(storage, 'ws:/vectors.json', { warn: (m: string) => warns.push(m) });

    await store.add([1, 0], { tag: 'good' });
    await store.save();
    expect(writes.length, '前置：正常路径能写').toBe(1);

    // BigInt 无法被 JSON.stringify 序列化 —— 与库超过字符串上限时同一条失败路径
    await store.add([0, 1], { tag: 'bad', n: 1n as unknown as number });
    await expect(store.save(), 'save 不该把失败抛给调用方').resolves.toBeUndefined();
    expect(writes.length, '这一次确实没写出去').toBe(1);
    expect(
      warns.some(w => w.includes('保存失败')),
      '应留下告警',
    ).toBe(true);

    // 去掉坏条目后必须能恢复 —— 链中毒时这一步会静默失败（doSave 再也不被调用）
    expect(await store.deleteByFilter({ tag: 'bad' })).toBe(1);
    await store.save();
    expect(writes.length, '链中毒的话这里仍是 1：doSave 再也不会被调用').toBe(2);
    expect(JSON.parse(writes[1])).toHaveLength(1);
  });

  it('clear() 在一次序列化失败之后仍能把空库写出去', async () => {
    const { storage, writes } = recordingStorage();
    const store = new FlatVectorStore(storage, 'ws:/vectors.json', { warn: () => {} });

    await store.add([1, 0], { n: 1n as unknown as number });
    await store.save();
    expect(writes.length).toBe(0);

    await store.clear();
    expect(writes.length, '用户唯一的自救手段不能也被堵死').toBe(1);
    expect(JSON.parse(writes[0])).toEqual([]);
  });
});
