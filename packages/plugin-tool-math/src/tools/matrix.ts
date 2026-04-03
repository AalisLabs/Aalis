import type { Context } from '@aalis/core';

export function registerMatrixTools(ctx: Context): void {
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'math_matrix',
        description: '矩阵和线性代数运算。矩阵以二维数组表示，如 [[1,2],[3,4]]。支持: add(加)、subtract(减)、multiply(乘)、scalar_multiply(数乘)、transpose(转置)、determinant(行列式)、inverse(逆矩阵)、trace(迹)、rank(秩)、identity(单位矩阵)、dot_product(向量点积)、cross_product(向量叉积)、norm(向量范数)',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              description: '矩阵操作类型',
              enum: ['add', 'subtract', 'multiply', 'scalar_multiply', 'transpose', 'determinant', 'inverse', 'trace', 'rank', 'identity', 'dot_product', 'cross_product', 'norm'],
            },
            matrix: {
              type: 'array',
              description: '主矩阵（二维数组）',
            },
            matrix2: {
              type: 'array',
              description: '第二个矩阵（用于 add、subtract、multiply）',
            },
            scalar: {
              type: 'number',
              description: '标量值（用于 scalar_multiply）',
            },
            size: {
              type: 'number',
              description: '矩阵大小（用于 identity）',
            },
            vector: {
              type: 'array',
              items: { type: 'number' },
              description: '向量（用于 dot_product、cross_product、norm）',
            },
            vector2: {
              type: 'array',
              items: { type: 'number' },
              description: '第二个向量（用于 dot_product、cross_product）',
            },
          },
          required: ['operation'],
        },
      },
    },
    handler: async (args) => {
      try {
        const op = String(args.operation);
        const m = args.matrix as number[][] | undefined;
        const m2 = args.matrix2 as number[][] | undefined;

        switch (op) {
          case 'add':
          case 'subtract': {
            if (!m || !m2) return JSON.stringify({ error: '需要 matrix 和 matrix2' });
            assertMatrix(m); assertMatrix(m2);
            if (m.length !== m2.length || m[0].length !== m2[0].length) {
              return JSON.stringify({ error: '矩阵维度不匹配' });
            }
            const result = m.map((row, i) =>
              row.map((v, j) => op === 'add' ? v + m2[i][j] : v - m2[i][j])
            );
            return JSON.stringify({ result });
          }
          case 'multiply': {
            if (!m || !m2) return JSON.stringify({ error: '需要 matrix 和 matrix2' });
            assertMatrix(m); assertMatrix(m2);
            if (m[0].length !== m2.length) {
              return JSON.stringify({ error: `矩阵维度不兼容: ${m.length}×${m[0].length} × ${m2.length}×${m2[0].length}` });
            }
            return JSON.stringify({ result: matmul(m, m2) });
          }
          case 'scalar_multiply': {
            if (!m) return JSON.stringify({ error: '需要 matrix' });
            assertMatrix(m);
            const s = Number(args.scalar ?? 0);
            return JSON.stringify({ result: m.map(row => row.map(v => v * s)) });
          }
          case 'transpose': {
            if (!m) return JSON.stringify({ error: '需要 matrix' });
            assertMatrix(m);
            return JSON.stringify({ result: transpose(m) });
          }
          case 'determinant': {
            if (!m) return JSON.stringify({ error: '需要 matrix' });
            assertSquare(m);
            return JSON.stringify({ determinant: determinant(m) });
          }
          case 'inverse': {
            if (!m) return JSON.stringify({ error: '需要 matrix' });
            assertSquare(m);
            const inv = inverse(m);
            if (!inv) return JSON.stringify({ error: '矩阵不可逆（行列式为 0）' });
            return JSON.stringify({ result: inv });
          }
          case 'trace': {
            if (!m) return JSON.stringify({ error: '需要 matrix' });
            assertSquare(m);
            const tr = m.reduce((sum, row, i) => sum + row[i], 0);
            return JSON.stringify({ trace: tr });
          }
          case 'rank': {
            if (!m) return JSON.stringify({ error: '需要 matrix' });
            assertMatrix(m);
            return JSON.stringify({ rank: rank(m) });
          }
          case 'identity': {
            const n = Number(args.size ?? 3);
            if (n < 1 || n > 100) return JSON.stringify({ error: '大小应在 1-100 之间' });
            const id = Array.from({ length: n }, (_, i) =>
              Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
            );
            return JSON.stringify({ result: id });
          }
          case 'dot_product': {
            const v1 = (args.vector ?? args.data) as number[] | undefined;
            const v2 = (args.vector2 ?? args.data2) as number[] | undefined;
            if (!v1 || !v2) return JSON.stringify({ error: '需要 vector 和 vector2' });
            if (v1.length !== v2.length) return JSON.stringify({ error: '向量长度不匹配' });
            const dot = v1.reduce((s, a, i) => s + a * v2[i], 0);
            return JSON.stringify({ dot_product: dot });
          }
          case 'cross_product': {
            const v1 = (args.vector ?? args.data) as number[] | undefined;
            const v2 = (args.vector2 ?? args.data2) as number[] | undefined;
            if (!v1 || !v2) return JSON.stringify({ error: '需要 vector 和 vector2' });
            if (v1.length !== 3 || v2.length !== 3) return JSON.stringify({ error: '叉积仅支持三维向量' });
            return JSON.stringify({
              cross_product: [
                v1[1] * v2[2] - v1[2] * v2[1],
                v1[2] * v2[0] - v1[0] * v2[2],
                v1[0] * v2[1] - v1[1] * v2[0],
              ],
            });
          }
          case 'norm': {
            const v = (args.vector ?? args.data) as number[] | undefined;
            if (!v) return JSON.stringify({ error: '需要 vector' });
            const l2 = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
            const l1 = v.reduce((s, x) => s + Math.abs(x), 0);
            const linf = Math.max(...v.map(Math.abs));
            return JSON.stringify({ l1_norm: l1, l2_norm: l2, linf_norm: linf });
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

// ===== 辅助函数 =====

function assertMatrix(m: number[][]): void {
  if (!Array.isArray(m) || m.length === 0 || !Array.isArray(m[0])) {
    throw new Error('无效矩阵格式，应为二维数组');
  }
  const cols = m[0].length;
  for (const row of m) {
    if (row.length !== cols) throw new Error('矩阵行长度不一致');
  }
}

function assertSquare(m: number[][]): void {
  assertMatrix(m);
  if (m.length !== m[0].length) throw new Error(`需要方阵，当前为 ${m.length}×${m[0].length}`);
}

function transpose(m: number[][]): number[][] {
  return m[0].map((_, j) => m.map(row => row[j]));
}

function matmul(a: number[][], b: number[][]): number[][] {
  const rows = a.length, cols = b[0].length, inner = b.length;
  const result: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < inner; k++) {
      for (let j = 0; j < cols; j++) {
        result[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return result;
}

function determinant(m: number[][]): number {
  const n = m.length;
  if (n === 1) return m[0][0];
  if (n === 2) return m[0][0] * m[1][1] - m[0][1] * m[1][0];
  // LU 分解方式计算行列式
  const a = m.map(row => [...row]);
  let det = 1;
  for (let i = 0; i < n; i++) {
    // 选主元
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(a[k][i]) > Math.abs(a[maxRow][i])) maxRow = k;
    }
    if (maxRow !== i) {
      [a[i], a[maxRow]] = [a[maxRow], a[i]];
      det *= -1;
    }
    if (Math.abs(a[i][i]) < 1e-12) return 0;
    det *= a[i][i];
    for (let k = i + 1; k < n; k++) {
      const factor = a[k][i] / a[i][i];
      for (let j = i + 1; j < n; j++) {
        a[k][j] -= factor * a[i][j];
      }
    }
  }
  return det;
}

function inverse(m: number[][]): number[][] | null {
  const n = m.length;
  // 增广矩阵 [A | I]
  const aug = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);

  for (let i = 0; i < n; i++) {
    // 选主元
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
    }
    if (Math.abs(aug[maxRow][i]) < 1e-12) return null;
    [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];

    // 归一化
    const pivot = aug[i][i];
    for (let j = 0; j < 2 * n; j++) aug[i][j] /= pivot;

    // 消元
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = aug[k][i];
      for (let j = 0; j < 2 * n; j++) aug[k][j] -= factor * aug[i][j];
    }
  }

  return aug.map(row => row.slice(n));
}

function rank(m: number[][]): number {
  const a = m.map(row => [...row]);
  const rows = a.length, cols = a[0].length;
  let r = 0;
  for (let col = 0; col < cols && r < rows; col++) {
    let maxRow = r;
    for (let k = r + 1; k < rows; k++) {
      if (Math.abs(a[k][col]) > Math.abs(a[maxRow][col])) maxRow = k;
    }
    if (Math.abs(a[maxRow][col]) < 1e-12) continue;
    [a[r], a[maxRow]] = [a[maxRow], a[r]];
    for (let k = r + 1; k < rows; k++) {
      const factor = a[k][col] / a[r][col];
      for (let j = col; j < cols; j++) a[k][j] -= factor * a[r][j];
    }
    r++;
  }
  return r;
}
