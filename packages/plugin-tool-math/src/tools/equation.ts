import type { Context } from '@aalis/core';

export function registerEquationTools(ctx: Context): void {
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'math_equation',
        description: '方程求解工具。支持: linear(一元一次 ax+b=0)、quadratic(一元二次 ax²+bx+c=0)、cubic(一元三次)、system_linear(线性方程组-高斯消元)、proportion(比例 a:b=c:x)',
        parameters: {
          type: 'object',
          properties: {
            operation: { type: 'string', description: '操作类型', enum: ['linear', 'quadratic', 'cubic', 'system_linear', 'proportion'] },
            // 多项式系数
            a: { type: 'number', description: '系数 a' },
            b: { type: 'number', description: '系数 b' },
            c: { type: 'number', description: '系数 c' },
            d: { type: 'number', description: '系数 d（三次方程）' },
            // 线性方程组
            coefficients: {
              type: 'array',
              description: '线性方程组增广矩阵 [[a1,b1,...,r1], [a2,b2,...,r2], ...]，最后一列为等号右侧值',
            },
          },
          required: ['operation'],
        },
      },
    },
    handler: async (args) => {
      try {
        const op = String(args.operation);

        switch (op) {
          case 'linear': {
            const a = Number(args.a ?? 0), b = Number(args.b ?? 0);
            if (a === 0) {
              return JSON.stringify(b === 0
                ? { equation: '0 = 0', solutions: 'infinite', hint: '恒成立' }
                : { equation: `${b} = 0`, solutions: 'none', hint: '无解' });
            }
            const x = -b / a;
            return JSON.stringify({ equation: `${a}x + ${b} = 0`, x });
          }

          case 'quadratic': {
            const a = Number(args.a ?? 0), b = Number(args.b ?? 0), c = Number(args.c ?? 0);
            if (a === 0) {
              // 退化为一次
              if (b === 0) return JSON.stringify({ error: '不是方程（a=0, b=0）' });
              return JSON.stringify({ equation: `${b}x + ${c} = 0`, x: -c / b });
            }
            const disc = b * b - 4 * a * c;
            const equation = `${a}x² + ${b}x + ${c} = 0`;
            if (disc > 0) {
              const sqrtD = Math.sqrt(disc);
              return JSON.stringify({
                equation, discriminant: disc,
                x1: (-b + sqrtD) / (2 * a),
                x2: (-b - sqrtD) / (2 * a),
                type: '两个不等实根',
              });
            }
            if (disc === 0) {
              return JSON.stringify({
                equation, discriminant: 0,
                x: -b / (2 * a),
                type: '两个相等实根',
              });
            }
            // disc < 0 —— 复数根
            const real = -b / (2 * a);
            const imag = Math.sqrt(-disc) / (2 * a);
            return JSON.stringify({
              equation, discriminant: disc,
              x1: `${real} + ${imag}i`,
              x2: `${real} - ${imag}i`,
              type: '两个共轭复根',
            });
          }

          case 'cubic': {
            const a = Number(args.a ?? 1), b = Number(args.b ?? 0);
            const c = Number(args.c ?? 0), d = Number(args.d ?? 0);
            if (a === 0) return JSON.stringify({ error: '三次项系数 a 不能为 0' });
            const roots = solveCubic(a, b, c, d);
            return JSON.stringify({
              equation: `${a}x³ + ${b}x² + ${c}x + ${d} = 0`,
              roots,
            });
          }

          case 'system_linear': {
            const aug = args.coefficients as number[][];
            if (!aug || aug.length === 0) {
              return JSON.stringify({ error: '需要增广矩阵 coefficients' });
            }
            const result = solveLinearSystem(aug);
            return JSON.stringify(result);
          }

          case 'proportion': {
            const a = Number(args.a ?? 0), b = Number(args.b ?? 0), c = Number(args.c ?? 0);
            if (a === 0) return JSON.stringify({ error: 'a 不能为 0（a:b = c:x）' });
            const x = (b * c) / a;
            return JSON.stringify({ proportion: `${a}:${b} = ${c}:${x}`, x });
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

// ===== 三次方程 (卡尔丹公式 + 数值修正) =====
function solveCubic(a: number, b: number, c: number, d: number): { real: number; imag?: number }[] {
  // 转为 depressed cubic: t³ + pt + q = 0
  const p1 = b / a, p2 = c / a, p3 = d / a;
  const Q = (3 * p2 - p1 * p1) / 9;
  const R = (9 * p1 * p2 - 27 * p3 - 2 * p1 * p1 * p1) / 54;
  const D = Q * Q * Q + R * R;

  const roots: { real: number; imag?: number }[] = [];

  if (D >= 0) {
    const sqrtD = Math.sqrt(D);
    const S = Math.cbrt(R + sqrtD);
    const T = Math.cbrt(R - sqrtD);
    const r1 = S + T - p1 / 3;
    roots.push({ real: r1 });

    if (Math.abs(D) < 1e-10) {
      // 重根
      const r2 = -(S + T) / 2 - p1 / 3;
      roots.push({ real: r2 });
    } else {
      // 复数根
      const realPart = -(S + T) / 2 - p1 / 3;
      const imagPart = Math.sqrt(3) / 2 * (S - T);
      roots.push({ real: realPart, imag: imagPart });
      roots.push({ real: realPart, imag: -imagPart });
    }
  } else {
    // 三个实根 (casus irreducibilis)
    const theta = Math.acos(R / Math.sqrt(-Q * Q * Q));
    const sq = 2 * Math.sqrt(-Q);
    roots.push({ real: sq * Math.cos(theta / 3) - p1 / 3 });
    roots.push({ real: sq * Math.cos((theta + 2 * Math.PI) / 3) - p1 / 3 });
    roots.push({ real: sq * Math.cos((theta + 4 * Math.PI) / 3) - p1 / 3 });
  }

  return roots;
}

// ===== 高斯消元法解线性方程组 =====
function solveLinearSystem(augmented: number[][]): { solution?: number[]; type: string; variables?: string[] } {
  const m = augmented.length;
  const n = augmented[0].length - 1; // 变量数
  const a = augmented.map(row => [...row]);

  // 前向消元
  let pivotRow = 0;
  for (let col = 0; col < n && pivotRow < m; col++) {
    // 选主元
    let maxRow = pivotRow;
    for (let row = pivotRow + 1; row < m; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[maxRow][col])) maxRow = row;
    }
    if (Math.abs(a[maxRow][col]) < 1e-12) continue;
    [a[pivotRow], a[maxRow]] = [a[maxRow], a[pivotRow]];

    // 消元
    for (let row = 0; row < m; row++) {
      if (row === pivotRow) continue;
      const factor = a[row][col] / a[pivotRow][col];
      for (let j = col; j <= n; j++) {
        a[row][j] -= factor * a[pivotRow][j];
      }
    }
    pivotRow++;
  }

  // 回代检查
  const rank = pivotRow;
  // 检查是否有矛盾行（0 0 ... 0 | non-zero）
  for (let row = rank; row < m; row++) {
    if (Math.abs(a[row][n]) > 1e-10) {
      return { type: '无解（矛盾方程）' };
    }
  }

  if (rank < n) {
    return { type: `无穷多解（秩=${rank}，变量数=${n}，自由变量=${n - rank}个）` };
  }

  // 唯一解
  const solution: number[] = [];
  const variables: string[] = [];
  for (let i = 0; i < n; i++) {
    solution.push(a[i][n] / a[i][i]);
    variables.push(`x${i + 1}`);
  }
  return { type: '唯一解', solution, variables };
}
