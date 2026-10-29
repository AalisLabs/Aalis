// 本插件自己的原文字典：显示名与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '搜索工具',
  enabledLabel: '启用工具搜索层',
  enabledDescription: '关闭后所有工具将直接发送给 LLM，不经过搜索层',
  showToolNamesLabel: '展示可用能力目录',
  showToolNamesDescription:
    '开启后，search_tools 的描述中会概括本轮可用分组、能力说明与工具名示例，模型需要调用 search_tools 查询具体用法后才能使用对应工具。关闭后模型只看到 search_tools，需要先搜索才能发现工具。',
  maxDirectToolsLabel: '直传阈值',
  maxDirectToolsDescription: '当注册的工具总数不超过此值时，跳过搜索层，直接将全部工具发送给 LLM',
  maxSearchResultsLabel: '搜索结果上限',
  maxSearchResultsDescription: '单次搜索返回的最大工具数量，0 表示不限制',
  alwaysDirectToolsLabel: '直出工具名单',
  alwaysDirectToolsDescription: '即使启用工具搜索层，也始终直接暴露这些工具的完整定义。填写工具名，如 web_search。',
  maxDiscoveredKeepLabel: '已发现工具队列上限',
  maxDiscoveredKeepDescription:
    '从消息历史推断出的“已发现工具”最多保留 N 个（按最近使用时间倒序保留，0 = 不限）。避免长会话里 discovered 集合无限膨胀，使搜索层失去瘦身价值。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-tool-search',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
