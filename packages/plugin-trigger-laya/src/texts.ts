// 本插件自己的原文字典：诊断项里未生效时的说明（点名当前生效的触发插件）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  inactive:
    'Laya 触发判定未生效（生效的触发插件是「{label}」），不检查侧车；要启用它，在配置文件的 servicePreferences 里把 trigger 指向 @aalis/plugin-trigger-laya',
  inactiveNone:
    'Laya 触发判定未生效（没有生效的触发插件），不检查侧车；要启用它，在配置文件的 servicePreferences 里把 trigger 指向 @aalis/plugin-trigger-laya',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-trigger-laya', language: 'zh-CN', source: SOURCE, locales: { en } });
