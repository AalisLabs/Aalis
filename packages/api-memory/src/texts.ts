// 本包自己的原文字典：几个记忆插件共用的会话设置项「记忆召回范围」
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  recallScopeLabel: '记忆召回范围',
  recallScopeDescription: '跨会话的记忆与历史从哪里取；只能比各记忆插件自己的配置更窄，写宽了按插件配置',
  recallScopeSession: '仅本会话',
  recallScopePlatform: '同平台',
  recallScopeAll: '全部',
  recallScopeUnset: '按各记忆插件的配置',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-memory', language: 'zh-CN', source: SOURCE, locales: { en } });
