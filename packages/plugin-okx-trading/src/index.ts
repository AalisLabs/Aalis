import type { ConfigSchema, Context } from '@aalis/core';
import { useToolService } from '@aalis/plugin-tools-api';
import type {} from '@aalis/plugin-webui-api'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
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
export const subsystem = 'external';
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
  confirmRealMoney: {
    type: 'boolean',
    label: '确认实盘风险',
    default: false,
    description:
      '仅当关闭模拟盘(demo:false)、用真实资金时，须显式设为 true 以确认风险；否则不暴露下单/撤单/策略/划转/提币等交易工具，仅保留查询。',
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
  defaultPageLimit: {
    type: 'number',
    label: '分页查询默认条数',
    default: 20,
    description: '查询订单/账单/成交明细等接口，LLM 未传 limit 时使用。',
  },
  maxPageLimit: {
    type: 'number',
    label: '分页查询最大条数',
    default: 100,
    description: 'LLM 传入的 limit 会被 cap 到该值。OKX API 本身单页一般最多 100（个别接口 300）。',
  },
};

export const defaultConfig = {
  apiKey: '',
  secretKey: '',
  passphrase: '',
  baseUrl: 'https://www.okx.com',
  demo: true,
  confirmRealMoney: false,
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
  confirmRealMoney: boolean;
  timeoutMs: number;
  enableTrading: boolean;
  enableAlgo: boolean;
  enableTransfer: boolean;
  defaultPageLimit: number;
  maxPageLimit: number;
}

function resolveConfig(config: Record<string, unknown>): PluginConfig {
  const maxPageLimit = Math.max(1, Math.min(1000, Number(config.maxPageLimit) || 100));
  const defaultPageLimitRaw = Math.max(1, Math.floor(Number(config.defaultPageLimit) || 20));
  return {
    apiKey: (config.apiKey as string) ?? '',
    secretKey: (config.secretKey as string) ?? '',
    passphrase: (config.passphrase as string) ?? '',
    baseUrl: (config.baseUrl as string) ?? 'https://www.okx.com',
    demo: (config.demo as boolean) ?? true,
    confirmRealMoney: (config.confirmRealMoney as boolean) ?? false,
    timeoutMs: (config.timeoutMs as number) ?? 15000,
    enableTrading: (config.enableTrading as boolean) ?? true,
    enableAlgo: (config.enableAlgo as boolean) ?? false,
    enableTransfer: (config.enableTransfer as boolean) ?? false,
    defaultPageLimit: Math.min(defaultPageLimitRaw, maxPageLimit),
    maxPageLimit,
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

  const baseTools = useToolService(ctx);
  baseTools.registerGroup({
    name: 'okx',
    label: 'OKX 交易',
    description: `OKX 虚拟币交易工具集 (${modeLabel})，提供行情查询、账户管理、下单交易等功能`,
  });

  // 动真金白银 / 改仓位的工具：标 restricted（最低等级 2，仅信任档/owner 可驱动）。
  // 堵"任意 visitor 驱动 LLM 用 owner 真钱下单/划转"。不加逐单 confirm —— okx 刻意保留
  // 实时/算法交易能力（见上方实盘安全闸注释），改用「等级门禁 + 一次性显式 confirmRealMoney」。
  const MUTATING_OKX_TOOLS = new Set([
    'okx_place_order',
    'okx_cancel_order',
    'okx_amend_order',
    'okx_set_leverage',
    'okx_set_position_mode',
    'okx_adjust_margin',
    'okx_batch_place_orders',
    'okx_batch_cancel_orders',
    'okx_close_position',
    'okx_place_algo_order',
    'okx_cancel_algo_order',
    'okx_transfer',
  ]);
  // 工具代理：自动注入 groups；动账户的工具自动标 restricted（不公开给低档用户）。
  const reg: Parameters<typeof registerMarketTools>[0] = tool =>
    baseTools.register({
      ...tool,
      groups: ['okx'],
      visibility: MUTATING_OKX_TOOLS.has(tool.definition.function.name) ? 'restricted' : tool.visibility,
    });

  registerMarketTools(reg, client);
  registerRubikTools(reg, client);
  registerAccountTools(reg, client, { defaultLimit: cfg.defaultPageLimit, maxLimit: cfg.maxPageLimit });
  registerOrderQueryTools(reg, client, { defaultLimit: cfg.defaultPageLimit, maxLimit: cfg.maxPageLimit });
  // 实盘安全闸：真实资金交易须显式确认（demo:false 时还要 confirmRealMoney:true），否则只暴露查询工具。
  // 不加逐单人工确认（保留实时/算法交易能力）——以「一次性显式确认 + 启动告警」替代。
  const tradingArmed = cfg.demo || cfg.confirmRealMoney;
  if (!cfg.demo) {
    ctx.logger.warn(
      cfg.confirmRealMoney
        ? '⚠️ OKX 实盘模式：LLM 可用真实资金下单/撤单/划转/提币，且无逐单人工确认，请确认这是本意。'
        : 'OKX 处于实盘(demo:false)但未设 confirmRealMoney:true，已禁用交易/策略/划转工具（仅保留查询）。',
    );
  }
  if (cfg.enableTrading && tradingArmed) registerTradeTools(reg, client, modeLabel);
  if (cfg.enableAlgo && tradingArmed) registerAlgoTools(reg, client, modeLabel);
  if (cfg.enableTransfer && tradingArmed) registerTransferTools(reg, client);
}
