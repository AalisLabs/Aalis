// 本插件自己的原文字典：显示名、配置项，会话历史读取服务的显示名（同为工具分组名）与分组概述
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '会话工具',
  sessionHistory: '会话历史读取',
  groupSummary: '按 Aalis sessionId 读取近期会话历史，用于核实跨会话上下文',
  enabledLabel: '启用会话历史读取工具',
  maxLimitLabel: '单次最多读取条数',
  maxLimitDescription: 'session_get_history 一次能返回的硬上限；LLM 传入 limit 超过此值会被 cap。建议 50~200。',
  defaultLimitLabel: '默认读取条数（LLM 不传 limit 时）',
  defaultLimitDescription: '不能超过 maxLimit。调高可让 agent 被动获取更多上下文，代价是 token 预算。',
  includeArchivedDefaultLabel: '默认包含已归档消息',
  perMessageMaxCharsLabel: '每条消息截断字数',
  perMessageMaxCharsDescription:
    '返给 LLM 的每条历史消息的字符上限；0 = 不截断（推荐）。超出会以「剩余 N 字符未展示」明示。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-tool-session',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
