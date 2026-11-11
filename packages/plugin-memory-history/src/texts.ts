// 本插件自己的原文字典：显示名与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '跨会话历史上下文',
  injectEnabledLabel: '被动注入 prompt',
  injectEnabledDescription:
    '每次调用模型前，自动注入跨会话的近期消息。关闭后工具照常可用（需开启「注册 recent_messages 工具」）。',
  limitLabel: '注入条数上限',
  limitDescription: '每次注入的最大消息条数；工具调用未指定 limit 时也用这个值。',
  maxAgeMinutesLabel: '时间窗口（分钟）',
  maxAgeMinutesDescription: '只取最近 N 分钟内的消息；0 表示不限时间。',
  perSessionLimitLabel: '每会话最多条数',
  perSessionLimitDescription: '每个会话最多取 N 条，免得一个活跃的群占满注入条数上限。0 = 不限。',
  excludeCurrentSessionLabel: '排除当前会话',
  excludeCurrentSessionDescription: '注入与查询时排除当前会话，免得与对话代理读入的本会话历史重复。',
  headerTextLabel: '注入 header 文本',
  headerTextDescription: '注入内容开头的说明文字。',
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
