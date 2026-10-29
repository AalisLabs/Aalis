// 本插件自己的原文字典：显示名
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '触及',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-reach', language: 'zh-CN', source: SOURCE, locales: { en } });
