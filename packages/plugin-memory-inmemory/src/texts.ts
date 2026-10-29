// 本插件自己的原文字典：显示名与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '内存记忆',
  rangeQueryLimitLabel: '范围查询返回上限',
  rangeQueryLimitDescription: '区间消息查询单次返回的最大条数。命中上限会静默截断（与 sqlite/mongodb 后端对齐）',
  crossSessionMaxLimitLabel: '跨会话查询返回上限',
  crossSessionMaxLimitDescription: '跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-memory-inmemory',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
