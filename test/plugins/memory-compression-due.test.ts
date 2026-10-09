import { describe, expect, it } from 'vitest';
import { type CompressionUsage, compressionDue } from '../../packages/api-memory/src/index.js';

// ════════════════════════════════════════════════════════════
// compressionDue 的用量一维：有效阈值 E = min(压缩线 × 窗口, 裁剪预算)。用量到 E、且可压缩部分至少是 E 的一半时
// 该压缩。压缩线为 0 或没设时不按用量判。
// ════════════════════════════════════════════════════════════

/** 窗口 10 万、裁剪预算 9 万 */
const usage = (used: number, compressible: number, tokenBudget = 90_000): CompressionUsage => ({
  used,
  contextWindow: 100_000,
  tokenBudget,
  compressible,
});

describe('compressionDue：用量一维', () => {
  it('压缩线为 0 或没设时不判用量', () => {
    expect(compressionDue(usage(99_000, 99_000), {})).toBe(false);
    expect(compressionDue(usage(99_000, 99_000), { compressAt: 0 })).toBe(false);
  });

  it('用量到线、可压缩部分至少是线的一半时该压缩', () => {
    const lines = { compressAt: 0.5 };
    expect(compressionDue(usage(50_000, 25_000), lines)).toBe(true);
    expect(compressionDue(usage(49_999, 25_000), lines), '用量没到线').toBe(false);
    expect(compressionDue(usage(80_000, 24_999), lines), '能压掉的不到线的一半').toBe(false);
  });

  it('压缩线乘窗口高于裁剪预算时以裁剪预算为线', () => {
    const lines = { compressAt: 0.8 };
    expect(compressionDue(usage(60_000, 30_000, 60_000), lines)).toBe(true);
    expect(compressionDue(usage(60_000, 29_999, 60_000), lines), '回差也按裁剪预算的一半').toBe(false);
  });
});
