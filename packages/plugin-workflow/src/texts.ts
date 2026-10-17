// 本插件自己的原文字典：运行的错误原因（节点失败）、运行的状态与「立即运行」没有成功的报错
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
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-workflow', language: 'zh-CN', source: SOURCE, locales: { en } });
