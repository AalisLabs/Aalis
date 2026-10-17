// 本插件自己的原文字典：完成通知给人看的那句（任务的结果、用时与花费），白纸页上带原因的任务状态与发布状态
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  notice: '[白纸] 任务 {id}「{name}」{outcome}。{took}{cost}',
  took: '用时 {ms, duration}。',
  cost: '花费 {cents, number} 美分。',
  costPending: '费用还没入账。',
  outcomeDone: '已完成',
  outcomeUnpublished: '未能上线：{reason}',
  outcomeUnpublishedUnknown: '未能上线：发布处理失败',
  outcomeFailed: '失败：{error}',
  outcomeFailedUnknown: '失败：原因不明',
  outcomeTimeout: '超过单轮时长上限，已取消',
  outcomeOwnerCancelled: '已被 owner 取消',
  outcomeRemoteCancelled: '已在远端被取消',
  stateWithError: '{state}：{error}',
  publicationWithReason: '{target}：{state}（{reason}）',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-paper', language: 'zh-CN', source: SOURCE, locales: { en } });
