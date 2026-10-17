// 本包自己的原文字典：审批面的句柄在提供者不在场时回的应答被拒原因
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  serviceAbsent: '审批服务不在',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-approval', language: 'zh-CN', source: SOURCE, locales: { en } });
