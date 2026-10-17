// 本插件自己的原文字典：诊断项「识图」可用时的说明（识别模型的显示名作参数）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  visionReady: '识图可用，识别模型：{model}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-media', language: 'zh-CN', source: SOURCE, locales: { en } });
