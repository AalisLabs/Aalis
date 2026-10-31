// 本插件自己的原文字典：显示名、配置项，技能页的文字、列表、动作回执与报错，删不掉技能目录的报错，工具分组名与概述，
// 按会话字段「启用的技能」的称呼、说明，与它的可选项来源里的「全部技能」
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '技能系统 (Agent Skills)',
  maxSkillBytesLabel: '单 skill 最大字节数',
  maxSkillBytesDescription: 'SKILL.md 单文件最大字节数，避免一次加载过大内容污染上下文。',
  maxSkillsLabel: '技能数量上限',
  maxSkillsDescription: '扫描时最多加载的 skill 数量。',
  discoveryEnabledLabel: '启用 Discovery 注入',
  discoveryEnabledDescription:
    '往 system prompt 注入一行技能库路标，提示 agent 用 list_skills 检索、load_skill 加载技能；关闭时激活正文注入也一并停用。',
  triggersEnabledLabel: '启用 triggers 自动激活',
  triggersEnabledDescription: '匹配 SKILL.md frontmatter 中的 triggers regex 时自动加载该 skill。',
  skills: '技能',
  delete: '删除',
  deleteConfirm: '删除这个技能的整个目录（含脚本、引用与资源）？',
  skillMissing: '技能 {name} 不存在',
  deleted: '已删除技能 {name}',
  deleteDirFailed: '删除技能目录失败 {uri}: {error}',
  noSkills: '还没有技能',
  name: '名称',
  description: '描述',
  triggers: '自动触发',
  files: '附属文件',
  fileCounts: '脚本 {scripts, number} / 引用 {references, number} / 资源 {assets, number}',
  list: '{items, list}',
  license: '许可证',
  location: '位置',
  scripts: '脚本',
  references: '引用',
  assets: '资源',
  body: 'SKILL.md 正文',
  groupLabel: '技能管理',
  groupSummary: '查询、加载、创建、更新和删除可复用的 Agent Skills（兼容 Anthropic SKILL.md 标准）',
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
