import type { BoundTools } from '@aalis/api-tools';
import { compileExpression } from '../lib/expression.js';

export function registerCalculusTools(tools: BoundTools): void {
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'math_calculus',
        description:
          '数值微积分工具。支持: derivative(数值导数)、integral(数值定积分-Simpson法)、find_root(方程求根-牛顿法/二分法)、limit_sequence(数列极限近似)。表达式中用 x 表示自变量，支持与 math_eval 相同的函数和运算符。',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              description: '操作类型',
              enum: ['derivative', 'integral', 'find_root', 'limit_sequence'],
            },
            expression: { type: 'string', description: '表达式（用 x 作为自变量），如 "x^2 + sin(x)"' },
            x: { type: 'number', description: '求导数 / 求根初始猜测点' },
            a: { type: 'number', description: '积分下限 / 二分法左端点' },
            b: { type: 'number', description: '积分上限 / 二分法右端点' },
            n: { type: 'number', description: '积分分段数 (默认 1000) / 数列项数 (默认 100)' },
            method: { type: 'string', description: '求根方法: newton(默认) / bisection' },
            order: { type: 'number', description: '导数阶数 (1 或 2，默认 1)' },
          },
          required: ['operation', 'expression'],
        },
      },
    },
    handler: async args => {
      try {
        const op = String(args.operation);
        const expr = String(args.expression);
        const evalFn = compileExpression(expr, ['x']);

        switch (op) {
          case 'derivative': {
            const xVal = Number(args.x ?? 0);
            const order = Number(args.order ?? 1);
            if (order === 1) {
              const h = 1e-7;
              // 五点差分公式 (更精确)
              const d =
                (-evalFn(xVal + 2 * h) + 8 * evalFn(xVal + h) - 8 * evalFn(xVal - h) + evalFn(xVal - 2 * h)) / (12 * h);
              return JSON.stringify({ expression: expr, x: xVal, derivative: d, order: 1 });
            }
            if (order === 2) {
              const h = 1e-5;
              const d2 = (evalFn(xVal + h) - 2 * evalFn(xVal) + evalFn(xVal - h)) / (h * h);
              return JSON.stringify({ expression: expr, x: xVal, derivative: d2, order: 2 });
            }
            return JSON.stringify({ error: '仅支持 1 阶和 2 阶导数' });
          }

          case 'integral': {
            const a = Number(args.a ?? 0);
            const b = Number(args.b ?? 1);
            const n = Math.round(Number(args.n ?? 1000));
            if (n < 2 || n % 2 !== 0) {
              return JSON.stringify({ error: 'n 必须为 ≥2 的偶数' });
            }
            // Simpson 1/3 法则
            const h = (b - a) / n;
            let sum = evalFn(a) + evalFn(b);
            for (let i = 1; i < n; i++) {
              const xi = a + i * h;
              sum += (i % 2 === 0 ? 2 : 4) * evalFn(xi);
            }
            const result = (h / 3) * sum;
            return JSON.stringify({ expression: expr, a, b, n, integral: result });
          }

          case 'find_root': {
            const method = String(args.method ?? 'newton');

            if (method === 'bisection') {
              const a = Number(args.a ?? -10);
              const b = Number(args.b ?? 10);
              const root = bisection(evalFn, a, b);
              if (root === null) return JSON.stringify({ error: '在给定区间内未找到根（需要 f(a) 和 f(b) 异号）' });
              return JSON.stringify({ expression: expr, method: 'bisection', root, f_root: evalFn(root) });
            }

            // Newton-Raphson
            let x = Number(args.x ?? 0);
            const h = 1e-8;
            for (let i = 0; i < 1000; i++) {
              const fx = evalFn(x);
              if (Math.abs(fx) < 1e-12) {
                return JSON.stringify({ expression: expr, method: 'newton', root: x, iterations: i, f_root: fx });
              }
              const dfx = (evalFn(x + h) - evalFn(x - h)) / (2 * h);
              if (Math.abs(dfx) < 1e-15) {
                return JSON.stringify({ error: '导数为零，牛顿法无法继续。试试 bisection 方法或换一个初始点' });
              }
              x = x - fx / dfx;
            }
            return JSON.stringify({ error: `牛顿法未收敛（1000 次迭代），当前 x = ${x}` });
          }

          case 'limit_sequence': {
            // 代入递增的大 n（仍以 x 为变量）近似极限
            const steps = Number(args.n ?? 100);
            const values: { n: number; value: number }[] = [];
            for (const n of [10, 100, 1000, 10000, 100000, steps]) {
              values.push({ n, value: evalFn(n) });
            }
            // 取最后一个作为近似极限
            const approx = values[values.length - 1].value;
            return JSON.stringify({ expression: expr, approximateLimit: approx, convergence: values });
          }

          default:
            return JSON.stringify({ error: `未知操作: ${op}` });
        }
      } catch (err: unknown) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });
}

// 二分法求根
function bisection(f: (x: number) => number, a: number, b: number): number | null {
  let fa = f(a),
    fb = f(b);
  if (fa * fb > 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (a + b) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-12 || (b - a) / 2 < 1e-12) return mid;
    if (fa * fm < 0) {
      b = mid;
      fb = fm;
    } else {
      a = mid;
      fa = fm;
    }
  }
  return (a + b) / 2;
}
