/**
 * 安全数学表达式解析器 — 递归下降解析，不使用 eval
 * 支持：四则运算、幂运算、括号、常量、数学函数
 */

// ===== 常量 =====
const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  PI: Math.PI,
  e: Math.E,
  E: Math.E,
  tau: 2 * Math.PI,
  TAU: 2 * Math.PI,
  phi: (1 + Math.sqrt(5)) / 2, // 黄金比例
  inf: Infinity,
  Infinity: Infinity,
};

// ===== 内置函数（一元） =====
const FUNCTIONS_1: Record<string, (x: number) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  trunc: Math.trunc,
  sign: Math.sign,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  exp: Math.exp,
  expm1: Math.expm1,
  log: Math.log,
  ln: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  log1p: Math.log1p,
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
  // 角度 <-> 弧度
  deg: (x: number) => (x * 180) / Math.PI,
  rad: (x: number) => (x * Math.PI) / 180,
  // 阶乘
  factorial: factorial,
};

// ===== 内置函数（二元） =====
const FUNCTIONS_2: Record<string, (a: number, b: number) => number> = {
  pow: Math.pow,
  max: Math.max,
  min: Math.min,
  atan2: Math.atan2,
  hypot: Math.hypot,
  mod: (a: number, b: number) => ((a % b) + b) % b, // 正取模
  gcd: gcd,
  lcm: lcm,
  comb: comb,
  perm: perm,
  log_base: (x: number, base: number) => Math.log(x) / Math.log(base),
};

// ===== 可变参数函数 =====
const FUNCTIONS_VAR: Record<string, (args: number[]) => number> = {
  sum: args => args.reduce((a, b) => a + b, 0),
  avg: args => args.reduce((a, b) => a + b, 0) / args.length,
  mean: args => args.reduce((a, b) => a + b, 0) / args.length,
  product: args => args.reduce((a, b) => a * b, 1),
};

// ===== 辅助数学函数 =====

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) throw new Error('阶乘仅支持非负整数');
  if (n > 170) throw new Error('阶乘溢出（最大支持 170!）');
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

function lcm(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  return a === 0 || b === 0 ? 0 : (a / gcd(a, b)) * b;
}

function comb(n: number, k: number): number {
  n = Math.round(n);
  k = Math.round(k);
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
  n = Math.round(n);
  k = Math.round(k);
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result *= n - i;
  return result;
}

// ===== Token 类型 =====
type TokenType = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  num?: number;
}

// ===== 词法分析 =====
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = expr.length;

  while (i < len) {
    const ch = expr[i];

    // 空白
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // 数字（含小数、科学记号）
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < len && /[0-9.]/.test(expr[i])) {
        num += expr[i++];
      }
      // 科学记号 e/E
      if (i < len && /[eE]/.test(expr[i])) {
        num += expr[i++];
        if (i < len && /[+-]/.test(expr[i])) num += expr[i++];
        while (i < len && /[0-9]/.test(expr[i])) num += expr[i++];
      }
      const val = parseFloat(num);
      if (Number.isNaN(val)) throw new Error(`无效数字: ${num}`);
      tokens.push({ type: 'number', value: num, num: val });
      continue;
    }

    // 标识符（函数名、常量名）
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < len && /[a-zA-Z0-9_]/.test(expr[i])) ident += expr[i++];
      tokens.push({ type: 'ident', value: ident });
      continue;
    }

    // 运算符
    if ('+-*/%^'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    // ** 幂运算
    if (ch === '*' && i + 1 < len && expr[i + 1] === '*') {
      tokens.push({ type: 'op', value: '**' });
      i += 2;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ',' });
      i++;
      continue;
    }

    throw new Error(`未知字符: '${ch}' (位置 ${i})`);
  }

  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

// ===== 递归下降解析器 =====
class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  /** 返回当前未消费的 token（用于外部检查表达式是否已完全解析） */
  current(): Token {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType, value?: string): Token {
    const tok = this.consume();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new Error(`期望 ${type}${value ? `(${value})` : ''}，得到 ${tok.type}(${tok.value})`);
    }
    return tok;
  }

  // expr = term (('+' | '-') term)*
  parseExpr(): number {
    let result = this.parseTerm();
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.consume().value;
      const right = this.parseTerm();
      result = op === '+' ? result + right : result - right;
    }
    return result;
  }

  // term = power (('*' | '/' | '%') power)*
  private parseTerm(): number {
    let result = this.parsePower();
    while (this.peek().type === 'op' && '*/%'.includes(this.peek().value)) {
      const op = this.consume().value;
      const right = this.parsePower();
      if (op === '*') result *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('除以零');
        result /= right;
      } else {
        if (right === 0) throw new Error('模零');
        result %= right;
      }
    }
    return result;
  }

  // power = unary ('^' power)?   (右结合)
  private parsePower(): number {
    let base = this.parseUnary();
    if (this.peek().type === 'op' && this.peek().value === '^') {
      this.consume();
      const exp = this.parsePower(); // 右结合递归
      base = base ** exp;
    }
    return base;
  }

  // unary = ('+' | '-') unary | atom
  private parseUnary(): number {
    if (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.consume().value;
      const val = this.parseUnary();
      return op === '-' ? -val : val;
    }
    return this.parseAtom();
  }

  // atom = number | ident | ident '(' args ')' | '(' expr ')'
  private parseAtom(): number {
    const tok = this.peek();

    // 数字
    if (tok.type === 'number') {
      this.consume();
      return tok.num!;
    }

    // 标识符 —— 常量或函数调用
    if (tok.type === 'ident') {
      this.consume();
      const name = tok.value;

      // 函数调用
      if (this.peek().type === 'lparen') {
        this.consume(); // (
        const args: number[] = [];
        if (this.peek().type !== 'rparen') {
          args.push(this.parseExpr());
          while (this.peek().type === 'comma') {
            this.consume();
            args.push(this.parseExpr());
          }
        }
        this.expect('rparen');
        return this.callFunction(name, args);
      }

      // 常量
      if (name in CONSTANTS) return CONSTANTS[name];
      throw new Error(`未知标识符: '${name}'`);
    }

    // 括号表达式
    if (tok.type === 'lparen') {
      this.consume();
      const val = this.parseExpr();
      this.expect('rparen');
      return val;
    }

    throw new Error(`意外的 token: ${tok.type}(${tok.value})`);
  }

  private callFunction(name: string, args: number[]): number {
    // 可变参数函数
    if (name in FUNCTIONS_VAR) {
      if (args.length === 0) throw new Error(`函数 ${name} 至少需要 1 个参数`);
      return FUNCTIONS_VAR[name](args);
    }
    // 一元函数
    if (name in FUNCTIONS_1) {
      if (args.length !== 1) throw new Error(`函数 ${name} 需要 1 个参数，得到 ${args.length} 个`);
      return FUNCTIONS_1[name](args[0]);
    }
    // 二元函数
    if (name in FUNCTIONS_2) {
      if (args.length !== 2) throw new Error(`函数 ${name} 需要 2 个参数，得到 ${args.length} 个`);
      return FUNCTIONS_2[name](args[0], args[1]);
    }

    throw new Error(`未知函数: '${name}'`);
  }
}

// ===== 公共 API =====

export function safeEval(expression: string): number {
  if (!expression?.trim()) throw new Error('表达式为空');
  if (expression.length > 1000) throw new Error('表达式过长（最大 1000 字符）');

  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const result = parser.parseExpr();

  // 确保整个表达式已消费
  const remaining = parser.current();
  if (remaining && remaining.type !== 'eof') {
    throw new Error(`表达式末尾有多余内容: '${remaining.value}'`);
  }

  return result;
}

/** 获取所有支持的函数/常量列表 */
export function listFunctions(): {
  constants: string[];
  functions1: string[];
  functions2: string[];
  functionsVar: string[];
} {
  return {
    constants: Object.keys(CONSTANTS),
    functions1: Object.keys(FUNCTIONS_1),
    functions2: Object.keys(FUNCTIONS_2),
    functionsVar: Object.keys(FUNCTIONS_VAR),
  };
}
