// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '多语言',
  pageTitle: '翻译',
  dictionariesDescription:
    '各包的字典在每种语言上的翻译情况：过时指原文改过措辞，冲突指同一条有不同译文，坏条目指译文解析不了或参数与原文不合。选中一行看具体的键与待译骨架。',
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
  settingLabel: '语言',
  settingDescription: '给人看的文字用的语言，靠前的优先；缺译文时依次用后面的',
  badLanguage: '{tag} 不是合法的语言标签',
  languagesProvided: '语言列表里的语言都有插件提供',
  languageUnprovided: '语言列表里的 {language} 没有插件提供，实际用 {used}',
  layerLanguageUnprovided: '{layer}里的 {language} 没有插件提供，实际用 {used}',
  layerPlatform: '{layer}「{platform}」',
  layerPlatformType: '{layer}「{platform} · {type}」',
  layerPlace: '{layer}「{place}」',
  installPack:
    '装上提供这种语言的语言包（在插件市场或 npm 搜索关键词 {count, plural, =1 {{keywords, list}} other {{keywords, list} 之一}}），或在会话设置的{layer}里调整「语言」列表',
  installPackGlobal:
    '装上提供这种语言的语言包（在插件市场或 npm 搜索关键词 {count, plural, =1 {{keywords, list}} other {{keywords, list} 之一}}），或在设置「会话默认」里调整{layer}层的「语言」一行',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-i18n', language: 'zh-CN', source: SOURCE, locales: { en } });
