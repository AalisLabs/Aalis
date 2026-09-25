import { describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { registerCalculusTools } from '../../packages/plugin-tool-math/src/tools/calculus.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// math_calculus 与 math_eval 共用 lib/expression.ts 的求值器：
// 支持的函数与常量相同，1000 字符上限按原式计（变量经变量表代入，不做字符串替换）。
// ════════════════════════════════════════════════════════════

async function calculus(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let tool: Omit<RegisteredTool, 'pluginName'> | undefined;
  registerCalculusTools(
    stubBoundTools({
      onRegister: t => {
        tool = t;
      },
    }),
  );
  if (!tool) throw new Error('math_calculus 未注册');
  const out = await tool.handler(args, { sessionId: 's', enabledGroups: undefined });
  return JSON.parse(out as string);
}

describe('math_calculus 表达式求值', () => {
  it('支持 math_eval 的全部函数与常量（阶乘、可变参数、角度换算、gcd、TAU）', async () => {
    const d = await calculus({ operation: 'derivative', expression: 'factorial(3) * x + gcd(12, 18)', x: 1 });
    expect(d.derivative).toBeCloseTo(6, 5);

    const i = await calculus({ operation: 'integral', expression: 'sum(x, 1)', a: 0, b: 1 });
    expect(i.integral).toBeCloseTo(1.5, 10);

    const deg = await calculus({ operation: 'derivative', expression: 'deg(x)', x: 0 });
    expect(deg.derivative).toBeCloseTo(180 / Math.PI, 5);

    const root = await calculus({ operation: 'find_root', expression: 'x - TAU', x: 1 });
    expect(root.root).toBeCloseTo(2 * Math.PI, 10);
  });

  it('变量只绑定独立标识符 x，exp / max 等函数名不受影响', async () => {
    const d = await calculus({ operation: 'derivative', expression: 'exp(x) + max(x, 0)', x: 1 });
    expect(d.derivative).toBeCloseTo(Math.E + 1, 5);
  });

  it('1000 字符上限按原式计：x 出现 499 次、代入后远超 1000 字符的原式照常求值', async () => {
    const expr = Array.from({ length: 499 }, () => 'x').join('+');
    expect(expr.length).toBeLessThanOrEqual(1000);
    const d = await calculus({ operation: 'derivative', expression: expr, x: 0.123456789 });
    expect(d.derivative).toBeCloseTo(499, 3);
  });

  it('超过 1000 字符的原式与空表达式被拒', async () => {
    const tooLong = await calculus({ operation: 'integral', expression: `x${'+1'.repeat(500)}`, a: 0, b: 1 });
    expect(tooLong.error).toMatch(/表达式过长/);

    const empty = await calculus({ operation: 'integral', expression: '  ', a: 0, b: 1 });
    expect(empty.error).toBe('表达式为空');
  });
});
