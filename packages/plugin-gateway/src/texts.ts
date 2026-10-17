// 本插件自己的原文字典
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = { displayName: '消息流网关', agentUnavailable: '[系统] Agent 服务不可用，请检查插件配置。' } as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-gateway', language: 'zh-CN', source: SOURCE, locales: { en } });
