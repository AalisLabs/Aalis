// 本插件自己的原文字典：显示名、配置项，会话历史读取服务的显示名（同为工具分组名）与分组概述
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '会话工具',
  sessionHistory: '会话历史读取',
  groupSummary: '按 Aalis sessionId 读取近期会话历史，用于核实跨会话上下文',
  enabledLabel: '启用会话历史读取工具',
  maxLimitLabel: '单次最多读取条数',
  maxLimitDescription: '读取会话历史一次最多返回的条数，模型要的更多时按这个值算。建议 50~200。',
  defaultLimitLabel: '默认读取条数',
  defaultLimitDescription:
    '模型没指定条数时读取的条数，不能超过「单次最多读取条数」。调高能给模型更多上下文，也更耗 token。',
  includeArchivedDefaultLabel: '默认包含已归档消息',
  perMessageMaxCharsLabel: '每条消息截断字数',
  perMessageMaxCharsDescription:
    '返给模型的每条历史消息的字符上限；0 = 不截断（推荐）。超出的部分截掉，末尾标「…[已截断，还剩 N 个字符未展示]」。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-tool-session',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
