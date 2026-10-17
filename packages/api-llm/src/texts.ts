// 本包自己的原文字典：请求带了模型没有的思考档位时的报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = { noSuchLevel: '模型 {model} 没有思考档位「{level}」' } as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-llm', language: 'zh-CN', source: SOURCE, locales: { en } });
