// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = { displayName: '多语言' } as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-i18n', language: 'zh-CN', source: SOURCE, locales: { en } });
