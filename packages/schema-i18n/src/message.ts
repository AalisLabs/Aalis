// 消息格式（ICU 子集）的解析：文法见 README「消息格式」一节。解析失败不抛，返回 undefined，由调用方回落。

export type DateStyle = 'short' | 'medium' | 'long';

/** 参数：plural 分支里的 # 记作 pound，取直接所在的 plural 的数 */
export type Argument =
  | { readonly type: 'plain'; readonly name: string }
  | { readonly type: 'pound' }
  | { readonly type: 'plural' | 'select'; readonly name: string; readonly branches: ReadonlyMap<string, Message> }
  | { readonly type: 'number' | 'list' | 'lines' | 'duration' | 'size' | 'code'; readonly name: string }
  | { readonly type: 'date' | 'time' | 'datetime'; readonly name: string; readonly style: DateStyle };

/** 解析后的消息：字面文字与参数依次排列 */
export type Message = readonly (string | Argument)[];

const MAX_DEPTH = 16;
const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const WORD = /[A-Za-z0-9_-]+/y;
const PLURAL_SELECTOR = /=-?\d+(?:\.\d+)?|[a-z]+/y;
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const DATE_STYLES = new Set<string>(['short', 'medium', 'long']);
const POUND: Argument = { type: 'pound' };

const FAILED = new Error('消息模板不合文法');

function fail(): never {
  throw FAILED;
}

class Reader {
  pos = 0;
  constructor(readonly src: string) {}

  skipSpace(): void {
    while (/[ \t\n\r]/.test(this.src[this.pos] ?? '')) this.pos++;
  }

  eat(char: string): boolean {
    if (this.src[this.pos] !== char) return false;
    this.pos++;
    return true;
  }

  expect(char: string): void {
    if (!this.eat(char)) fail();
  }

  match(pattern: RegExp): string | undefined {
    pattern.lastIndex = this.pos;
    const found = pattern.exec(this.src)?.[0];
    if (found !== undefined) this.pos += found.length;
    return found;
  }
}

/**
 * 引号（ICU 的 DOUBLE_OPTIONAL，`#` 不分是否在 plural 分支里）：`''` 是一个撇号；`'` 紧跟 `{`、`}`、`#` 时引用到
 * 下一个单独的 `'`，引用里的 `''` 仍是撇号，没闭合就到串尾；其余单个 `'` 是字面。读者停在 `'` 上，返回这一段的字面文字
 */
function readQuote(r: Reader): string {
  const next = r.src[r.pos + 1];
  if (next === "'") {
    r.pos += 2;
    return "'";
  }
  r.pos++;
  if (next !== '{' && next !== '}' && next !== '#') return "'";
  let text = '';
  while (r.pos < r.src.length) {
    if (r.src[r.pos] === "'") {
      if (r.src[r.pos + 1] !== "'") {
        r.pos++;
        return text;
      }
      r.pos++;
    }
    text += r.src[r.pos++];
  }
  return text;
}

/** 消息体：顶层读到串尾，分支读到收尾的 }（不吃掉它）。`inPlural`：直接所在的是 plural 分支，# 是数 */
function readMessage(r: Reader, depth: number, inPlural: boolean): Message {
  if (depth > MAX_DEPTH) fail();
  const parts: (string | Argument)[] = [];
  let text = '';
  const flush = () => {
    if (text) parts.push(text);
    text = '';
  };
  while (r.pos < r.src.length) {
    const char = r.src[r.pos];
    if (char === "'") {
      text += readQuote(r);
    } else if (char === '{') {
      flush();
      parts.push(readArgument(r, depth));
    } else if (char === '}') {
      if (depth === 0) fail();
      break;
    } else if (char === '#' && inPlural) {
      flush();
      parts.push(POUND);
      r.pos++;
    } else {
      text += char;
      r.pos++;
    }
  }
  if (depth > 0 && r.src[r.pos] !== '}') fail();
  flush();
  return parts;
}

/** 读者停在 { 上，读完收尾的 } */
function readArgument(r: Reader, depth: number): Argument {
  r.pos++;
  r.skipSpace();
  const name = r.match(NAME) ?? fail();
  r.skipSpace();
  if (r.eat('}')) return { type: 'plain', name };
  r.expect(',');
  r.skipSpace();
  const type = r.match(WORD);
  r.skipSpace();
  switch (type) {
    case 'plural':
    case 'select': {
      r.expect(',');
      const branches = new Map<string, Message>();
      for (r.skipSpace(); !r.eat('}'); r.skipSpace()) {
        const key = type === 'plural' ? pluralSelector(r) : (r.match(WORD) ?? fail());
        if (branches.has(key)) fail();
        r.skipSpace();
        r.expect('{');
        branches.set(key, readMessage(r, depth + 1, type === 'plural'));
        r.expect('}');
      }
      if (!branches.has('other')) fail();
      return { type, name, branches };
    }
    case 'number':
    case 'list':
    case 'lines':
    case 'duration':
    case 'size':
    case 'code':
      r.expect('}');
      return { type, name };
    case 'date':
    case 'time':
    case 'datetime': {
      let style: DateStyle = 'medium';
      if (r.eat(',')) {
        r.skipSpace();
        const word = r.match(WORD);
        if (word === undefined || !DATE_STYLES.has(word)) fail();
        style = word as DateStyle;
        r.skipSpace();
      }
      r.expect('}');
      return { type, name, style };
    }
    default:
      return fail();
  }
}

/** plural 的选择子：`=N`（规范成 `=` 加数的字符串写法，好与值直接比）或 CLDR 类别 */
function pluralSelector(r: Reader): string {
  const key = r.match(PLURAL_SELECTOR) ?? fail();
  if (key.startsWith('=')) return `=${Number(key.slice(1))}`;
  return PLURAL_CATEGORIES.has(key) ? key : fail();
}

const parsed = new Map<string, Message | null>();

/** 解析消息模板，结果按模板缓存（模板只来自原文字典与语言包） */
export function parseMessage(template: string): Message | undefined {
  let message = parsed.get(template);
  if (message === undefined) {
    try {
      message = readMessage(new Reader(template), 0, false);
    } catch {
      message = null;
    }
    parsed.set(template, message);
  }
  return message ?? undefined;
}

// 参数收的值的种类，按位组合：同名参数取交集，译文的参数收得下原文交来的值才算兼容
const STRING = 1;
const NUMBER = 2;
const TEXT = 4;
const ARRAY = 8;

const ACCEPTS: Record<Exclude<Argument['type'], 'pound'>, number> = {
  plain: STRING | NUMBER | TEXT,
  select: STRING,
  plural: NUMBER,
  number: NUMBER,
  date: NUMBER,
  time: NUMBER,
  datetime: NUMBER,
  duration: NUMBER,
  size: NUMBER,
  list: ARRAY,
  lines: ARRAY,
  code: STRING | NUMBER,
};

function collectKinds(message: Message, kinds: Map<string, number>): void {
  for (const part of message) {
    if (typeof part === 'string' || part.type === 'pound') continue;
    kinds.set(part.name, (kinds.get(part.name) ?? ~0) & ACCEPTS[part.type]);
    if (part.type === 'plural' || part.type === 'select') {
      for (const branch of part.branches.values()) collectKinds(branch, kinds);
    }
  }
}

// 解析结果按模板缓存，种类跟着解析结果缓存
const kindsCache = new WeakMap<Message, ReadonlyMap<string, number>>();

/** 消息用到的参数与各自收的值（与类型层推参同一规则），按出现先后；同名参数的用法互不相容时为 0 */
export function paramKinds(message: Message): ReadonlyMap<string, number> {
  let kinds = kindsCache.get(message);
  if (kinds === undefined) {
    const collected = new Map<string, number>();
    collectKinds(message, collected);
    kinds = collected;
    kindsCache.set(message, kinds);
  }
  return kinds;
}

/** 译文与原文不兼容的参数：原文没有的、或原文交来的值译文收不下的 */
export function incompatibleParams(source: ReadonlyMap<string, number>, translation: Message): string[] {
  return [...paramKinds(translation)]
    .filter(([name, accepts]) => {
      const given = source.get(name);
      return given === undefined || (given & ~accepts) !== 0;
    })
    .map(([name]) => name);
}
