// 本插件自己的原文字典：按会话字段「跨会话历史范围」的称呼、说明与选项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  scopeLabel: '跨会话历史范围',
  scopeDescription:
    '被动注入与 recent_messages 从哪些会话取近期原文，是这两处的上限：工具要更宽的范围时按它；写坏了按仅本会话',
  scopeSession: '仅本会话（不取其他会话）',
  scopeSamePlatform: '同平台跨会话聚合',
  scopeCrossPlatform: '跨平台全部聚合',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-memory-history',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
