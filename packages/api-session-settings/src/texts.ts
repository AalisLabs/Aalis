// 本包自己的原文字典：层的称呼与会话设置不在时的说法
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  layerGlobal: '全局（插件配置）',
  layerPlatform: '平台档',
  layerPlatformType: '平台类型档',
  layerPlace: '场所',
  layerSession: '本会话',
  settingsAbsent: '会话设置不在（@aalis/plugin-session-settings 没装、没启用，或会话管理没起来）',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-session-settings', language: 'zh-CN', source: SOURCE, locales: { en } });
