// 本插件自己的原文字典：显示名与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '消息归档',
  debugLogsLabel: '归档调试日志',
  debugLogsDescription: '记录图片解释完成和消息写入记忆等调试日志。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-message-archive',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
