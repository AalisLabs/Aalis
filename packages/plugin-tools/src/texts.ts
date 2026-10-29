// 本插件自己的原文字典：显示名与后台任务的配置项，宿主写的后台任务中断原因与结束通知给人看的那句，按会话字段「工具分组」的
// 称呼与说明
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '工具注册表',
  backgroundLabel: '后台任务',
  maxWaitSecondsLabel: '前台最多等待（秒）',
  maxWaitSecondsDescription:
    '可转后台的工具调用在前台最多等多少秒，模型给的 waitSeconds 超过它按它算；到时还没结束就转到后台',
  maxPerSessionLabel: '每个会话同时在跑的上限',
  maxPerSessionDescription:
    '同一会话里对话回合中同时在跑的可转后台工具调用（前台与后台一起数），满了时新的调用在执行之前就被拒绝；不在对话回合里的调用不会转后台，不占名额',
  restarted: 'Aalis 重启时还在跑',
  closed: '工具注册表停用时还在跑',
  withdrawn: '工具 {name} 已撤回登记',
  noticeCompleted: '后台任务 {id}（{tool}）已完成，用时 {ms, duration}',
  noticeFailedExit: '后台任务 {id}（{tool}）失败：退出码 {code}，用时 {ms, duration}',
  noticeFailed: '后台任务 {id}（{tool}）失败，用时 {ms, duration}',
  groupsLabel: '工具分组',
  groupsDescription: '这个会话能用的工具分组，* 为全部；不属于任何分组的工具总是给',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-tools', language: 'zh-CN', source: SOURCE, locales: { en } });
