// 本插件自己的原文字典：显示名与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '消息流控',
  cooldownSecondsLabel: '回复后冷却（秒）',
  rateLimitWindowLabel: '限速窗口（秒，0=关闭）',
  rateLimitMaxRepliesLabel: '窗口内最大回复数',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-flow-control', language: 'zh-CN', source: SOURCE, locales: { en } });
