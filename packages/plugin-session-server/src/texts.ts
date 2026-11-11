// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '会话服务',
  protocolLabel: '会话协议',
  approvalsLabel: '审批',
  versionMismatch: '协议版本不兼容：客户端 {client}，服务端 {server}',
  noSession: '会话不存在：{id}',
  badCursor: 'cursor 无效：{cursor}',
  historyCursorExpired: '历史游标已失效：{before}',
  noTaskRegistry: '没有后台任务登记',
  noTask: '后台任务不存在：{id}',
  noAgentForSubsessions: '没有能停止回合的 agent 服务，子会话的回合无法停止',
  noAgent: '没有能停止回合的 agent 服务',
  turnNotRunning: '这一轮不在跑：{turnId}',
  noCompression: '没有压缩服务',
  noCheckpoint: '没有检查点服务，不能回滚',
  noTodoList: '没有待办服务',
  instanceLabel: '{name}（{instance}）',
  toolLimit: '工具调用达到这一轮的上限，可以让她继续',
  compacting: '正在压缩对话',
  compacted: '对话已压缩',
  compactionFailed: '压缩失败',
  unsentSilent: '没有发出：这一轮静默结束',
  unsentAborted: '没有发出：这一轮已停止',
  unsentError: '没有发出：回合出错',
  beforeToolUnsent: '没有发出：调用工具之前说的话不发到房间里',
  retried: '没有发出：格式校验没通过，已重试',
  notAccepted: '没有发出：平台没收下（{error}）',
  partlySent: '只发出了前 {sent, number} 条：{error}',
  unconfirmed: '可能已经发出，没等到平台确认：{error}',
  noAdapter: '没有发出：没有平台适配器接手这条消息',
  sendFailed: '没有发出：发送出错（{error}）',
  responderCannotAnswer: '应答人不能批这一张',
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
