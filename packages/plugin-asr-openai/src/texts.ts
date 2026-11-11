// 本插件自己的原文字典：配置项与配置报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  modelLabel: '模型',
  timeoutMsLabel: '请求超时 (ms)',
  timeoutMsDescription: '整段上传与识别的最长时间，超时即中止，默认 10 分钟。',
  baseUrlInvalid: 'baseUrl 需为不带用户名或密码的完整 URL',
  baseUrlQuery: 'baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-asr-openai', language: 'zh-CN', source: SOURCE, locales: { en } });
