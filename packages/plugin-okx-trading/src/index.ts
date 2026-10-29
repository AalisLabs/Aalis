import { tools } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, logger, optional } from '@aalis/core';
import { configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { OkxClient } from './client.js';
import { t } from './texts.js';
import { registerAccountTools } from './tools/account.js';
import { registerAlgoTools } from './tools/algo.js';
import { registerMarketTools } from './tools/market.js';
import { registerOrderQueryTools } from './tools/orders.js';
import { registerRubikTools } from './tools/rubik.js';
import { registerTradeTools } from './tools/trade.js';
import { registerTransferTools } from './tools/transfer.js';

const configSchema = defineConfig({
  apiKey: {
    type: 'string',
    label: 'API Key',
    required: true,
    secret: true,
    description: t('apiKeyDescription'),
    onInvalid: 'error',
  },
  secretKey: { type: 'string', label: 'Secret Key', required: true, secret: true, onInvalid: 'error' },
  passphrase: {
    type: 'string',
    label: 'Passphrase',
    required: true,
    secret: true,
    description: t('passphraseDescription'),
    onInvalid: 'error',
  },
  baseUrl: {
    type: 'string',
    label: t('baseUrlLabel'),
    default: 'https://www.okx.com',
    onInvalid: 'error',
    description: t('baseUrlDescription'),
  },
  demo: {
    type: 'boolean',
    label: t('demoLabel'),
    default: true,
    onInvalid: 'error',
    description: t('demoDescription'),
  },
  confirmRealMoney: {
    type: 'boolean',
    label: t('confirmRealMoneyLabel'),
    default: false,
    onInvalid: 'error',
    description: t('confirmRealMoneyDescription'),
  },
  timeoutMs: { type: 'number', label: t('timeoutMsLabel'), default: 15000 },
  enableTrading: {
    type: 'boolean',
    label: t('enableTradingLabel'),
    default: true,
    onInvalid: 'error',
    description: t('enableTradingDescription'),
  },
  enableAlgo: {
    type: 'boolean',
    label: t('enableAlgoLabel'),
    default: false,
    onInvalid: 'error',
    description: t('enableAlgoDescription'),
  },
  enableTransfer: {
    type: 'boolean',
    label: t('enableTransferLabel'),
    default: false,
    onInvalid: 'error',
    description: t('enableTransferDescription'),
  },
  defaultPageLimit: {
    type: 'number',
    label: t('defaultPageLimitLabel'),
    default: 20,
    description: t('defaultPageLimitDescription'),
  },
  maxPageLimit: {
    type: 'number',
    label: t('maxPageLimitLabel'),
    default: 100,
    description: t('maxPageLimitDescription'),
  },
});

// ===== 工具权限三分名单（模块级导出，测试做补集断言防漏网）=====

/**
 * 动真金白银 / 改仓位：visibility restricted（最低等级 2，等级 2 起或 owner 可驱动）。
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
 * 不是文件归属——trade/algo/transfer 文件里的查询工具同样在列（按文件包装曾漏掉 9 个同类工具）。
 * 行情/量化数据（market/rubik）是公开数据，
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

const uses = { tools: optional(tools), logger, config };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-okx-trading',
  displayName: t('displayName'),
  subsystem: 'external',
  configSchema,
  uses,
  apply: registerOkxTools,
});

function registerOkxTools({ tools: baseTools, logger, config }: Caps): void {
  const parsed = parseConfig(configSchema, config.use, logger.use);
  if (!URL.canParse(parsed.baseUrl) || new URL(parsed.baseUrl).username || new URL(parsed.baseUrl).password) {
    throw configError(t('baseUrlNotPlain'));
  }
  // 插件在 baseUrl 后面拼路径，带查询串或片段（含末尾单个 ?）时拼出来的地址是坏的，所以按原文判
  if (/[?#]/.test(parsed.baseUrl)) {
    throw configError(t('baseUrlHasQuery'));
  }
  const maxPageLimit = Math.max(1, Math.min(1000, parsed.maxPageLimit || 100));
  const cfg = {
    ...parsed,
    maxPageLimit,
    defaultPageLimit: Math.min(Math.max(1, Math.floor(parsed.defaultPageLimit || 20)), maxPageLimit),
  };

  const client = new OkxClient({
    credentials: { apiKey: cfg.apiKey, secretKey: cfg.secretKey, passphrase: cfg.passphrase },
    baseUrl: cfg.baseUrl,
    demo: cfg.demo,
    timeoutMs: cfg.timeoutMs,
  });

  const modeLabel = cfg.demo ? '模拟盘' : '实盘';
  logger.use.info(`OKX 交易插件已初始化 (${modeLabel})`);

  baseTools.use.registerGroup({
    name: 'okx',
    label: t('displayName'),
    summary: cfg.demo ? t('groupSummaryDemo') : t('groupSummaryLive'),
    description: `OKX 虚拟币交易工具集 (${modeLabel})，提供行情查询、账户管理、下单交易等功能`,
  });

  // 工具代理：自动注入 groups；权限档在这一个点按三分名单派发（见模块级名单注释）。
  const reg: Parameters<typeof registerMarketTools>[0] = tool => {
    const toolName = tool.definition.function.name;
    return baseTools.use.register({
      ...tool,
      groups: ['okx'],
      visibility: MUTATING_OKX_TOOLS.has(toolName) ? 'restricted' : tool.visibility,
      risk: ACCOUNT_READ_OKX_TOOLS.has(toolName) ? 'sensitive' : tool.risk,
    });
  };

  registerMarketTools(reg, client);
  registerRubikTools(reg, client);
  const pageLimit = { defaultLimit: cfg.defaultPageLimit, maxLimit: cfg.maxPageLimit };
  registerAccountTools(reg, client, pageLimit);
  registerOrderQueryTools(reg, client, pageLimit);
  // 实盘安全闸：真实资金交易须显式确认（demo:false 时还要 confirmRealMoney:true），否则只暴露查询工具。
  // 不加逐单人工确认（保留实时/算法交易能力）——以「一次性显式确认 + 启动告警」替代。
  const tradingArmed = cfg.demo || cfg.confirmRealMoney;
  if (!cfg.demo) {
    logger.use.warn(
      cfg.confirmRealMoney
        ? '注意：OKX 处于实盘模式，LLM 可用真实资金下单/撤单/划转/提币，且无逐单人工确认，请确认这是本意。'
        : 'OKX 处于实盘(demo:false)但未设 confirmRealMoney:true，已禁用交易/策略/划转工具（仅保留查询）。',
    );
  }
  if (cfg.enableTrading && tradingArmed) registerTradeTools(reg, client, modeLabel, pageLimit);
  if (cfg.enableAlgo && tradingArmed) registerAlgoTools(reg, client, modeLabel, pageLimit);
  if (cfg.enableTransfer && tradingArmed) registerTransferTools(reg, client, pageLimit);
}
