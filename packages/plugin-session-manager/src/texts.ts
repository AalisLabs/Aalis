// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = { childrenDeleted: '已删除 {count, number} 个子会话' } as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-session-manager',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
