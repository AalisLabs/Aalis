// 原文字典与译文的声明：defineTexts 登记字典、返回按键产出文字对象的 t()；defineLocale 在编译期核译文
import { type CatalogEntry, entryText, registerTexts, type StringTable } from './catalog.js';
import { formatMessage } from './format.js';
import { canonicalLanguage } from './locale.js';
import { parseMessage } from './message.js';
import type { Params, TextArgs } from './params.js';
import type { TextParam, TextRef } from './text-ref.js';

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
    const message = parseMessage(template);
    const rendered =
      message && formatMessage(message, params ?? {}, { language: domain.language, nested: text => text.source });
    return { i18n: ns, key, ...(params && { params }), source: rendered ?? template };
  };
  return Object.assign(t, domain) as TextFactory<S>;
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
