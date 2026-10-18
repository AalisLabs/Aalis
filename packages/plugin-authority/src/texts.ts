// 本插件自己的原文字典：执行守卫的拒绝语（指令一路作为回复交给发出者，工具一路取原文交给模型）与权限页的文字
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  capabilityDenied: '已被系统禁用: {capability}',
  levelTooLow: '权限不足: "{capability}" 需等级 {required}（当前 {level}）',
  intentUnreachable: '操作已取消：{capability} 需要发出者本人确认，这条指令不是人亲手输入的，无从确认',
  intentDeclined: '操作已取消：{capability} 没有得到发出者确认',
  approvalsAbsent: '操作已取消：{capability} 需要 owner 批准，但审批服务不在（由 @aalis/plugin-session-server 提供）',
  confirmSession: '每次（白名单可免）',
  confirmAlways: '每次（只有确认覆盖设为 off 能免）',
  rulesDescription:
    '禁用压过一切，连 owner 也拒。免确认只对以 owner 身份做的事生效：owner 本人、owner 派的子任务、owner 建的定时任务、定义者与调用者都是 owner 的编排；别人发起的照旧要 owner 批准，不能产生审批的直接拒绝；不放宽等级。都可以写通配，如 tool:*。',
  waivePattern:
    '能力键或通配，如 tool:shell_exec、command:level、tool:*。只免以 owner 身份做的事的确认，别人发起的照旧要 owner 批准',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-authority', language: 'zh-CN', source: SOURCE, locales: { en } });
