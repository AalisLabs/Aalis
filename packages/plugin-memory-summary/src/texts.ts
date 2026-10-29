// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  compacted: '对话已压缩',
  clearType: '会话摘要',
  budgetRatioLabel: '摘要预算（占自动压缩线的比例）',
  budgetRatioDescription:
    '压缩时，摘要连同原样保留的原文合计约为这个会话自动压缩线（按最近一次用量算）的这个比例，不论怎么触发，但不超过这次要压的内容（上一份摘要加这次新压的对话）；不少于 {min} token，也不超过压缩线的四分之一。其中保留的原文不超过这次新压的对话的这个比例（不算上一份摘要，也不按这个下限算）。最终长度不超过摘要模型输出上限（与它窗口的四分之一取小）的三分之二，要更长得换输出上限更大的摘要模型。还没有用量时按要压的内容，同样不少于这个下限、不超过这个封顶',
  compressAtLabel: '自动压缩线（占窗口比例）',
  compressAtDescription: '用量到上下文窗口的这个比例时压缩；0 表示不按用量压缩（条数线照样起作用）',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-memory-summary',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
