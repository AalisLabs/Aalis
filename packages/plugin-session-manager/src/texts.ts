// 本插件自己的原文字典：显示名，取别的会话的配置项，清空连带删除子会话的结果行，取别的会话被拒的原因，删除会话的报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '会话管理',
  takeScopeLabel: '取别的会话的范围',
  takeScopeDescription:
    '从别的会话取原文（读会话历史的工具、按消息 id 取消息、跨会话历史）时能取哪些会话：本会话只取本会话与它派出的子任务，同平台按两边的平台比（WebUI、终端各算一个平台），全部不比。写坏了按本会话',
  takeScopeSession: '本会话',
  takeScopePlatform: '同平台',
  takeScopeAll: '全部',
  takeOtherGroupsLabel: '读别的群',
  takeOtherGroupsDescription: '范围之内能不能取别的群里的内容。写坏了按否',
  takeOthersPrivateLabel: '读别人的私聊',
  takeOthersPrivateDescription:
    '范围之内能不能取别人与她的私聊，owner 在 WebUI、终端里的会话也算；调用工具的人取他自己与她的私聊不用打开。写坏了按否',
  takeCrossBotLabel: '跨机器人账号',
  takeCrossBotDescription: '范围之内，同一平台上能不能取她另一个机器人账号下的会话。写坏了按否',
  childrenDeleted: '已删除 {count, number} 个子会话',
  scopeSession: '取别的会话的范围限于本会话',
  scopePlatform: '取别的会话的范围限于同平台',
  crossBot: '没有打开「跨机器人账号」，不能取她另一个机器人账号下的会话',
  otherGroups: '没有打开「读别的群」，不能取别的群里的内容',
  othersPrivate: '没有打开「读别人的私聊」，不能取别人的私聊',
  deleteFailed: '删除会话时 {count, number} 处出错',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-session-manager',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
