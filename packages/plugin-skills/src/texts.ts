// 本插件自己的原文字典：按会话字段「启用的技能」的称呼、说明，与它的可选项来源里的「全部技能」
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  enabledLabel: '启用的技能',
  enabledDescription:
    '这个会话能用哪些技能：* 即全部技能，空列表一个都不启用。技能列表、加载、技能库路标与按触发词自动激活都只认这里启用的',
  allSkills: '全部技能',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-skills',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
