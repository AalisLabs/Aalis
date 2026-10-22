// 本插件自己的原文字典：按会话字段「关系图范围」的称呼、说明与选项，/clear 的类型显示名与未清理的一行
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  recallScopeLabel: '关系图范围',
  recallScopeDescription:
    '注入关系图与关系图工具取哪些会话的事件：仅本会话时注入不带别的会话里抽出的事件、跨会话话题与全局热点，人际关系照常，工具的会话作用域只能是本会话；写坏了按仅本会话',
  recallScopeSession: '仅本会话',
  recallScopeAll: '全部',
  clearType: '用户关系图谱（跨会话）',
  clearSkipped: '关系图是跨会话数据，只在清理全部会话时清，本次未清理',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-user-relation', language: 'zh-CN', source: SOURCE, locales: { en } });
