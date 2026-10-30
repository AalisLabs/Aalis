// 本插件自己的原文字典：写入被拒的原因、指令的说明与回执、取值写成的文字
import { defineTexts, type TextRef } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '会话设置',
  // 写入被拒（协议与指令共用）
  notRegistered: '没有这一项：{item}（提供它的插件没装或没启用）',
  notSessionField: '{item} 不能按会话设',
  invalidValue: '{item}的值不合法：{reason}',
  noSession: '会话不存在：{id}',
  noPlace: '场所不存在：{key}',
  placeOnly: '{item}只能设到场所为止，不能设在单个会话上',
  notApplicable: '{item}不适用于{kind, select, owner { owner 的会话} room {房间} task {子会话} other {这类会话}}',
  notForRooms: '{item}不适用于房间，平台类型档不收它',
  itemNamed: '{label}（{item}）',
  badLayerName: '层的标识不合法：{name}（非空、不含 :、不是 *）',
  unknownLayer: '不认识这一层：{layer}',
  noHostConfig: '宿主没有提供配置文档，全局层与平台档、平台类型档无处保存',
  notObject: '配置文件里的 {path} 不是对象，先改正它再写这一层',
  unknownProvider: '{item} 指向的 {contextId} 不是 {service} 的提供者',
  // 层的称呼
  workspacePlace: '工作区「{name}」',
  windowPlace: '{type}「{name}」',
  // 文字读成取值
  notBoolean: '要写 on、off、true、false、1 或 0',
  notNumber: '要写一个数字',
  notChoice: '要写可选值之一',
  mapUnsupported: '这一项在聊天里改不了，到设置页里改',
  noTextForm: '这一项没有文字写法，到设置页里改',
  unreadable: '读不出这个值',
  // 取值写成文字
  on: '开',
  off: '关',
  listValue: '{items, list}',
  empty: '无',
  // 指令
  sessionDescription: '查看当前对话里你能改的设置。每项另写它来自哪一层',
  setDescription:
    '改当前对话的一项设置，下一轮起生效。写到场所、平台类型档、平台档或全局等上层用 --at；同名的项写成 <实例 id>/<键>；-n 改会话显示名',
  resetDescription: '把一项设置恢复继承，下一轮起生效。不写项时清掉本会话或场所这一层你能改的全部项',
  atDescription: '写到哪一层：session（本会话，缺省）、place、platformType、platform、global',
  nameDescription: '会话显示名',
  itemArgument: '项：字段名，几个插件同名时写 <实例 id>/<键>',
  valueArgument: '值：余下的整行；列表与映射写 [] 、文字写 "" 即设成空',
  authorityAbsent: '要装上权限插件才能在聊天里改设置',
  notFiled: '这个会话还没收录，没有场所层',
  noPlatformType: '这个会话没有聊天窗口，不属于任何平台类型档',
  placeLayer: '{layer}「{name}」',
  namedLayer: '{layer}「{name}」',
  platformTypeLayer: '{layer}「{platform} · {type}」',
  noSuchItem: '没有这一项：{item}',
  ambiguous: '有几个插件都有 {item}，要写成 <实例 id>/<键>：{items, list}',
  editable: '{layer}里你能改的：{items, list}',
  noneEditable: '{layer}里没有你能改的项',
  layerOwnerOnly: '{layer}只有 owner 能改',
  layerLevel: '{layer}要 {level} 级才能改',
  needItem: '要写明改哪一项',
  needValue: '要写出 {item} 的值',
  choices: '可选：{choices, list}',
  setDone: '已改{layer}：{item} 为 {value}，下一轮起生效',
  renamed: '会话已改名：{name}',
  resetDone: '已把{layer}的 {items, list} 恢复{global, select, yes {默认} other {继承}}，下一轮起生效',
  resetNeedsItem: '{layer}要写明清哪一项',
  setHere: '这一层设过的：{items, list}',
  nothingToReset: '{layer}里没有你能清的项',
  sessionHeader: '{session} 的设置：',
  row: '{label}（{item}）：{value} — 来自 {source}',
  rowUnset: '{label}（{item}）：{value}',
  unsetNow: '{unset}（此刻：{now}）',
  unsetValue: '没设',
  sourceDefault: '默认',
  onlyYours: '只列出你能改的项',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-session-settings',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});

/** 写入被拒的原因里点名一项：行上的称呼加键（「<称呼>（<键>）」），界面与指令同一句 */
export const itemName = (label: string | TextRef, item: string): TextRef => t('itemNamed', { label, item });
