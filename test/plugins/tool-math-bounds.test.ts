import { describe, expect, it } from 'vitest';
import { safeEval } from '../../packages/plugin-tool-math/src/lib/expression.js';

// ════════════════════════════════════════════════════════════
// math_eval comb/perm 迭代上界：防不受信任访客传超大 n/k 阻塞事件循环。
// ════════════════════════════════════════════════════════════

describe('comb/perm DoS 上界', () => {
  it('正常小规模照常计算', () => {
    expect(safeEval('comb(5, 2)')).toBe(10);
    expect(safeEval('perm(5, 2)')).toBe(20);
    expect(safeEval('comb(10, 0)')).toBe(1);
  });

  it('超大 k 抛错而非跑上万亿次循环', () => {
    expect(() => safeEval('comb(300000, 150000)')).toThrow(/组合数计算量过大/);
    expect(() => safeEval('perm(200000, 150000)')).toThrow(/排列数计算量过大/);
  });
});
