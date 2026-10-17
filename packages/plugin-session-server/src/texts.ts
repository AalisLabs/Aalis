// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  instanceLabel: '{name}（{instance}）',
  notApplicable: '会话设置项 {key} 不适用于{kind, select, owner {我的会话} room {房间} task {子任务} other {{kind}}}',
  toolLimit: '工具调用达到这一轮的上限，可以让她继续',
  compacting: '正在压缩对话',
  compacted: '对话已压缩',
  compactionFailed: '压缩失败',
  unsentSilent: '没有发出：这一轮静默结束',
  unsentAborted: '没有发出：回合已中止',
  unsentError: '没有发出：回合出错',
  beforeToolUnsent: '没有发出：调用工具之前说的话不发到群里',
  retried: '没有发出：格式校验没通过，已重试',
  notAccepted: '没有发出：平台没收下（{error}）',
  noAdapter: '没有发出：没有平台适配器接手这条消息',
  sendFailed: '没有发出：发送出错（{error}）',
  responderNotOwner: '应答人不是 owner',
  approvalSettled: '这个审批已经结算',
  noSuchApproval: '没有这个审批：{id}',
  contentHashMismatch: '内容哈希对不上',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-session-server',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
