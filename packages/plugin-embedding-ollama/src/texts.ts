// 本插件自己的原文字典：配置项、配置报错、请求报错与诊断项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  baseUrlLabel: 'Ollama 地址',
  baseUrlDescription: '本地 Ollama 服务的 HTTP 地址',
  modelLabel: 'Embedding 模型',
  modelDescription: '用于生成文本向量的模型',
  timeoutMsLabel: '请求超时 (ms)',
  timeoutMsDescription: '单次 embedding 请求超时时间',
  retriesLabel: '失败重试次数',
  retriesDescription: 'fetch 失败或 5xx 时的重试次数',
  baseUrlInvalid: 'baseUrl 需为不带用户名或密码的完整 URL',
  baseUrlQuery: 'baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径',
  statusFailed: 'Ollama embedding 请求失败 ({endpoint}): {status} {statusText}',
  statusFailedDetail: 'Ollama embedding 请求失败 ({endpoint}): {status} {statusText} —— {detail}',
  probeTimeout: '探测超时（{ms}ms）',
  checkOk: 'Ollama Embedding 可用 ({model} @ {baseUrl})',
  checkFailed: 'Ollama Embedding 不可用 ({model} @ {baseUrl})——向量记忆不工作',
  checkFix: '确认 Ollama 在运行，并已执行 ollama pull {model}（或把配置项 model 改成本机已有的嵌入模型）',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-embedding-ollama',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
