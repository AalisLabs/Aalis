import type { Context } from '@aalis/core';

export function registerCalculusTools(ctx: Context): void {
  ctx.registerTool({
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
        const evalFn = buildEvalFunction(expr);

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
            // 用 n 替换 x，计算大 n 处的值来近似极限
            const fn = buildEvalFunction(expr); // 用 x 变量，但代入大数
            const steps = Number(args.n ?? 100);
            const values: { n: number; value: number }[] = [];
            for (const n of [10, 100, 1000, 10000, 100000, steps]) {
              values.push({ n, value: fn(n) });
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

/**
 * 将表达式字符串编译为安全的 (x: number) => number 函数
 * 使用与 expression.ts 相同的解析器逻辑
 */
function buildEvalFunction(expr: string): (x: number) => number {
  return (xVal: number) => {
    // 将 x 替换为具体数值。需要处理 exp, max 等包含 x 的函数名
    // 策略：用独特占位符替换变量 x
    const processed = expr.replace(/\bx\b/g, `(${xVal})`);
    return safeEvalSimple(processed);
  };
}

// ===== 自包含的简化表达式求值器（与 lib/expression.ts 算法一致） =====

const MATH_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  PI: Math.PI,
  e: Math.E,
  E: Math.E,
  tau: 2 * Math.PI,
  phi: (1 + Math.sqrt(5)) / 2,
  inf: Infinity,
};

const FN1: Record<string, (x: number) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  trunc: Math.trunc,
  sign: Math.sign,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  exp: Math.exp,
  log: Math.log,
  ln: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
};

const FN2: Record<string, (a: number, b: number) => number> = {
  pow: Math.pow,
  max: Math.max,
  min: Math.min,
  atan2: Math.atan2,
  hypot: Math.hypot,
  mod: (a, b) => ((a % b) + b) % b,
  log_base: (x, base) => Math.log(x) / Math.log(base),
};

type TT = 'num' | 'id' | 'op' | '(' | ')' | ',' | 'eof';
interface Tok {
  t: TT;
  v: string;
  n?: number;
}

function lex(s: string): Tok[] {
  const r: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(s[i])) {
      let n = '';
      while (i < s.length && /[0-9.]/.test(s[i])) n += s[i++];
      if (i < s.length && /[eE]/.test(s[i])) {
        n += s[i++];
        if (i < s.length && /[+-]/.test(s[i])) n += s[i++];
        while (i < s.length && /[0-9]/.test(s[i])) n += s[i++];
      }
      r.push({ t: 'num', v: n, n: parseFloat(n) });
      continue;
    }
    if (/[a-zA-Z_]/.test(s[i])) {
      let id = '';
      while (i < s.length && /[a-zA-Z0-9_]/.test(s[i])) id += s[i++];
      r.push({ t: 'id', v: id });
      continue;
    }
    if ('+-*/%^'.includes(s[i])) {
      r.push({ t: 'op', v: s[i++] });
      continue;
    }
    if (s[i] === '(') {
      r.push({ t: '(', v: '(' });
      i++;
      continue;
    }
    if (s[i] === ')') {
      r.push({ t: ')', v: ')' });
      i++;
      continue;
    }
    if (s[i] === ',') {
      r.push({ t: ',', v: ',' });
      i++;
      continue;
    }
    throw new Error(`未知字符: '${s[i]}'`);
  }
  r.push({ t: 'eof', v: '' });
  return r;
}

function safeEvalSimple(expression: string): number {
  const tokens = lex(expression);
  let pos = 0;
  const pk = () => tokens[pos];
  const nx = () => tokens[pos++];

  function parseE(): number {
    let r = parseT();
    while (pk().t === 'op' && '+-'.includes(pk().v)) {
      const o = nx().v;
      const right = parseT();
      r = o === '+' ? r + right : r - right;
    }
    return r;
  }

  function parseT(): number {
    let r = parseP();
    while (pk().t === 'op' && '*/%'.includes(pk().v)) {
      const o = nx().v;
      const right = parseP();
      if (o === '*') r *= right;
      else if (o === '/') {
        if (right === 0) throw new Error('除以零');
        r /= right;
      } else {
        if (right === 0) throw new Error('模零');
        r %= right;
      }
    }
    return r;
  }

  function parseP(): number {
    let base = parseU();
    if (pk().t === 'op' && pk().v === '^') {
      nx();
      base = base ** parseP();
    }
    return base;
  }

  function parseU(): number {
    if (pk().t === 'op' && '+-'.includes(pk().v)) {
      const o = nx().v;
      return o === '-' ? -parseU() : parseU();
    }
    return parseA();
  }

  function parseA(): number {
    const tok = pk();
    if (tok.t === 'num') {
      nx();
      return tok.n!;
    }
    if (tok.t === 'id') {
      nx();
      if (pk().t === '(') {
        nx();
        const args: number[] = [];
        if (pk().t !== ')') {
          args.push(parseE());
          while (pk().t === ',') {
            nx();
            args.push(parseE());
          }
        }
        if (pk().t !== ')') throw new Error('缺少右括号');
        nx();
        if (tok.v in FN1 && args.length === 1) return FN1[tok.v](args[0]);
        if (tok.v in FN2 && args.length === 2) return FN2[tok.v](args[0], args[1]);
        throw new Error(`未知函数: ${tok.v}`);
      }
      if (tok.v in MATH_CONSTANTS) return MATH_CONSTANTS[tok.v];
      throw new Error(`未知标识符: ${tok.v}`);
    }
    if (tok.t === '(') {
      nx();
      const v = parseE();
      if (pk().t !== ')') throw new Error('缺少右括号');
      nx();
      return v;
    }
    throw new Error(`意外 token: ${tok.v}`);
  }

  const result = parseE();
  if (pk().t !== 'eof') throw new Error(`多余内容: ${pk().v}`);
  return result;
}
