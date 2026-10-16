// 本包自己的原文字典
import { defineTexts } from './define.js';
import en from './locales/en.js';
import type { TextRef } from './text-ref.js';

const SOURCE = { lines: '{items, lines}' } as const;
export type Source = typeof SOURCE;

const t = defineTexts({ ns: '@aalis/schema-i18n', language: 'zh-CN', source: SOURCE, locales: { en } });

/** 把若干段（字符串或文字对象）按行连成一个文字对象：多行报告、列表类回复用它，每段按读者语言各自渲染 */
export function textLines(parts: readonly (string | TextRef)[]): TextRef {
  return t('lines', { items: parts });
}
