// 本插件自己的原文字典：作品页撤下的回执
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  withdrawn: '已撤下',
  withdrawnDegraded: '撤下已登记；站点状态：{state}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-works-site', language: 'zh-CN', source: SOURCE, locales: { en } });
