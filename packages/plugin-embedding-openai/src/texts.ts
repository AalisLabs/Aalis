// 本插件自己的原文字典：配置项与配置报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  apiKeyDescription: 'OpenAI API 密钥',
  baseUrlLabel: 'API 地址',
  baseUrlDescription: 'API 端点完整前缀（含版本段）；插件只在其后拼 /embeddings 与 /models',
  modelLabel: 'Embedding 模型',
  modelDescription: '用于生成文本向量的模型',
  timeoutMsLabel: '请求超时 (ms)',
  timeoutMsDescription: '单次 embedding 请求的超时时间。',
  baseUrlInvalid: 'baseUrl 需为不带用户名或密码的完整 URL',
  baseUrlQuery: 'baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-embedding-openai',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
