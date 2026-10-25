// 本插件自己的原文字典：运行的错误原因（节点失败）、运行的状态、「立即运行」没有成功的报错，保存与启停的回执和
// once 记录读不出时的附注（附注与 workflow_define 共用，工具取原文），定义的 event 触发器订阅不可作触发源的事件时的报错，
// 定义表的定义者一列，以及运行表的「取消」、它的确认与回执
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  nodeFailed: '节点 "{id}" 失败: {error}',
  statusPending: '等待',
  statusRunning: '运行中',
  statusSuccess: '成功',
  statusFailed: '失败',
  statusCancelled: '已取消',
  runNotSucceeded: '运行没有成功（{status}）',
  runNotSucceededBecause: '运行没有成功（{status}）：{error}',
  cancelRun: '取消',
  cancelRunConfirm: '取消这次运行？已做完的节点不撤回，agent 节点已派发的那一轮照常跑完；记录留在运行历史里。',
  runCancelled: '已取消 {id}',
  runEnded: '这次运行已经结束',
  saved: '已保存工作流 {id}',
  enabled: '已启用 {id}',
  disabled: '已停用 {id}',
  onceSkipped: 'once 记录读取失败（见日志），本次运行不会触发；可用{manualRun}手动执行',
  onceSkippedPersisted:
    'once 记录读取失败（见日志），本次运行不会触发；可用{manualRun}手动执行，修复运行历史文件后重启恢复',
  runNow: '「立即运行」',
  blockedEventTrigger: 'event 触发器订阅的 {event} 负载带会话内容（会话 id、平台、正文等），不能当触发源',
  definedBy: '定义者',
  anonymous: '匿名',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-workflow', language: 'zh-CN', source: SOURCE, locales: { en } });
