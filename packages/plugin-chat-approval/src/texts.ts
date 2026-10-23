// 本插件自己的原文字典：显示名，推到私聊的审批消息（含来源一行）、提示与过期行
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '聊天审批',
  request: '需要你批准：{tool}',
  source: '来源：{kind, select, group {群} private {私聊} other {会话}} {id}{name}',
  sourceName: '（{name}）',
  factCommand: '命令：{value}',
  factCwd: '目录：{value}',
  factFile: '文件：{value}',
  factPatch: '改动：{value}',
  factParams: '参数：{value}',
  clipped: '{head}…（省略 {count, number} 字）…{tail}',
  howToAnswer: '引用这条消息回复「同意」，或「拒绝」加原因；{minutes, number} 分钟内不回按过期。',
  quoteToAnswer: '要批准或拒绝，请引用那条审批消息回复。',
  answerElsewhere: '这条审批无法在这里应答，请到 WebUI 或终端处理。',
  alreadySettled: '这张已经处理过。',
  answerRefused: '应答没有生效：{reason}',
  expired: '{tool} 的审批已过期。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-chat-approval', language: 'zh-CN', source: SOURCE, locales: { en } });
