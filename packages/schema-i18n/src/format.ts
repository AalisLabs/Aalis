// 按解析好的消息与参数渲染整句。参数不合要求（缺参数、数量参数不是有限数、列表不是数组）、Intl 报错都算失败，
// 返回 undefined 由调用方回落，绝不抛。
import type { Argument, DateStyle, Message } from './message.js';
import { isTextRef, type TextParam, type TextRef } from './text-ref.js';

interface FormatOptions {
  /** 选中的那条文字的语言：plural 类别与数、日期、列表都按它格式化 */
  readonly language: string;
  /** date 与 time 用的时区，缺省用进程时区 */
  readonly timeZone?: string;
  /** 字符串参数按 Markdown 转义，字典里写的 Markdown 原样 */
  readonly escape?: 'markdown';
  /** 参数里的文字对象怎么渲染 */
  readonly nested: (text: TextRef) => string;
}

type Params = Readonly<Record<string, TextParam>>;

const FAILED = new Error('参数不合要求');

function fail(): never {
  throw FAILED;
}

// Intl 对象构造比格式化贵得多，按语言、选项与时区缓存；读者的时区来自请求，条目数封顶
const intlCache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  let value = intlCache.get(key) as T | undefined;
  if (value === undefined) {
    value = make();
    if (intlCache.size >= 512) intlCache.clear();
    intlCache.set(key, value);
  }
  return value;
}

const numberFormat = (language: string, unit?: string, display?: 'short' | 'narrow', digits?: number) =>
  cached(
    `number\0${language}\0${unit}\0${display}\0${digits}`,
    () =>
      new Intl.NumberFormat(
        language,
        unit === undefined ? undefined : { style: 'unit', unit, unitDisplay: display, maximumFractionDigits: digits },
      ),
  );

/** 再长的时区名当作没给：缓存键随读者的时区来，不收超长的名字 */
const MAX_TIME_ZONE_LENGTH = 64;

/** 时区来自读者（cookie、协议），过长的与 Intl 不认的当作没给，按进程时区：不让整句回落成原文 */
function dateFormat(type: 'date' | 'time' | 'datetime', style: DateStyle, o: FormatOptions): Intl.DateTimeFormat {
  const timeZone = o.timeZone && o.timeZone.length <= MAX_TIME_ZONE_LENGTH ? o.timeZone : undefined;
  return cached(`${type}\0${style}\0${o.language}\0${timeZone}`, () => {
    const options: Intl.DateTimeFormatOptions = {};
    if (type !== 'time') options.dateStyle = style;
    if (type !== 'date') options.timeStyle = style;
    try {
      return new Intl.DateTimeFormat(o.language, { ...options, timeZone });
    } catch {
      return new Intl.DateTimeFormat(o.language, options);
    }
  });
}

const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~=&$]/g;

/** 按 Markdown 转义：转义后的文字在 Markdown 里显示为原样 */
export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, '\\$&');
}

function finite(value: TextParam | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fail();
}

function list(value: TextParam | undefined): readonly (string | number | TextRef)[] {
  return Array.isArray(value) ? value : fail();
}

/** 普通参数与列表元素：字符串（按需转义）、数原样、文字对象交给 nested */
function item(value: unknown, o: FormatOptions): string {
  if (typeof value === 'string') return o.escape === 'markdown' ? escapeMarkdown(value) : value;
  if (typeof value === 'number') return String(value);
  return isTextRef(value) ? o.nested(value) : fail();
}

const DURATION_UNITS = ['day', 'hour', 'minute', 'second'] as const;
const DURATION_SECONDS = [86_400, 3_600, 60, 1];

/** 时长：天、时、分、秒最多两级，按显示的最小一级四舍五入；负数只在第一级带负号 */
function duration(ms: number, o: FormatOptions): string {
  const seconds = Math.abs(ms) / 1000;
  let top = DURATION_SECONDS.findIndex(size => seconds >= size);
  if (top < 0) top = DURATION_SECONDS.length - 1;
  let step: number;
  let rounded: number;
  for (;;) {
    step = DURATION_SECONDS[Math.min(top + 1, DURATION_SECONDS.length - 1)];
    rounded = Math.round(seconds / step) * step;
    // 进位跨过上一级（59.6 秒成了 60 秒）就升一级重算
    if (top === 0 || rounded < DURATION_SECONDS[top - 1]) break;
    top--;
  }
  const high = Math.floor(rounded / DURATION_SECONDS[top]);
  const low = Math.round((rounded - high * DURATION_SECONDS[top]) / step);
  const unit = (index: number, value: number) => numberFormat(o.language, DURATION_UNITS[index], 'short').format(value);
  const parts = [unit(top, ms < 0 && rounded > 0 ? -high : high)];
  if (low > 0) parts.push(unit(top + 1, low));
  return cached(
    `unit-list\0${o.language}`,
    () => new Intl.ListFormat(o.language, { type: 'unit', style: 'short' }),
  ).format(parts);
}

const SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'];

/** 字节数：B、KB、MB、GB，按 1024 进位，B 以上留一位小数；按显示精度舍入后到了 1024 就升一级 */
function size(bytes: number, o: FormatOptions): string {
  let value = Math.abs(bytes);
  let index = 0;
  const shown = () => (index === 0 ? Math.round(value) : Math.round(value * 10) / 10);
  while (shown() >= 1024 && index < SIZE_UNITS.length - 1) {
    value /= 1024;
    index++;
  }
  return numberFormat(o.language, SIZE_UNITS[index], 'narrow', index === 0 ? 0 : 1).format(bytes < 0 ? -value : value);
}

/** 行内代码：围栏比参数里最长的反引号串多一个，参数以反引号开头或结尾时两侧加空格；参数原样，不转义 */
function code(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

function formatArgument(arg: Argument, params: Params, o: FormatOptions, count: number): string {
  if (arg.type === 'pound') return numberFormat(o.language).format(count);
  const value = Object.hasOwn(params, arg.name) ? params[arg.name] : undefined;
  switch (arg.type) {
    case 'plain':
      return item(value, o);
    case 'number':
      return numberFormat(o.language).format(finite(value));
    case 'plural': {
      const n = finite(value);
      const category = cached(`plural\0${o.language}`, () => new Intl.PluralRules(o.language)).select(n);
      const branch = arg.branches.get(`=${n}`) ?? arg.branches.get(category) ?? arg.branches.get('other');
      return render(branch ?? fail(), params, o, n);
    }
    case 'select': {
      if (typeof value !== 'string') fail();
      const branch = arg.branches.get(value) ?? arg.branches.get('other');
      return render(branch ?? fail(), params, o, count);
    }
    case 'date':
    case 'time':
    case 'datetime':
      return dateFormat(arg.type, arg.style, o).format(finite(value));
    case 'list':
      return cached(`list\0${o.language}`, () => new Intl.ListFormat(o.language, { type: 'conjunction' })).format(
        list(value).map(element => item(element, o)),
      );
    case 'lines':
      return list(value)
        .map(element => item(element, o))
        .join('\n');
    case 'duration':
      return duration(finite(value), o);
    case 'size':
      return size(finite(value), o);
    case 'code':
      if (typeof value === 'number') return code(String(value));
      return typeof value === 'string' ? code(value) : fail();
  }
}

function render(message: Message, params: Params, o: FormatOptions, count: number): string {
  let out = '';
  for (const part of message) out += typeof part === 'string' ? part : formatArgument(part, params, o, count);
  return out;
}

/** 渲染整句；失败（含 Intl 报错，如不认识的时区）返回 undefined */
export function formatMessage(message: Message, params: Params, options: FormatOptions): string | undefined {
  try {
    return render(message, params, options, Number.NaN);
  } catch {
    return undefined;
  }
}
