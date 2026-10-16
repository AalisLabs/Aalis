// ============================================================
// @aalis/schema-i18n — 给人看的文字对象
//
// 要翻译的文字是文字对象（TextRef）：取自所属包原文字典的一个键，带参数与按原文渲染的整句，纯数据、可落盘。
// 产出文字的一方只依赖本包；出口在 i18n 服务在场时按读者语言渲染，不在场时按原文语言渲染（resolveSource）。
// 本包零运行时依赖、不用 node: 模块，浏览器里同样可用。
// ============================================================

export {
  type CatalogEntry,
  type CatalogIssue,
  catalogEntries,
  catalogIssues,
  type LocaleTable,
  type StringTable,
} from './catalog.js';
export { checkTexts, type TextIssue } from './check.js';
export {
  defineLocale,
  defineTexts,
  type TextDomain,
  type TextFactory,
} from './define.js';
export { isTextError, TextError, textOf, withText } from './errors.js';
export { normalizeLanguages } from './locale.js';
export {
  fingerprint,
  indexPacks,
  type LanguagePack,
  type PackIndex,
  type PackText,
} from './packs.js';
export type { Params, TextArgs } from './params.js';
export { type ResolveOptions, resolveSource, resolveText } from './resolve.js';
export {
  asText,
  isTextRef,
  type Localized,
  type LocalizeSkip,
  localize,
  type TextParam,
  type TextRef,
  toSource,
  toSourceReplacer,
} from './text-ref.js';
export { textClauses, textLines } from './texts.js';
