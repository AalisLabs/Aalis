// 本插件自己的原文字典：显示名、服务标签、配置项、/clear 的类型与结果行、压缩没压成的原因
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  compacted: '对话已压缩',
  clearType: '会话摘要',
  budgetRatioLabel: '摘要预算',
  budgetRatioDescription:
    '压缩后摘要（连同保留的原文）的目标长度，按这个会话自动压缩线的比例算。至少 {min} token，最多压缩线的四分之一，其余限制见文档。',
  compressAtLabel: '自动压缩线',
  compressAtDescription: '用量到上下文窗口的这个比例时压缩；0 表示不按用量压缩（条数线照样起作用）',
  displayName: '记忆摘要',
  compressionLabel: '会话压缩',
  noChatModel: '没有可用的对话模型',
  modelFailed: '摘要模型调用失败：{error}',
  outputTruncated: '摘要模型在输出上限处停下，输出不完整',
  emptySummary: '摘要模型返回了空内容',
  windowTooSmall: '摘要模型的上下文窗口（{contextLength}）装不下提示词、已有摘要与摘要的输出上限（{maxTokens}）',
  clearedDuring: '压缩期间会话被清空',
  historyChanged: '压缩期间历史被改动',
  busy: '这个会话正在压缩，稍后再试',
  noMemory: 'memory 服务不可用',
  clearedAll: '所有会话摘要已清空',
  clearedSession: '当前会话摘要已清空',
  clearFailed: '摘要清空失败：{error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-memory-summary',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
