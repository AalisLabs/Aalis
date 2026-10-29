// 本插件自己的原文字典：配置项与配置报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  modelLabel: '模型',
  timeoutMsLabel: '请求超时 (ms)',
  timeoutMsDescription: '整段上传+识别的上限。默认取宽（10 分钟）：闸的目的是掐断真正卡死的请求，不是给长音频限速',
  baseUrlInvalid: 'baseUrl 需为不带用户名或密码的完整 URL',
  baseUrlQuery: 'baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-asr-openai', language: 'zh-CN', source: SOURCE, locales: { en } });
