// 本包自己的原文字典：层的称呼与没取名时的默认名
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  layerDefaults: '全局默认',
  layerPlatform: '平台档',
  layerType: '平台类型档',
  layerPlace: '场所',
  layerParent: '父会话',
  layerSession: '本会话',
  defaultWorkspace: '默认工作区',
  sessionName: '会话 {t, datetime, short}',
  subtaskName: '子任务 {t, time, short}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-session-manager', language: 'zh-CN', source: SOURCE, locales: { en } });
