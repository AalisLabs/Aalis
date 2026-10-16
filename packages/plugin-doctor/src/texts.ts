// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = { pluginLine: '{instance}: {reason}' } as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-doctor', language: 'zh-CN', source: SOURCE, locales: { en } });
