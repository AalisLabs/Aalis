import type { ConfigSchema, Context } from '@aalis/core';
import { OkxClient } from './client.js';
import { registerAccountTools } from './tools/account.js';
import { registerAlgoTools } from './tools/algo.js';
import { registerMarketTools } from './tools/market.js';
import { registerOrderQueryTools } from './tools/orders.js';
import { registerRubikTools } from './tools/rubik.js';
import { registerTradeTools } from './tools/trade.js';
import { registerTransferTools } from './tools/transfer.js';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-okx-trading';
export const displayName = 'OKX 交易';
export const inject = { optional: ['tools'] };

export const configSchema: ConfigSchema = {
  apiKey: {
    type: 'string',
    label: 'API Key',
    required: true,
    secret: true,
    description: '在 OKX 设置中创建的 API Key',
  },
  secretKey: { type: 'string', label: 'Secret Key', required: true, secret: true },
  passphrase: {
    type: 'string',
    label: 'Passphrase',
    required: true,
    secret: true,
    description: '创建 API 时设定的口令',
  },
  baseUrl: {
    type: 'string',
    label: 'API 地址',
    default: 'https://www.okx.com',
    description: '默认实盘地址，可改为自定义域名',
  },
  demo: {
    type: 'boolean',
    label: '模拟盘',
    default: true,
    description: '启用后将使用模拟交易环境，强烈建议先在模拟盘测试',
  },
  timeoutMs: { type: 'number', label: '请求超时 (ms)', default: 15000 },
  enableTrading: {
    type: 'boolean',
    label: '启用交易工具',
    default: true,
    description: '关闭后仅保留查询类工具，不暴露下单/撤单操作',
  },
  enableAlgo: { type: 'boolean', label: '启用策略委托', default: false, description: '启用止盈止损 / 计划委托工具' },
  enableTransfer: { type: 'boolean', label: '启用资金划转', default: false, description: '启用资金账户划转工具' },
};

export const defaultConfig = {
  apiKey: '',
  secretKey: '',
  passphrase: '',
  baseUrl: 'https://www.okx.com',
  demo: true,
  timeoutMs: 15000,
  enableTrading: true,
  enableAlgo: false,
  enableTransfer: false,
};

interface PluginConfig {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  baseUrl: string;
  demo: boolean;
  timeoutMs: number;
  enableTrading: boolean;
  enableAlgo: boolean;
  enableTransfer: boolean;
}

function resolveConfig(config: Record<string, unknown>): PluginConfig {
  return {
    apiKey: (config.apiKey as string) ?? '',
    secretKey: (config.secretKey as string) ?? '',
    passphrase: (config.passphrase as string) ?? '',
    baseUrl: (config.baseUrl as string) ?? 'https://www.okx.com',
    demo: (config.demo as boolean) ?? true,
    timeoutMs: (config.timeoutMs as number) ?? 15000,
    enableTrading: (config.enableTrading as boolean) ?? true,
    enableAlgo: (config.enableAlgo as boolean) ?? false,
    enableTransfer: (config.enableTransfer as boolean) ?? false,
  };
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);

  if (!cfg.apiKey || !cfg.secretKey || !cfg.passphrase) {
    ctx.logger.warn('OKX 交易插件缺少 API 凭证，已跳过初始化');
    return;
  }

  const client = new OkxClient({
    credentials: { apiKey: cfg.apiKey, secretKey: cfg.secretKey, passphrase: cfg.passphrase },
    baseUrl: cfg.baseUrl,
    demo: cfg.demo,
    timeoutMs: cfg.timeoutMs,
  });

  const modeLabel = cfg.demo ? '模拟盘' : '实盘';
  ctx.logger.info(`OKX 交易插件已初始化 (${modeLabel})`);

  ctx.registerToolGroup({
    name: 'okx',
    label: 'OKX 交易',
    description: `OKX 虚拟币交易工具集 (${modeLabel})，提供行情查询、账户管理、下单交易等功能`,
  });

  // 工具代理：自动注入 groups
  const reg: Parameters<typeof registerMarketTools>[0] = tool => {
    ctx.registerTool({ ...tool, groups: ['okx'] });
  };

  registerMarketTools(reg, client);
  registerRubikTools(reg, client);
  registerAccountTools(reg, client);
  registerOrderQueryTools(reg, client);
  if (cfg.enableTrading) registerTradeTools(reg, client, modeLabel);
  if (cfg.enableAlgo) registerAlgoTools(reg, client, modeLabel);
  if (cfg.enableTransfer) registerTransferTools(reg, client);
}
