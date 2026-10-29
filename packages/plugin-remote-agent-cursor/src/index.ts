// ============================================================
// @aalis/plugin-remote-agent-cursor — Cursor 云端代理（Cloud Agents API v1）
//
// 以 remote-agent 服务提供者注册。可多实例（多账号或换模型写成 `名:后缀`），消费方按实例 id 精确取。
// apply 只构造提供者、不发任何请求：鉴权与模型参数校验在消费方第一次调 ready() 时做，key 失效或
// 网络不通不会拖住激活。
// ============================================================

import { remoteAgent } from '@aalis/api-remote-agent';
import { config, definePlugin, lifecycle, logger, provide } from '@aalis/core';
import { type ConfigOf, configError, defineConfig, missingConfigError, parseConfig } from '@aalis/schema-config';
import { CursorProvider, type CursorProviderOptions } from './provider.js';
import { t } from './texts.js';

/** 事件流断开后重连的退避起点 */
const RETRY_BASE_MS = 1_000;
/** 事件流过期（410）后轮询一轮状态的间隔 */
const POLL_INTERVAL_MS = 15_000;

const configSchema = defineConfig({
  apiKey: {
    type: 'string',
    label: 'API Key',
    required: true,
    secret: true,
    description: t('apiKeyDescription'),
  },
  baseUrl: {
    type: 'string',
    label: t('baseUrlLabel'),
    default: 'https://api.cursor.com',
    onInvalid: 'error',
    description: t('baseUrlDescription'),
  },
  model: {
    label: t('modelLabel'),
    description: t('modelDescription'),
    fields: {
      id: { type: 'string', label: t('modelIdLabel'), default: 'grok-4.7' },
      params: {
        type: 'map',
        label: t('modelParamsLabel'),
        default: { reasoning_effort: 'high', context: '256k', fast: 'false' },
        onInvalid: 'error',
        description: t('modelParamsDescription'),
      },
    },
  },
  egressMode: {
    type: 'select',
    label: t('egressModeLabel'),
    default: 'unknown',
    options: [
      { label: t('egressNone'), value: 'none' },
      { label: t('egressAllowlist'), value: 'allowlist' },
      { label: t('egressOpen'), value: 'open' },
      { label: t('egressUnknown'), value: 'unknown' },
    ],
    description: t('egressModeDescription'),
  },
  createTimeoutSeconds: {
    type: 'number',
    label: t('createTimeoutSecondsLabel'),
    default: 30,
    min: 5,
    description: t('createTimeoutSecondsDescription'),
  },
  requestTimeoutSeconds: {
    type: 'number',
    label: t('requestTimeoutSecondsLabel'),
    default: 30,
    min: 15,
    description: t('requestTimeoutSecondsDescription'),
  },
  streamIdleSeconds: {
    type: 'number',
    label: t('streamIdleSecondsLabel'),
    default: 60,
    min: 45,
    description: t('streamIdleSecondsDescription'),
  },
  reconcileIgnoreNames: {
    type: 'list',
    label: t('reconcileIgnoreNamesLabel'),
    default: [],
    description: t('reconcileIgnoreNamesDescription'),
  },
});

type ParsedCursorConfig = ConfigOf<typeof configSchema>;

function readOptions(raw: ParsedCursorConfig): CursorProviderOptions {
  const apiKey = raw.apiKey.trim();
  if (!apiKey) throw missingConfigError('apiKey', t('apiKeyNote'));
  const baseUrl = raw.baseUrl || configSchema.baseUrl.default;
  if (!URL.canParse(baseUrl) || new URL(baseUrl).username || new URL(baseUrl).password) {
    throw configError(t('baseUrlNotPlain'));
  }
  // 插件在 baseUrl 后面拼路径，带查询串或片段（含末尾单个 ?）时拼出来的地址是坏的，所以按原文判
  if (/[?#]/.test(baseUrl)) {
    throw configError(t('baseUrlHasQuery'));
  }
  return {
    apiKey,
    baseUrl,
    model: {
      id: raw.model.id || configSchema.model.fields.id.default,
      params: raw.model.params,
    },
    egressMode: raw.egressMode,
    createTimeoutMs: raw.createTimeoutSeconds * 1000,
    requestTimeoutMs: raw.requestTimeoutSeconds * 1000,
    streamIdleMs: raw.streamIdleSeconds * 1000,
    reconcileIgnoreNames: raw.reconcileIgnoreNames,
    retryBaseMs: RETRY_BASE_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

const uses = { provide, lifecycle, logger, config };

export default definePlugin({
  name: '@aalis/plugin-remote-agent-cursor',
  displayName: t('displayName'),
  subsystem: 'external',
  reusable: true,
  configSchema,
  provides: [remoteAgent],
  uses,
  apply({ provide, lifecycle, logger, config }) {
    const parsed = parseConfig(configSchema, config.use, logger.use);
    const options = readOptions(parsed);
    provide.use(remoteAgent, new CursorProvider(options, { logger: logger.use, signal: lifecycle.use.signal }), {
      label: `Cursor / ${options.model.id}`,
    });
  },
});
