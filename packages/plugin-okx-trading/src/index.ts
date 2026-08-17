import { useToolService } from '@aalis/api-tools';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { OkxClient } from './client.js';
import { registerAccountTools } from './tools/account.js';
import { registerAlgoTools } from './tools/algo.js';
import { registerMarketTools } from './tools/market.js';
import { registerOrderQueryTools } from './tools/orders.js';
import { registerRubikTools } from './tools/rubik.js';
import { registerTradeTools } from './tools/trade.js';
import { registerTransferTools } from './tools/transfer.js';

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
    default: '',
  },
  secretKey: { type: 'string', label: 'Secret Key', required: true, secret: true, default: '' },
  passphrase: {
    type: 'string',
    label: 'Passphrase',
    required: true,
    secret: true,
    description: '创建 API 时设定的口令',
    default: '',
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

// ===== 工具权限三分名单（模块级导出，测试做补集断言防漏网）=====

/**
 * 动真金白银 / 改仓位：visibility restricted（最低等级 2，仅信任档/owner 可驱动）。
 * 堵"任意 visitor 驱动 LLM 用 owner 真钱下单/划转"。不加逐单 confirm —— okx 刻意保留
 * 实时/算法交易能力（见实盘安全闸注释），改用「等级门禁 + 一次性显式 confirmRealMoney」。
 * 注意：与 ACCOUNT_READ_OKX_TOOLS 必须互斥——capabilityMinLevel 里 risk 会遮蔽
 * visibility，二者同标会把门槛从 2 反降到 1。
 */
export const MUTATING_OKX_TOOLS = new Set([
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

/**
 * 账户读：risk sensitive（挡等级 0 的陌生群成员经 LLM 读 owner 真实资金数据；
 * owner 与已授权用户不受影响）。判据是**语义**（读账户/订单/资金流水/链上地址），
 * 不是文件归属——trade/algo/transfer 文件里的查询工具同样在列（对抗审计抓过
 * 按文件包装漏掉 9 个同类工具的教训）。行情/量化数据（market/rubik）是公开数据，
 * 不在此列，维持 public。
 */
export const ACCOUNT_READ_OKX_TOOLS = new Set([
  // account.ts —— 余额/持仓/账单/杠杆/费率等账户全貌
  'okx_get_account_config',
  'okx_get_asset_balances',
  'okx_get_balance',
  'okx_get_bills',
  'okx_get_bills_archive',
  'okx_get_currencies',
  'okx_get_interest_accrued',
  'okx_get_leverage_info',
  'okx_get_max_avail_size',
  'okx_get_max_size',
  'okx_get_positions',
  'okx_get_positions_history',
  'okx_get_risk_state',
  'okx_get_trade_fee',
  // orders.ts —— 挂单/历史订单/成交
  'okx_get_fills',
  'okx_get_order_history',
  'okx_get_pending_orders',
  // trade.ts 里的查询孪生体
  'okx_get_fills_archive',
  'okx_get_order_detail',
  // transfer.ts —— 资金流水/充提记录/链上充值地址
  'okx_get_asset_bills',
  'okx_get_deposit_address',
  'okx_get_deposit_history',
  'okx_get_transfer_state',
  'okx_get_withdrawal_history',
  // algo.ts —— 算法单查询
  'okx_get_algo_order_history',
  'okx_get_pending_algo_orders',
]);

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

  // 工具代理：自动注入 groups；权限档在这一个点按三分名单派发（见模块级名单注释）。
  const reg: Parameters<typeof registerMarketTools>[0] = tool => {
    const toolName = tool.definition.function.name;
    return baseTools.register({
      ...tool,
      groups: ['okx'],
      visibility: MUTATING_OKX_TOOLS.has(toolName) ? 'restricted' : tool.visibility,
      risk: ACCOUNT_READ_OKX_TOOLS.has(toolName) ? 'sensitive' : tool.risk,
    });
  };

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
