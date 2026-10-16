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
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-session-server',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
