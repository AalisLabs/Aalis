// 本插件自己的原文字典：显示名与订阅时拒收的时区
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'Cron 调度引擎',
  badTimeZone: '非法时区: {timeZone}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-cron-engine',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
