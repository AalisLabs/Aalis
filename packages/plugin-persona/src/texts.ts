// 本插件自己的原文字典：按会话字段的称呼、说明与选项，/clear 的类型显示名
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
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
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-persona', language: 'zh-CN', source: SOURCE, locales: { en } });
