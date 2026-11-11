// 本插件自己的原文字典：显示名与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '搜索工具',
  enabledLabel: '启用工具搜索层',
  enabledDescription: '关闭后所有工具将直接发送给模型，不经过搜索层',
  showToolNamesLabel: '展示可用能力目录',
  showToolNamesDescription:
    '开启后在 search_tools 的说明里列出本轮可用的能力目录，用前仍要搜索；关闭后模型要先搜索才能发现工具。',
  maxDirectToolsLabel: '直传阈值',
  maxDirectToolsDescription: '当注册的工具总数不超过此值时，跳过搜索层，直接将全部工具发送给模型',
  maxSearchResultsLabel: '搜索结果上限',
  maxSearchResultsDescription: '单次搜索返回的最大工具数量，0 表示不限制',
  alwaysDirectToolsLabel: '直出工具名单',
  alwaysDirectToolsDescription: '即使启用工具搜索层，也始终直接暴露这些工具的完整定义。填写工具名，如 web_search。',
  maxDiscoveredKeepLabel: '已发现工具队列上限',
  maxDiscoveredKeepDescription: '从消息历史推断出的已发现工具最多保留几个，按最近使用保留，0 为不限。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-tool-search',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
