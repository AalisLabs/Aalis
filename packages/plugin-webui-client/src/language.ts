import {
  normalizeLanguages,
  type PackIndex,
  resolveSource,
  resolveText,
  type TextArgs,
  type TextRef,
} from '@aalis/schema-i18n';
import { type Source, t } from './texts';

// 界面的语言与时区：全局层的语言链与服务进程的时区，由 LanguageProvider 取自服务端写进页面的
// 语言块或 GET /api/i18n/languages，不读浏览器的语言与时区。文字按这条链渲染，语言包给前端自带的字典补的译文取自
// /api/i18n/messages；链为空（i18n 不在）时按原文。缺省是原文与 UTC：页面里没有语言块时取到之前按它画，单独渲染组件的测试
// 也用它。换语言时先换这里，再重挂整个界面：组件与模块里的函数取的都是新的

export interface Language {
  /** 全局层的语言链；空的是 i18n 不在，文字按原文 */
  readonly chain: readonly string[];
  /** 服务进程的时区 */
  readonly timeZone: string;
  /** 语言包给前端自带的字典补的译文 */
  readonly packs: PackIndex;
}

const render = (value: TextRef, { chain, timeZone, packs }: Language) =>
  chain.length > 0 ? resolveText(value, chain, { packs, timeZone }) : resolveSource(value, { timeZone });

/**
 * 另记外壳实际用的语言：字典键 pageLanguage 渲染出的译文，即 schema-i18n 渲染外壳句子时选中的字典的语言（语言包只译了一部分
 * 时，没译的句子另落到 en）。链为空时它恒是原文的语言；语言包把它译成不合法的标签时用语言链的第一项
 */
const settle = (next: Language) => ({
  ...next,
  page: normalizeLanguages([render(t('pageLanguage'), next)])[0] ?? next.chain[0],
});

let current = settle({ chain: [], timeZone: 'UTC', packs: new Map() });

export const language = (): Language => current;

export function setLanguage(next: Language): void {
  current = settle(next);
}

/** 文字对象（外壳与随前端打包的库字典的）按界面的语言渲染 */
export const text = (value: TextRef): string => render(value, current);

/** 外壳字典的一句，按界面的语言渲染 */
export function tr<K extends keyof Source & string>(key: K, ...params: TextArgs<Source[K]>): string {
  return text(t(key, ...params));
}

/**
 * 外壳实际用的语言：写进 <html lang>，数字、日期、列表、排序与大小写也按它，与句子里的同类参数一致（语言链的第一项没有
 * 字典时 Intl 自己挑会挑成链首的语言，同一界面就混了两种）
 */
export const pageLanguage = (): string => current.page;
