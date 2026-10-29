// 本插件自己的原文字典：显示名（同为服务与工具分组名）与分组概述、配置项、/clear 清待办的结果行
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '任务计划',
  groupSummary: '创建和管理任务计划列表，拆分复杂任务并追踪进度',
  enabledLabel: '启用任务计划工具',
  clearedAll: '所有会话待办已清空（{count, number} 个会话）',
  clearedSession: '当前会话待办已清空',
  clearFailed: '待办清空失败: {error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-todo-list',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
