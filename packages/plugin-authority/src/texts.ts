// 本插件自己的原文字典：执行守卫的拒绝语（指令一路作为回复交给发出者，工具一路取原文交给模型）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  capabilityDenied: '已被系统禁用: {capability}',
  levelTooLow: '权限不足: "{capability}" 需等级 {required}（当前 {level}）',
  intentUnreachable: '操作已取消：{capability} 需要发出者本人确认，这条指令不是人亲手输入的，无从确认',
  intentDeclined: '操作已取消：{capability} 没有得到发出者确认',
  approvalsAbsent: '操作已取消：{capability} 需要 owner 批准，但审批服务不在（由 @aalis/plugin-session-server 提供）',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-authority', language: 'zh-CN', source: SOURCE, locales: { en } });
