import { describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { safeEval } from '../../packages/plugin-tool-math/src/lib/expression.js';
import { registerNumberTheoryTools } from '../../packages/plugin-tool-math/src/tools/number-theory.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

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

// math_number_theory 的 gcd/lcm/阶乘/组合/排列直接交给 lib/expression 的共享实现，
// 取整、取绝对值与范围校验只在那一处；越界由外层 catch 转成工具 error。
describe('math_number_theory 沿用共享数论函数的规整与校验', () => {
  async function numberTheory(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let tool: Omit<RegisteredTool, 'pluginName'> | undefined;
    registerNumberTheoryTools(
      stubBoundTools({
        onRegister: t => {
          tool = t;
        },
      }),
    );
    if (!tool) throw new Error('math_number_theory 未注册');
    return JSON.parse((await tool.handler(args, { sessionId: 's', enabledGroups: undefined })) as string);
  }

  it('非整数与负数照常规整；阶乘越界给出共享实现的报错', async () => {
    expect(await numberTheory({ operation: 'gcd', numbers: [-12.4, 18, 30] })).toEqual({ gcd: 6 });
    expect(await numberTheory({ operation: 'lcm', numbers: [-4, 6.2] })).toEqual({ lcm: 12 });
    expect(await numberTheory({ operation: 'combination', n: 5.4, k: 2 })).toMatchObject({ result: 10 });
    expect(await numberTheory({ operation: 'permutation', n: 5, k: 1.6 })).toMatchObject({ result: 20 });
    expect(await numberTheory({ operation: 'factorial', n: 5 })).toMatchObject({ factorial: 120 });
    expect(await numberTheory({ operation: 'factorial', n: 3.5 })).toEqual({ error: '阶乘仅支持非负整数' });
    expect(await numberTheory({ operation: 'factorial', n: 171 })).toEqual({ error: '阶乘溢出（最大支持 170!）' });
  });
});
