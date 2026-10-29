// 本插件自己的原文字典：显示名与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '跨会话历史上下文',
  injectEnabledLabel: '被动注入 prompt',
  injectEnabledDescription:
    '是否在每次 LLM 调用前自动将跨会话近期消息作为 system 块注入。关闭后工具仍然可用（需 toolEnabled=true）。',
  limitLabel: '注入条数上限',
  limitDescription: '每次注入的最大消息条数；工具调用未指定 limit 时也用这个值。',
  maxAgeMinutesLabel: '时间窗口（分钟）',
  maxAgeMinutesDescription: '只取最近 N 分钟内的消息；0 表示不限时间。',
  perSessionLimitLabel: '每会话最多条数',
  perSessionLimitDescription:
    '同一 sessionId 最多保留 N 条，避免某个活跃群刷屏占满总 limit；为 0 = 不做 per-session cap。',
  excludeCurrentSessionLabel: '排除当前会话',
  excludeCurrentSessionDescription:
    '注入时排除当前 sessionId（避免与对话代理按会话设置 historyLimit 读的本会话历史重复）。',
  headerTextLabel: '注入 header 文本',
  headerTextDescription: '注入到 messages[] 的 system 消息开头说明文字。',
  toolEnabledLabel: '注册 recent_messages 工具',
  toolEnabledDescription: '是否注册 recent_messages 工具供 agent 主动按需查询跨会话近期消息。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-memory-history',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
