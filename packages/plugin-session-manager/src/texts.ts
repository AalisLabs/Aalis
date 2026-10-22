// 本插件自己的原文字典：清空连带删除子会话的结果行，取别的会话被拒的原因
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  childrenDeleted: '已删除 {count, number} 个子会话',
  scopeSession: '取别的会话的范围限于本会话',
  scopePlatform: '取别的会话的范围限于同平台',
  crossBot: '没有打开「跨机器人账号」，不能取她另一个机器人账号下的会话',
  otherGroups: '没有打开「读别的群」，不能取别的群里的内容',
  othersPrivate: '没有打开「读别人的私聊」，不能取别人的私聊',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-session-manager',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
