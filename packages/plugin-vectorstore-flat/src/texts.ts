// 本插件自己的原文字典：显示名与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'Flat 向量库',
  pathLabel: '存储目录',
  pathDescription: 'JSON 向量文件存储目录（storage URI）。也兼容旧格式 “data/vectorstore”。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-vectorstore-flat',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
