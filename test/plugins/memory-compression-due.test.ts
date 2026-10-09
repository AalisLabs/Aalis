import { describe, expect, it } from 'vitest';
import { type CompressionUsage, compressionDue } from '../../packages/api-memory/src/index.js';

// ════════════════════════════════════════════════════════════
// compressionDue 有两维，任一维到线即该压缩。
// 用量一维：有效阈值 E = min(压缩线 × 窗口, 裁剪预算)。用量到 E 或这次被硬裁剪过、且可压缩部分至少是 E 的一半时
// 该压缩；压缩线为 0 或没设时不按用量判。
// 条数一维：这次调用里来自会话历史的条数到条数线即该压缩；条数线为 0 或没设时不按条数判。
// ════════════════════════════════════════════════════════════

/** 窗口 10 万、裁剪预算 9 万，没被硬裁剪、会话条数 0 */
const usage = (used: number, compressible: number, more: Partial<CompressionUsage> = {}): CompressionUsage => ({
  used,
  contextWindow: 100_000,
  tokenBudget: 90_000,
  compressible,
  trimmed: false,
  historyMessages: 0,
  ...more,
});

describe('compressionDue：用量一维', () => {
  it('压缩线为 0 或没设时不判用量，被硬裁剪过也不判', () => {
    for (const trimmed of [false, true]) {
      expect(compressionDue(usage(99_000, 99_000, { trimmed }), {})).toBe(false);
      expect(compressionDue(usage(99_000, 99_000, { trimmed }), { compressAt: 0 })).toBe(false);
    }
  });

  it('用量到线、可压缩部分至少是线的一半时该压缩', () => {
    const lines = { compressAt: 0.5 };
    expect(compressionDue(usage(50_000, 25_000), lines)).toBe(true);
    expect(compressionDue(usage(49_999, 25_000), lines), '用量没到线').toBe(false);
    expect(compressionDue(usage(80_000, 24_999), lines), '能压掉的不到线的一半').toBe(false);
  });

  it('压缩线乘窗口高于裁剪预算时以裁剪预算为线', () => {
    const lines = { compressAt: 0.8 };
    const budget = { tokenBudget: 60_000 };
    expect(compressionDue(usage(60_000, 30_000, budget), lines)).toBe(true);
    expect(compressionDue(usage(60_000, 29_999, budget), lines), '回差也按裁剪预算的一半').toBe(false);
  });

  it('这次被硬裁剪过：用量没到线也算到线，可压缩部分仍要至少是线的一半', () => {
    // 被硬裁剪过时，裁剪之后量的用量可能到不了线：线 = min(0.8 × 10 万, 6 万) = 6 万
    const lines = { compressAt: 0.8 };
    const trimmed = { tokenBudget: 60_000, trimmed: true };
    expect(compressionDue(usage(59_000, 30_000, trimmed), lines)).toBe(true);
    expect(compressionDue(usage(59_000, 29_999, trimmed), lines), '能压掉的不到线的一半').toBe(false);
    expect(compressionDue(usage(59_000, 30_000, { tokenBudget: 60_000 }), lines), '没被裁剪过').toBe(false);
  });
});

describe('compressionDue：条数一维', () => {
  it('会话条数到条数线即该压缩，与用量无关', () => {
    const lines = { historyLimit: 300 };
    expect(compressionDue(usage(0, 0, { historyMessages: 300 }), lines)).toBe(true);
    expect(compressionDue(usage(0, 0, { historyMessages: 301 }), lines)).toBe(true);
    expect(compressionDue(usage(0, 0, { historyMessages: 299 }), lines), '没到线').toBe(false);
  });

  it('条数线为 0 或没设时不按条数判', () => {
    const many = usage(0, 0, { historyMessages: 100_000 });
    expect(compressionDue(many, {})).toBe(false);
    expect(compressionDue(many, { historyLimit: 0 })).toBe(false);
    expect(compressionDue(many, { compressAt: 0.8, historyLimit: 0 })).toBe(false);
  });

  it('两维谁先到谁触发', () => {
    const lines = { compressAt: 0.5, historyLimit: 300 };
    expect(compressionDue(usage(50_000, 25_000, { historyMessages: 10 }), lines), '用量先到').toBe(true);
    expect(compressionDue(usage(1000, 500, { historyMessages: 300 }), lines), '条数先到').toBe(true);
    expect(compressionDue(usage(1000, 500, { historyMessages: 299 }), lines), '都没到').toBe(false);
  });
});
