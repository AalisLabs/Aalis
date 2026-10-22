// 本插件自己的原文字典：/clear 清理绘图产物的回执
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  cleared: '绘图产物已清空（{count, number} 个）',
  clearFailed: '绘图产物清空失败: {error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-draw', language: 'zh-CN', source: SOURCE, locales: { en } });
