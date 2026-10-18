// 本包自己的原文字典（原文表在 source.ts）
import { defineTexts } from './define.js';
import en from './locales/en.js';
import { SOURCE } from './source.js';
import type { TextRef } from './text-ref.js';

export type Source = typeof SOURCE;

const t = defineTexts({ ns: '@aalis/schema-i18n', language: 'zh-CN', source: SOURCE, locales: { en } });

/** 把若干段（字符串或文字对象）按行连成一个文字对象：多行报告、列表类回复用它，每段按读者语言各自渲染 */
export function textLines(parts: readonly (string | TextRef)[]): TextRef {
  return t('lines', { items: parts });
}

/**
 * textLines 的逆：是 textLines 生成的文字对象（落盘读回的同样认）就给出各段，否则 undefined。要逐行加工（缩进、加前缀）
 * 又不能先渲染的一方用它；段本身可能是多行的字符串或别的文字对象
 */
export function linesOf(text: TextRef): readonly (string | number | TextRef)[] | undefined {
  const items = text.i18n === t.ns && text.key === 'lines' ? text.params?.items : undefined;
  return Array.isArray(items) ? items : undefined;
}

/**
 * 把若干分句（字符串或文字对象）连成一句：原文以「；」相连，英文以「; 」。并列的几条原因、几个问题用它。两两二分着嵌套，
 * 层数随句数按对数增长；n 句约占 2n 个参数里的文字对象，每句另带文字对象参数时更多（见 resolveText 的渲染上限）
 */
export function textClauses(parts: readonly (string | TextRef)[]): TextRef {
  if (parts.length < 2) return textLines(parts);
  const half = Math.ceil(parts.length / 2);
  const side = (slice: readonly (string | TextRef)[]) => (slice.length === 1 ? slice[0] : textClauses(slice));
  return t('clauses', { head: side(parts.slice(0, half)), tail: side(parts.slice(half)) });
}
