// 本插件自己的原文字典：显示名、配置项，按会话字段的称呼、说明与选项，/clear 的类型显示名与结果行
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '人设系统',
  statePersistenceLabel: '状态持久化',
  statePersistenceDescription:
    '启用后，角色状态（心情、当前行为等 outputFormat 字段）会在同一会话内延续并注入到下一轮提示中',
  timeInjectionLabel: '时间注入',
  timeInjectionDescription: '启用后，当前时间会自动注入到系统提示中',
  timeZoneLabel: '时区 (IANA)',
  timeZoneDescription: '例如 Asia/Shanghai、Europe/London、America/New_York。留空使用系统本地时区。',
  personaLabel: '人设',
  personaDescription: '角色卡名（不含后缀）；default 是人设目录里的 default 卡，没有时用内置的默认角色',
  extraLabel: '额外提示',
  extraDescription: '追加在人设提示之后、结构化输出格式说明之前；为空时不追加',
  plainLabel: '不用结构化输出',
  plainDescription: '不用角色卡的结构化输出格式，回复纯文本',
  renderLabel: '客户端渲染 JSON',
  renderDescription: '结构化输出的 JSON 原样交给客户端渲染，不提取回复字段',
  renderCard: '按角色卡',
  renderOn: '开',
  renderOff: '关',
  clearType: '会话角色状态',
  clearedAll: '所有会话角色状态已清空',
  clearedSession: '当前会话角色状态已清空',
  clearFailed: '角色状态清空失败：{error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-persona', language: 'zh-CN', source: SOURCE, locales: { en } });
