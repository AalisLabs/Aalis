// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  pluginLine: '{instance}: {reason}',
  reportTitle: '**系统诊断 — {at, datetime, medium}**',
  reportSummary: '汇总: 通过 {ok, number}　警告 {warn, number}　错误 {error, number}',
  reportErrors: '__错误__',
  reportWarnings: '__警告__',
  reportPassed: '__通过__',
  reportCheck: '- {check, code} — {message}',
  reportDetail: '    {detail}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-doctor', language: 'zh-CN', source: SOURCE, locales: { en } });
