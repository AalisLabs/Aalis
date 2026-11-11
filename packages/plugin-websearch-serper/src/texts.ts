// 本插件自己的原文字典：显示名、配置项、工具分组名与概述
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'Serper 网络搜索',
  apiKeyDescription: 'Serper.dev API 密钥',
  maxPerMinuteLabel: '每分钟最大次数',
  maxPerMinuteDescription: '频率限制：每分钟最多搜索次数',
  maxPerDayLabel: '每天最大次数',
  maxPerDayDescription: '频率限制：每天最多搜索次数',
  maxConcurrentLabel: '最大并发',
  maxConcurrentDescription: '同时进行的搜索请求数上限',
  defaultNumResultsLabel: '默认结果数',
  defaultNumResultsDescription: '每次搜索返回的结果条数',
  enableCompressionLabel: '启用搜索结果压缩',
  enableCompressionDescription: '启用后，搜索结果将先经过模型压缩整合后再返回给 Agent，减少 Token 消耗并提升信息质量。',
  compressionPromptLabel: '压缩提示词',
  compressionPromptDescription:
    "自定义压缩搜索结果的提示词。留空使用默认提示。提示词中用 '{query}' 代表搜索关键词、'{results}' 代表搜索结果（不写 '{results}' 模型就收不到结果）。",
  groupLabel: '网页搜索',
  groupSummary: '通过 Serper API 搜索互联网获取最新信息',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-websearch-serper',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
