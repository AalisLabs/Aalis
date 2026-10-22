// 本包自己的原文字典：没取名时的默认名
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  defaultWorkspace: '默认工作区',
  sessionName: '会话 {t, datetime, short}',
  subtaskName: '子任务 {t, time, short}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-session-manager', language: 'zh-CN', source: SOURCE, locales: { en } });
