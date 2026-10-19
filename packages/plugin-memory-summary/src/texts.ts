// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  compacted: '对话已压缩',
  budgetRatioLabel: '摘要预算（占压掉内容的比例）',
  budgetRatioDescription:
    '压缩时，摘要连同原样保留的原文合计约为这次重写的输入（上一份摘要加这次新压的对话）的这个比例，越旧的内容因此越浓缩。合计不少于 {min} token，其中保留的原文不超过输入的这个比例（不按这个下限算）；摘要模型的输出上限与窗口、这个会话的压缩线另有封顶',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-memory-summary',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
