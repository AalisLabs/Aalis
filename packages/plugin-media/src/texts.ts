// 本插件自己的原文字典：诊断项「识图」可用时的说明（识别模型的显示名作参数），与 /clear 清理上传的图片、描述缓存的回执
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  visionReady: '识图可用，识别模型：{model}',
  uploadsCleared: '上传的图片已清空（{count, number} 个）',
  uploadsFailed: '上传的图片清空失败: {error}',
  kindImage: '图片',
  kindVideo: '视频',
  descriptionsClearedAll: '所有{kind}描述缓存已清空（{count, number} 条）',
  descriptionsClearedSession: '当前会话{kind}描述缓存已清空（{count, number} 条）',
  descriptionsFailed: '{kind}描述缓存清空失败: {error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-media', language: 'zh-CN', source: SOURCE, locales: { en } });
