// 本插件自己的原文字典：/clear 的类型显示名
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  clearType: '向量记忆',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-memory-vector', language: 'zh-CN', source: SOURCE, locales: { en } });
