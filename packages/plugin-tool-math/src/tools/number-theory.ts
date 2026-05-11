import type { Context } from '@aalis/core';

export function registerNumberTheoryTools(ctx: Context): void {
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'math_number_theory',
        description:
          '数论与组合数学工具。支持: gcd(最大公约数)、lcm(最小公倍数)、is_prime(素数判断)、prime_factors(质因数分解)、nth_prime(第n个素数)、primes_in_range(范围内素数)、fibonacci(斐波那契数)、factorial(阶乘)、combination(组合数C(n,k))、permutation(排列数P(n,k))、mod_pow(模幂运算)、mod_inverse(模逆元)、euler_totient(欧拉函数)、is_perfect(完全数判断)、divisors(因数列表)、digital_root(数字根)',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              description: '操作类型',
            },
            n: { type: 'number', description: '主参数' },
            k: { type: 'number', description: '辅助参数' },
            m: { type: 'number', description: '模数（用于 mod_pow、mod_inverse）' },
            start: { type: 'number', description: '范围起始（用于 primes_in_range）' },
            end: { type: 'number', description: '范围结束（用于 primes_in_range）' },
            numbers: {
              type: 'array',
              items: { type: 'number' },
              description: '数字列表（用于多数 gcd/lcm）',
            },
          },
          required: ['operation'],
        },
      },
    },
    handler: async args => {
      try {
        const op = String(args.operation);
        const n = Number(args.n ?? 0);
        const k = Number(args.k ?? 0);
        const m = Number(args.m ?? 0);

        switch (op) {
          case 'gcd': {
            const nums = (args.numbers as number[]) ?? [n, k];
            if (nums.length < 2) return JSON.stringify({ error: '至少需要 2 个数字' });
            let result = Math.abs(Math.round(nums[0]));
            for (let i = 1; i < nums.length; i++) {
              result = gcd(result, Math.abs(Math.round(nums[i])));
            }
            return JSON.stringify({ gcd: result });
          }
          case 'lcm': {
            const nums = (args.numbers as number[]) ?? [n, k];
            if (nums.length < 2) return JSON.stringify({ error: '至少需要 2 个数字' });
            let result = Math.abs(Math.round(nums[0]));
            for (let i = 1; i < nums.length; i++) {
              result = lcm(result, Math.abs(Math.round(nums[i])));
            }
            return JSON.stringify({ lcm: result });
          }
          case 'is_prime':
            return JSON.stringify({ n, isPrime: isPrime(Math.round(n)) });
          case 'prime_factors':
            return JSON.stringify({ n, factors: primeFactors(Math.round(n)) });
          case 'nth_prime': {
            if (n < 1 || n > 100000) return JSON.stringify({ error: 'n 应在 1-100000 之间' });
            return JSON.stringify({ n, prime: nthPrime(Math.round(n)) });
          }
          case 'primes_in_range': {
            const start = Math.round(Number(args.start ?? 2));
            const end = Math.round(Number(args.end ?? n));
            if (end - start > 1000000) return JSON.stringify({ error: '范围过大（最大 1000000）' });
            return JSON.stringify({ start, end, primes: sieve(start, end) });
          }
          case 'fibonacci': {
            if (n < 0 || n > 1000) return JSON.stringify({ error: 'n 应在 0-1000 之间' });
            return JSON.stringify({ n, fibonacci: fibonacci(Math.round(n)) });
          }
          case 'factorial': {
            if (n < 0 || n > 170 || !Number.isInteger(n)) {
              return JSON.stringify({ error: '阶乘仅支持 0-170 的整数' });
            }
            return JSON.stringify({ n, factorial: factorial(Math.round(n)) });
          }
          case 'combination':
            return JSON.stringify({ n, k, result: comb(Math.round(n), Math.round(k)) });
          case 'permutation':
            return JSON.stringify({ n, k, result: perm(Math.round(n), Math.round(k)) });
          case 'mod_pow': {
            if (m <= 0) return JSON.stringify({ error: '模数 m 必须为正整数' });
            return JSON.stringify({
              base: n,
              exponent: k,
              modulus: m,
              result: modPow(BigInt(Math.round(n)), BigInt(Math.round(k)), BigInt(Math.round(m))).toString(),
            });
          }
          case 'mod_inverse': {
            if (m <= 0) return JSON.stringify({ error: '模数 m 必须为正整数' });
            const inv = modInverse(Math.round(n), Math.round(m));
            if (inv === null) return JSON.stringify({ error: `${n} 在模 ${m} 下无逆元` });
            return JSON.stringify({ n, modulus: m, inverse: inv });
          }
          case 'euler_totient':
            return JSON.stringify({ n, totient: eulerTotient(Math.round(n)) });
          case 'is_perfect':
            return JSON.stringify({ n, isPerfect: isPerfect(Math.round(n)) });
          case 'divisors':
            return JSON.stringify({ n, divisors: divisors(Math.round(n)) });
          case 'digital_root':
            return JSON.stringify({ n, digitalRoot: digitalRoot(Math.round(n)) });
          default:
            return JSON.stringify({ error: `未知操作: ${op}` });
        }
      } catch (err: unknown) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });
}

// ===== 数论辅助函数 =====

function gcd(a: number, b: number): number {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

function lcm(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : Math.abs((a / gcd(a, b)) * b);
}

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n < 4) return true;
  if (n % 2 === 0 || n % 3 === 0) return false;
  for (let i = 5; i * i <= n; i += 6) {
    if (n % i === 0 || n % (i + 2) === 0) return false;
  }
  return true;
}

function primeFactors(n: number): { factor: number; count: number }[] {
  n = Math.abs(n);
  if (n < 2) return [];
  const factors: { factor: number; count: number }[] = [];
  for (let d = 2; d * d <= n; d++) {
    if (n % d === 0) {
      let count = 0;
      while (n % d === 0) {
        n /= d;
        count++;
      }
      factors.push({ factor: d, count });
    }
  }
  if (n > 1) factors.push({ factor: n, count: 1 });
  return factors;
}

function nthPrime(n: number): number {
  if (n === 1) return 2;
  let count = 1,
    candidate = 3;
  while (count < n) {
    if (isPrime(candidate)) count++;
    if (count < n) candidate += 2;
  }
  return candidate;
}

function sieve(start: number, end: number): number[] {
  if (end < 2) return [];
  start = Math.max(start, 2);
  // 简单筛法
  const primes: number[] = [];
  for (let i = start; i <= end; i++) {
    if (isPrime(i)) primes.push(i);
  }
  return primes;
}

function fibonacci(n: number): string {
  if (n <= 1) return String(n);
  let a = BigInt(0),
    b = BigInt(1);
  for (let i = 2; i <= n; i++) {
    [a, b] = [b, a + b];
  }
  return b.toString();
}

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  if (k > n - k) k = n - k;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

function perm(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result *= n - i;
  return result;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function modInverse(a: number, m: number): number | null {
  // 扩展欧几里得
  let [old_r, r] = [a, m];
  let [old_s, s] = [1, 0];
  while (r !== 0) {
    const q = Math.floor(old_r / r);
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1) return null; // gcd != 1
  return ((old_s % m) + m) % m;
}

function eulerTotient(n: number): number {
  if (n <= 0) return 0;
  let result = n;
  let temp = n;
  for (let p = 2; p * p <= temp; p++) {
    if (temp % p === 0) {
      while (temp % p === 0) temp /= p;
      result -= result / p;
    }
  }
  if (temp > 1) result -= result / temp;
  return Math.round(result);
}

function isPerfect(n: number): boolean {
  if (n < 6) return false;
  let sum = 1;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) {
      sum += i;
      if (i !== n / i) sum += n / i;
    }
  }
  return sum === n;
}

function divisors(n: number): number[] {
  n = Math.abs(n);
  if (n === 0) return [];
  const result: number[] = [];
  for (let i = 1; i * i <= n; i++) {
    if (n % i === 0) {
      result.push(i);
      if (i !== n / i) result.push(n / i);
    }
  }
  return result.sort((a, b) => a - b);
}

function digitalRoot(n: number): number {
  n = Math.abs(n);
  if (n === 0) return 0;
  return 1 + ((n - 1) % 9);
}
