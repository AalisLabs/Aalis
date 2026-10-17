// command-descriptions 守卫夹具的原文字典
import { defineTexts } from '../../../../packages/schema-i18n/src/index.js';
import en from './locales/en.js';

const SOURCE = { brief: '一句短话。后面是细节', long: '另一句短话。后面是细节' } as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@zz/command-descriptions', language: 'zh-CN', source: SOURCE, locales: { en } });
