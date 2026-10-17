// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  pluginLine: '{instance}: {reason}',
  reportTitle: '**系统诊断 — {at, datetime, medium}**',
  reportSummary: '汇总: ✓ {ok, number}　! {warn, number}　✗ {error, number}',
  reportErrors: '__✗ 错误__',
  reportWarnings: '__! 警告__',
  reportPassed: '__✓ 通过__',
  reportCheck: '- {check, code} — {message}',
  reportDetail: '    {detail}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-doctor', language: 'zh-CN', source: SOURCE, locales: { en } });
