// 本包自己的原文字典：表达式与间隔校验不通过的原因
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  empty: '表达式为空',
  every: '无法识别的 @every 表达式: {expr}',
  interval: '间隔须大于 0 且不超过 {max, number} 秒（约 24.8 天）: {value}',
  syntax: '非法 cron 表达式（需 5 字段或别名）: {expr}',
  field: 'cron 第 {field, number} 字段非法（解析为空）: "{value}"',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/util-cron', language: 'zh-CN', source: SOURCE, locales: { en } });
