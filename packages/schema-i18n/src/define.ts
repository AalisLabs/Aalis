// 原文字典与译文的声明：defineTexts 登记字典、返回按键产出文字对象的 t()；defineLocale 在编译期核译文
import { type CatalogEntry, catalogEntry, entryText, registerTexts, type StringTable } from './catalog.js';
import { formatMessage } from './format.js';
import { canonicalLanguage } from './locale.js';
import { parseMessage } from './message.js';
import type { Params, TextArgs } from './params.js';
import { isTextRef, type TextParam, type TextRef } from './text-ref.js';

/** 一个字典：所属包名、原文语言、原文表与各语言的译文表。t() 本身就是一个，checkTexts 也收目录条目 */
export type TextDomain = Omit<CatalogEntry, 'v'>;

/** defineTexts 返回的 t()：按键产出文字对象，参数从原文推出；身上带着这份字典 */
export interface TextFactory<S extends StringTable> extends TextDomain {
  <K extends keyof S & string>(key: K, ...params: TextArgs<S[K]>): TextRef;
  readonly source: S;
}

/** 某个原文表的译文表：键只能是原文里有的，可以缺 */
type LocaleEntries<S extends StringTable> = { readonly [K in keyof S]?: string };

/** 原文表的值必须是字面量类型，否则推不出参数 */
type LiteralSource<S> = string extends S[keyof S] ? '原文表要写成 as const，否则推不出参数' : unknown;

/** 译文与原文参数不兼容的参数名：原文没有的、或原文交来的值译文收不下的 */
type Incompatible<Source extends string, Translation extends string> = {
  [N in keyof Params<Translation>]: N extends keyof Params<Source>
    ? [Params<Source>[N]] extends [Params<Translation>[N]]
      ? never
      : N
    : N;
}[keyof Params<Translation>];

/** defineLocale 对每条译文的核对：原文里没有的键、不是字面量的译文、参数不兼容的译文都在那个键上报错 */
type LocaleCheck<S extends StringTable, E> = {
  [K in keyof E]: K extends keyof S
    ? E[K] extends string
      ? string extends E[K]
        ? { 译文要写成字面量: K }
        : [Incompatible<S[K], E[K]>] extends [never]
          ? unknown
          : { 译文参数与原文不兼容: Incompatible<S[K], E[K]> }
      : unknown
    : { 原文里没有这个键: K };
};

function languageTag(tag: string, ns: string): string {
  const canonical = canonicalLanguage(tag);
  if (canonical === undefined) throw new RangeError(`${ns}：语言标签不合法：${tag}`);
  return canonical;
}

/**
 * 声明一个包的原文字典并登记进进程级目录。ns 写包名；language 与 locales 的键过 `Intl.getCanonicalLocales`，非法即抛。
 * source 写成 `as const` 的对象（或就地写字面量），t() 才推得出参数；locales 的值用 {@link defineLocale} 写
 */
export function defineTexts<const S extends StringTable>(definition: {
  readonly ns: string;
  readonly language: string;
  readonly source: S & LiteralSource<S>;
  readonly locales?: Readonly<Record<string, LocaleEntries<S>>>;
}): TextFactory<S> {
  const { ns } = definition;
  const source: S = definition.source;
  const domain = {
    ns,
    language: languageTag(definition.language, ns),
    source,
    locales: Object.fromEntries(
      Object.entries(definition.locales ?? {}).map(([tag, table]) => [languageTag(tag, ns), table]),
    ),
  };
  registerTexts(domain);
  const t = (key: string, given?: Readonly<Record<string, TextParam>>): TextRef => {
    const template = entryText(source, key);
    if (template === undefined) throw new RangeError(`${ns} 的原文字典里没有键 ${key}`);
    // 复制一层（数组也复制）：调用方之后改自己的对象或数组，文字对象不跟着变
    const params =
      given &&
      Object.fromEntries(
        Object.entries(given).map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]),
      );
    return { i18n: ns, key, ...(params && { params }), source: renderSource(template, params, domain.language) };
  };
  return Object.assign(t, domain) as TextFactory<S>;
}

/** 按原文渲染整句，参数里的文字对象取各自的 source；渲染失败时为原文模板原样 */
function renderSource(
  template: string,
  params: Readonly<Record<string, TextParam>> | undefined,
  language: string,
): string {
  const message = parseMessage(template);
  return (message && formatMessage(message, params ?? {}, { language, nested: text => text.source })) ?? template;
}

/** value 的前 max 个码点，不从代理对中间切开 */
function headOf(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = 0;
  let count = 0;
  for (const char of value) {
    if (count++ === max) break;
    end += char.length;
  }
  return value.slice(0, end);
}

/** 截完以后参数里字符串的总字数上限是 max 的这么多倍 */
const TOTAL_FACTOR = 16;

/** 参数里字符串的总字数（含参数里的文字对象与列表元素）；嵌套文字对象各自渲染好的 source 不算，它们由参数推出 */
function paramChars(text: TextRef): number {
  let total = 0;
  const count = (value: unknown) => {
    if (typeof value === 'string') total += value.length;
    else if (isTextRef(value)) total += paramChars(value);
  };
  for (const value of Object.values(text.params ?? {})) {
    if (Array.isArray(value)) value.forEach(count);
    else count(value);
  }
  return total;
}

/**
 * 把文字对象里的字符串参数（含参数里的文字对象与列表元素）逐个截到 max 个码点，不从代理对中间切开；source 按截后的参数
 * 重新按原文渲染。所属字典不在目录里时 source 也截到 max，没有参数的也截；在目录里且没有参数的原样返回。
 * 截完参数里字符串的总字数仍超过 max 的 16 倍（几十条以上带长参数的分句、上百行）时，退为截到 max 的原文字符串。
 * 落盘方用它给参数里可能带着上游整段报错的文字对象封顶，存它的地方本来就收 `string | TextRef`
 */
export function truncateParams(text: TextRef, max: number): string | TextRef {
  const cut = cutParams(text, max);
  return paramChars(cut) > max * TOTAL_FACTOR ? headOf(cut.source, max) : cut;
}

function cutParams(text: TextRef, max: number): TextRef {
  const entry = catalogEntry(text.i18n);
  const template = entry && entryText(entry.source, text.key);
  if (text.params === undefined) return template === undefined ? { ...text, source: headOf(text.source, max) } : text;
  const cut = (value: unknown) =>
    typeof value === 'string' ? headOf(value, max) : isTextRef(value) ? cutParams(value, max) : value;
  const params = Object.fromEntries(
    Object.entries(text.params).map(([name, value]) => [name, Array.isArray(value) ? value.map(cut) : cut(value)]),
  ) as Record<string, TextParam>;
  const source =
    entry && template !== undefined ? renderSource(template, params, entry.language) : headOf(text.source, max);
  return { ...text, params, source };
}

/**
 * 声明一种语言的译文：`defineLocale<Source>()({ … })`，就地写对象字面量。原文里没有的键、不是字面量的译文、
 * 参数与原文不兼容的译文（原文 `{count}` 而译文用 plural：数量参数在原文里也要写成 `{count, number}` 或 plural）
 * 编译报错；缺的键允许
 */
export function defineLocale<S extends StringTable>(): <const E extends LocaleEntries<S>>(
  entries: E & LocaleCheck<S, E>,
) => E {
  return entries => entries;
}
