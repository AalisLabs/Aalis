// 本插件自己的原文字典：完成通知给人看的那句（任务的结果、用时与花费），白纸页上带原因的任务状态与发布状态，房间的六个按会话
// 字段的称呼与说明
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
  paperEnabledLabel: '开启白纸',
  paperEnabledDescription: '这个房间开启白纸',
  paperNameLabel: '白纸名',
  paperNameDescription: '留空则每个窗口各一块白纸，属性取白纸插件配置的 defaults；几个窗口写同一个名字就共用一块',
  remoteTypesLabel: '远端代理类型',
  remoteTypesDescription: '允许的远端代理插件实例 id；空即关',
  userCentsLabel: '每人每天金额上限（美分）',
  userCentsDescription: '留空不增加每人金额限制，0 禁止新远端任务；写坏了按 0',
  userTasksLabel: '每人每天件数上限',
  userTasksDescription: '留空即不按人限制',
  userTasksUnset: '不按人限制',
  roomCentsLabel: '每房间每天金额上限（美分）',
  roomCentsDescription: '留空不增加房间金额限制，0 禁止新远端任务；写坏了按 0',
  noExtraLimit: '不另加限制',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-paper', language: 'zh-CN', source: SOURCE, locales: { en } });
