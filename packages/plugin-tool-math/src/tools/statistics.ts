import type { Context } from '@aalis/core';

export function registerStatisticsTools(ctx: Context): void {
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'math_statistics',
        description: '对数值数组执行统计分析。支持的操作: summary(综合统计)、mean(均值)、median(中位数)、mode(众数)、variance(方差)、stdev(标准差)、percentile(百分位数)、correlation(皮尔逊相关系数)、linear_regression(线性回归)、zscore(Z分数标准化)、describe(描述性统计)',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              description: '统计操作类型',
              enum: ['summary', 'mean', 'median', 'mode', 'variance', 'stdev', 'percentile', 'correlation', 'linear_regression', 'zscore', 'describe'],
            },
            data: {
              type: 'array',
              items: { type: 'number' },
              description: '数值数组（必需）',
            },
            data2: {
              type: 'array',
              items: { type: 'number' },
              description: '第二组数据（用于 correlation、linear_regression）',
            },
            percentile: {
              type: 'number',
              description: '百分位数值 0-100（用于 percentile 操作）',
            },
          },
          required: ['operation', 'data'],
        },
      },
    },
    handler: async (args) => {
      try {
        const op = String(args.operation);
        const data = args.data as number[];
        if (!Array.isArray(data) || data.length === 0) {
          return JSON.stringify({ error: '数据数组不能为空' });
        }
        // 验证所有元素都是数字
        for (let i = 0; i < data.length; i++) {
          if (typeof data[i] !== 'number' || isNaN(data[i])) {
            return JSON.stringify({ error: `data[${i}] 不是有效数字` });
          }
        }

        switch (op) {
          case 'summary':
          case 'describe':
            return JSON.stringify(describeSummary(data));
          case 'mean':
            return JSON.stringify({ mean: mean(data) });
          case 'median':
            return JSON.stringify({ median: median(data) });
          case 'mode':
            return JSON.stringify({ mode: mode(data) });
          case 'variance':
            return JSON.stringify({ variance: variance(data), sampleVariance: sampleVariance(data) });
          case 'stdev':
            return JSON.stringify({ stdev: stdev(data), sampleStdev: sampleStdev(data) });
          case 'percentile': {
            const p = Number(args.percentile ?? 50);
            if (p < 0 || p > 100) return JSON.stringify({ error: '百分位数应在 0-100 之间' });
            return JSON.stringify({ percentile: p, value: percentile(data, p) });
          }
          case 'correlation': {
            const data2 = args.data2 as number[] | undefined;
            if (!data2 || data2.length !== data.length) {
              return JSON.stringify({ error: 'correlation 需要长度相同的两组数据 (data, data2)' });
            }
            return JSON.stringify({ correlation: pearsonCorrelation(data, data2) });
          }
          case 'linear_regression': {
            const data2 = args.data2 as number[] | undefined;
            if (!data2 || data2.length !== data.length) {
              return JSON.stringify({ error: 'linear_regression 需要长度相同的两组数据 (data=x, data2=y)' });
            }
            return JSON.stringify(linearRegression(data, data2));
          }
          case 'zscore':
            return JSON.stringify({ zscores: zscores(data) });
          default:
            return JSON.stringify({ error: `未知操作: ${op}` });
        }
      } catch (err: unknown) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });
}

// ===== 统计函数 =====

function mean(data: number[]): number {
  return data.reduce((a, b) => a + b, 0) / data.length;
}

function median(data: number[]): number {
  const sorted = [...data].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mode(data: number[]): number[] {
  const freq = new Map<number, number>();
  for (const v of data) freq.set(v, (freq.get(v) ?? 0) + 1);
  const maxFreq = Math.max(...freq.values());
  return [...freq.entries()].filter(([, f]) => f === maxFreq).map(([v]) => v);
}

function variance(data: number[]): number {
  const m = mean(data);
  return data.reduce((sum, x) => sum + (x - m) ** 2, 0) / data.length;
}

function sampleVariance(data: number[]): number {
  if (data.length < 2) return 0;
  const m = mean(data);
  return data.reduce((sum, x) => sum + (x - m) ** 2, 0) / (data.length - 1);
}

function stdev(data: number[]): number {
  return Math.sqrt(variance(data));
}

function sampleStdev(data: number[]): number {
  return Math.sqrt(sampleVariance(data));
}

function percentile(data: number[], p: number): number {
  const sorted = [...data].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; rSquared: number; equation: string } {
  const n = x.length;
  const mx = mean(x), my = mean(y);
  let ssxy = 0, ssxx = 0, ssyy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    ssxy += dx * dy;
    ssxx += dx * dx;
    ssyy += dy * dy;
  }
  const slope = ssxx === 0 ? 0 : ssxy / ssxx;
  const intercept = my - slope * mx;
  const rSquared = ssxx === 0 || ssyy === 0 ? 0 : (ssxy * ssxy) / (ssxx * ssyy);
  const sign = intercept >= 0 ? '+' : '-';
  const equation = `y = ${slope.toFixed(6)}x ${sign} ${Math.abs(intercept).toFixed(6)}`;
  return { slope, intercept, rSquared, equation };
}

function zscores(data: number[]): number[] {
  const m = mean(data);
  const s = stdev(data);
  if (s === 0) return data.map(() => 0);
  return data.map(x => (x - m) / s);
}

function describeSummary(data: number[]) {
  const sorted = [...data].sort((a, b) => a - b);
  return {
    count: data.length,
    mean: mean(data),
    median: median(data),
    mode: mode(data),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    range: sorted[sorted.length - 1] - sorted[0],
    sum: data.reduce((a, b) => a + b, 0),
    variance: variance(data),
    sampleVariance: sampleVariance(data),
    stdev: stdev(data),
    sampleStdev: sampleStdev(data),
    q1: percentile(data, 25),
    q3: percentile(data, 75),
    iqr: percentile(data, 75) - percentile(data, 25),
    skewness: skewness(data),
    kurtosis: kurtosis(data),
  };
}

function skewness(data: number[]): number {
  const n = data.length;
  if (n < 3) return 0;
  const m = mean(data), s = sampleStdev(data);
  if (s === 0) return 0;
  const sum = data.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}

function kurtosis(data: number[]): number {
  const n = data.length;
  if (n < 4) return 0;
  const m = mean(data), s = sampleStdev(data);
  if (s === 0) return 0;
  const sum = data.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0);
  const excess = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum
    - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return excess;
}
