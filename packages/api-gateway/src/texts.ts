// 本包自己的原文字典：回复策略「生效范围」字段的称呼、说明与选项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  audienceLabel: '生效范围',
  audienceDescription:
    '管哪些房间：多方房间是群、频道这类不止两方的聊天窗口，一对一房间是私聊；WebUI 与终端的会话不受它管',
  audienceOff: '不生效',
  audienceMultiParty: '多方房间',
  audienceOneToOne: '一对一房间',
  audienceAll: '全部房间',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-gateway', language: 'zh-CN', source: SOURCE, locales: { en } });
