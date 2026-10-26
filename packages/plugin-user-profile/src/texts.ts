// 本插件自己的原文字典：事实分类的显示名、/profile 的回复与 /clear 的类型显示名和未清理的一行（给模型的档案块另写，不进字典）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  categoryInterests: '兴趣爱好',
  categoryOccupation: '职业身份',
  categoryRelationships: '人际关系',
  categorySituation: '近期处境',
  categoryValues: '价值观',
  categoryPersonality: '性格特征',
  categoryPreferences: '偏好',
  categoryTaboos: '忌讳',
  categoryOther: '其他',
  profileHead: '你的档案 ({key})',
  profileMeta: '关系强度：{score}/100，互动次数：{count}',
  section: '## {name}',
  factLine: '- {text}（{meta}）',
  factTimeHint: '时间线索：{hint}',
  factObserved: '记录于：{at, date, short}',
  factTemporary: '临时状态',
  clearType: '用户档案（跨会话）',
  clearSkipped: '用户档案是跨会话数据，只在清理全部会话时清，本次未清理',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-user-profile', language: 'zh-CN', source: SOURCE, locales: { en } });
