import { describe, expect, it } from 'vitest';
import { heapPop, heapPush } from '../../packages/core/src/orchestration/min-heap.js';
import { mulberry32 } from '../helpers/interleave.js';

describe('整数小顶堆', () => {
  it('放与取随机交错（堆里至多 40 个数，有重复）：每次取出的都是此刻最小的', () => {
    const random = mulberry32(20261115);
    const below = (bound: number): number => Math.floor(random() * bound);
    for (let round = 0; round < 500; round++) {
      const heap: number[] = [];
      const held: number[] = [];
      for (let step = 0; step < 300; step++) {
        if (held.length < 40 && (held.length === 0 || below(5) < 3)) {
          const value = below(60);
          heapPush(heap, value);
          held.push(value);
          held.sort((a, b) => a - b);
        } else {
          const got = heapPop(heap);
          if (got !== held.shift()) throw new Error(`第 ${round} 轮第 ${step} 步：取出 ${got}，不是此刻最小的`);
        }
      }
    }
  });

  it('数的个数翻两番，逆序放完再取空，读数组的次数不到八倍：放与取都不逐个扫', () => {
    const reads = (count: number): number => {
      let total = 0;
      const heap = new Proxy<number[]>([], {
        get(target, key, receiver) {
          total++;
          return Reflect.get(target, key, receiver);
        },
      });
      for (let value = count; value > 0; value--) heapPush(heap, value);
      for (let value = 1; value <= count; value++)
        if (heapPop(heap) !== value) throw new Error(`${count} 个数：第 ${value} 次取出的不是 ${value}`);
      return total;
    };
    expect(reads(1024) / reads(256)).toBeLessThan(8);
  });
});
