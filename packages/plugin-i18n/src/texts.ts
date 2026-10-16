// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '多语言',
  pageTitle: '翻译',
  dictionariesDescription:
    '各包的原文字典在每种语言上的情况。已译算上语言包补的；过时是语言包里原文已经改过措辞的条目，冲突是同一条有不一样的译文，坏条目是解析不了或参数与原文不合的译文。选中一行看具体的键与待译骨架。',
  dictionary: '字典',
  language: '语言',
  translated: '已译',
  missing: '缺',
  stale: '过时',
  conflicts: '冲突',
  broken: '坏条目',
  issues: '问题',
  issueLine: '{kind}：{keys, list}',
  noIssues: '没有问题',
  wholeDictionary: '整份字典',
  dictionaryGone: '字典 {ns} 已不在',
  localeSkeleton: '待译骨架：本插件的 locales 文件',
  localeSkeletonDescription: '放进插件的 src/locales/，文件名是语言标签；缺的先填了原文',
  packSkeleton: '待译骨架：语言包的 entries',
  packSkeletonDescription: '交给贡献点 i18n:pack；只列字典没有自带译文的键，缺的与过时的先填了原文，from 是原文的指纹',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-i18n', language: 'zh-CN', source: SOURCE, locales: { en } });
