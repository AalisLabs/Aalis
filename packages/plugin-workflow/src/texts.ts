// 本插件自己的原文字典：运行的错误原因（节点失败）、运行的状态、「立即运行」没有成功的报错，以及保存与启停的回执和
// once 记录读不出时的附注（附注与 workflow_define 共用，工具取原文）
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
  saved: '已保存工作流 {id}',
  enabled: '已启用 {id}',
  disabled: '已停用 {id}',
  onceSkipped: 'once 记录读取失败（见日志），本次运行不会触发；可用{manualRun}手动执行',
  onceSkippedPersisted:
    'once 记录读取失败（见日志），本次运行不会触发；可用{manualRun}手动执行，修复运行历史文件后重启恢复',
  runNow: '「立即运行」',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-workflow', language: 'zh-CN', source: SOURCE, locales: { en } });
