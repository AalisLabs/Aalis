// 本插件自己的原文字典：宿主写的后台任务中断原因与结束通知给人看的那句
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  restarted: 'Aalis 重启时还在跑',
  closed: '工具注册表停用时还在跑',
  withdrawn: '工具 {name} 已撤回登记',
  noticeCompleted: '后台任务 {id}（{tool}）已完成，用时 {ms, duration}',
  noticeFailedExit: '后台任务 {id}（{tool}）失败：退出码 {code}，用时 {ms, duration}',
  noticeFailed: '后台任务 {id}（{tool}）失败，用时 {ms, duration}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-tools', language: 'zh-CN', source: SOURCE, locales: { en } });
