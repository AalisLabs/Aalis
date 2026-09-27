// ============================================================
// @aalis/plugin-remote-agent-cursor — Cursor 云端代理（Cloud Agents API v1）
//
// 以 remote-agent 服务提供者注册。可多实例（多账号或换模型写成 `名:后缀`），消费方按实例 id 精确取。
// apply 只构造提供者、不发任何请求：鉴权与模型参数校验在消费方第一次调 ready() 时做，key 失效或
// 网络不通不会拖住激活。
// ============================================================

import { type EgressMode, remoteAgent } from '@aalis/api-remote-agent';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret）
import { config, definePlugin, lifecycle, logger, provide } from '@aalis/core';
import { type ConfigSchema, defaultsFrom, missingConfigError } from '@aalis/schema-config';
import { CursorProvider, type CursorProviderOptions } from './provider.js';

const EGRESS_MODES: readonly EgressMode[] = ['none', 'allowlist', 'open', 'unknown'];

/** 事件流断开后重连的退避起点 */
const RETRY_BASE_MS = 1_000;
/** 事件流过期（410）后轮询一轮状态的间隔 */
const POLL_INTERVAL_MS = 15_000;

const configSchema: ConfigSchema = {
  apiKey: {
    type: 'string',
    label: 'API Key',
    required: true,
    secret: true,
    description: 'Cursor 后台生成的 API key。只在宿主进程里用，不传给远端代理',
  },
  baseUrl: {
    type: 'string',
    label: 'API 地址',
    default: 'https://api.cursor.com',
    description: 'Cloud Agents API 的根地址，插件在其后拼 /v1/…',
  },
  model: {
    label: '模型',
    description:
      '建代理用的模型。参数须写全，并等于 /v1/models 列出的某个变体，第一次使用时校验，不成立时提供者不可用；只写模型 id 会按默认变体（fast、500k）计费',
    fields: {
      id: { type: 'string', label: '模型 id', default: 'grok-4.7' },
      params: {
        type: 'map',
        label: '模型参数',
        default: { reasoning_effort: 'high', context: '256k', fast: 'false' },
        description: '参数名到取值，值一律写字符串（如 fast 写 "false"）',
      },
    },
  },
  egressMode: {
    type: 'select',
    label: '出网方式',
    default: 'unknown',
    options: [
      { label: '不出网', value: 'none' },
      { label: '白名单', value: 'allowlist' },
      { label: '不限', value: 'open' },
      { label: '未知', value: 'unknown' },
    ],
    description:
      'owner 在 Cursor 后台给云端代理设的出网方式。接口读不到它，Aalis 无法核实，白纸页与诊断项标「未核实」；未知按不限计',
  },
  createTimeoutSeconds: {
    type: 'number',
    label: '建代理超时（秒）',
    default: 30,
    min: 5,
    description: '建代理的请求要约 60 秒才回；超时后用同一 agentId 取回，不会重复建',
  },
  requestTimeoutSeconds: {
    type: 'number',
    label: '请求超时（秒）',
    default: 30,
    min: 15,
    description: '其余请求的超时；实测单次请求有时要 5 秒以上',
  },
  streamIdleSeconds: {
    type: 'number',
    label: '事件流空闲超时（秒）',
    default: 60,
    min: 45,
    description: '事件流连上后约 30 秒才有第一次心跳，之后每 15 到 30 秒一次；超过这么久没有任何数据就断开重连',
  },
  reconcileIgnoreNames: {
    type: 'list',
    label: 'owner 自管的代理名',
    default: [],
    description: '列举账号下的代理时跳过这些名字，对账不把它们当作账本外的代理',
  },
};

const DEFAULTS = defaultsFrom(configSchema) as {
  baseUrl: string;
  model: { id: string; params: Record<string, string> };
  createTimeoutSeconds: number;
  requestTimeoutSeconds: number;
  streamIdleSeconds: number;
};

function seconds(value: unknown, fallback: number): number {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback) * 1000;
}

/** 模型参数的值一律按字符串交给接口；yaml 里没加引号的 false、数字照原样转成字符串 */
function readParams(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULTS.model.params };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

function readOptions(raw: Readonly<Record<string, unknown>>): CursorProviderOptions {
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (!apiKey) throw missingConfigError('apiKey', '在 Cursor 后台生成');
  const model = (raw.model ?? {}) as Record<string, unknown>;
  const egressMode = EGRESS_MODES.find(m => m === raw.egressMode) ?? 'unknown';
  return {
    apiKey,
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : DEFAULTS.baseUrl,
    model: {
      id: typeof model.id === 'string' && model.id ? model.id : DEFAULTS.model.id,
      params: readParams(model.params),
    },
    egressMode,
    createTimeoutMs: seconds(raw.createTimeoutSeconds, DEFAULTS.createTimeoutSeconds),
    requestTimeoutMs: seconds(raw.requestTimeoutSeconds, DEFAULTS.requestTimeoutSeconds),
    streamIdleMs: seconds(raw.streamIdleSeconds, DEFAULTS.streamIdleSeconds),
    reconcileIgnoreNames: Array.isArray(raw.reconcileIgnoreNames)
      ? raw.reconcileIgnoreNames.filter((n): n is string => typeof n === 'string')
      : [],
    retryBaseMs: RETRY_BASE_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

const uses = { provide, lifecycle, logger, config };

export default definePlugin({
  name: '@aalis/plugin-remote-agent-cursor',
  displayName: 'Cursor 云端代理',
  subsystem: 'external',
  reusable: true,
  configSchema,
  provides: [remoteAgent],
  uses,
  apply({ provide, lifecycle, logger, config }) {
    const options = readOptions(config);
    provide(remoteAgent, new CursorProvider(options, { logger, signal: lifecycle.signal }), {
      label: `Cursor / ${options.model.id}`,
    });
  },
});
