import type { Context, ConfigSchema } from '@aalis/core';
import { OkxClient } from './client.js';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-okx-trading';
export const displayName = 'OKX 交易';
export const inject = { optional: ['tools'] };

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, description: '在 OKX 设置中创建的 API Key' },
  secretKey: { type: 'string', label: 'Secret Key', required: true, secret: true },
  passphrase: { type: 'string', label: 'Passphrase', required: true, secret: true, description: '创建 API 时设定的口令' },
  baseUrl: { type: 'string', label: 'API 地址', default: 'https://www.okx.com', description: '默认实盘地址，可改为自定义域名' },
  demo: { type: 'boolean', label: '模拟盘', default: true, description: '启用后将使用模拟交易环境，强烈建议先在模拟盘测试' },
  timeoutMs: { type: 'number', label: '请求超时 (ms)', default: 15000 },
  enableTrading: { type: 'boolean', label: '启用交易工具', default: true, description: '关闭后仅保留查询类工具，不暴露下单/撤单操作' },
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

/** 安全截断工具结果，避免长数据撑爆上下文 */
function truncate(data: unknown, maxItems = 20): unknown {
  if (Array.isArray(data) && data.length > maxItems) {
    return [...data.slice(0, maxItems), `...（共 ${data.length} 条，已截断）`];
  }
  return data;
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

  // 工具组
  ctx.registerToolGroup({
    name: 'okx',
    label: 'OKX 交易',
    description: `OKX 虚拟币交易工具集 (${modeLabel})，提供行情查询、账户管理、下单交易等功能`,
  });

  // 工具代理：自动注入 groups
  function reg(tool: Parameters<Context['registerTool']>[0]) {
    ctx.registerTool({ ...tool, groups: ['okx'] });
  }

  // ==================== 行情查询（只读） ====================

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_ticker',
        description: '获取某个交易对的最新行情（最新价、24h 涨跌幅、成交量等）。instId 格式示例: BTC-USDT, ETH-USDT-SWAP',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID，如 BTC-USDT' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getTicker(args.instId as string);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_tickers',
        description: '获取某类产品的全部行情概览。instType: SPOT(现货), SWAP(永续), FUTURES(交割), OPTION(期权)',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型: SPOT / SWAP / FUTURES / OPTION' },
          },
          required: ['instType'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getTickers(args.instType as string);
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_candles',
        description: '获取 K 线数据。bar 可选值: 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W, 1M 等。返回数组每个元素为 [时间戳, 开, 高, 低, 收, 成交量, ...]',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
            bar: { type: 'string', description: 'K 线周期，默认 1H' },
            limit: { type: 'number', description: '数据条数，最大 300，默认 50' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const limit = Math.min((args.limit as number) || 50, 300);
        const r = await client.getCandles(args.instId as string, (args.bar as string) || '1H', limit);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_orderbook',
        description: '获取交易深度（买卖盘口），sz 为档位数量，默认 5，最大 400',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
            sz: { type: 'number', description: '档位数量' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getOrderBook(args.instId as string, (args.sz as number) || 5);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_instruments',
        description: '获取可交易产品列表，可用于查看某个交易对是否存在及其合约面值等信息。instType: SPOT / SWAP / FUTURES / OPTION',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型' },
            instId: { type: 'string', description: '可选，查看特定产品' },
          },
          required: ['instType'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getInstruments(args.instType as string, args.instId as string | undefined);
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_mark_price',
        description: '获取标记价格（用于合约清算参考）',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型: SWAP / FUTURES / OPTION' },
            instId: { type: 'string', description: '可选，特定产品' },
          },
          required: ['instType'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getMarkPrice(args.instType as string, args.instId as string | undefined);
        return JSON.stringify(truncate(r.data));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_funding_rate',
        description: '获取永续合约的当前资金费率和下一期预测费率',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '永续合约 ID，如 BTC-USDT-SWAP' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getFundingRate(args.instId as string);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_funding_rate_history',
        description: '获取永续合约历史资金费率，可用于分析费率趋势、做费率套利决策',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '永续合约 ID，如 BTC-USDT-SWAP' },
            limit: { type: 'number', description: '条数，默认 30' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getFundingRateHistory(args.instId as string, (args.limit as number) || 30);
        return JSON.stringify(truncate(r.data, 50));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_price_limit',
        description: '获取合约的限价范围（涨跌停价格），下单前检查避免废单',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getPriceLimit(args.instId as string);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_open_interest',
        description: '获取合约持仓总量（全网多空总仓位），判断市场热度和方向',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型: SWAP / FUTURES / OPTION' },
            instId: { type: 'string', description: '可选，特定产品' },
          },
          required: ['instType'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getOpenInterest(args.instType as string, args.instId as string | undefined);
        return JSON.stringify(truncate(r.data));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_trades',
        description: '获取市场近期成交记录（逐笔成交），判断实时买卖气氛和成交密度',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
            limit: { type: 'number', description: '条数，默认 30' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getTrades(args.instId as string, (args.limit as number) || 30);
        return JSON.stringify(truncate(r.data, 50));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_history_candles',
        description: '获取更久远的历史 K 线数据（用于长周期分析、回测）。支持 after 参数翻页获取更早数据',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
            bar: { type: 'string', description: 'K 线周期: 1m/5m/15m/30m/1H/4H/1D/1W/1M' },
            limit: { type: 'number', description: '数据条数，最大 100' },
            after: { type: 'string', description: '时间戳（ms），获取此时间之前的数据' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const limit = Math.min((args.limit as number) || 100, 100);
        const r = await client.getHistoryCandles(args.instId as string, (args.bar as string) || '1D', limit, args.after as string | undefined);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_index_tickers',
        description: '获取指数行情（综合多交易所价格的指数价格），可用于跨所套利分析',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '指数 ID，如 BTC-USDT' },
            quoteCcy: { type: 'string', description: '计价货币，如 USDT（查该币下所有指数）' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getIndexTickers(args.instId as string | undefined, args.quoteCcy as string | undefined);
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_index_candles',
        description: '获取指数 K 线数据',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '指数 ID' },
            bar: { type: 'string', description: 'K 线周期' },
            limit: { type: 'number', description: '条数' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getIndexCandles(args.instId as string, (args.bar as string) || '1H', (args.limit as number) || 50);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_mark_price_candles',
        description: '获取标记价格 K 线（合约清算参考价的历史走势）',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
            bar: { type: 'string', description: 'K 线周期' },
            limit: { type: 'number', description: '条数' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getMarkPriceCandles(args.instId as string, (args.bar as string) || '1H', (args.limit as number) || 50);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_24h_volume',
        description: '获取 OKX 平台 24 小时总成交量，判断整体市场活跃度',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    handler: async () => {
      try {
        const r = await client.get24hVolume();
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  // ==================== 交易大数据（Rubik） ====================

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_long_short_ratio',
        description: '获取多空持仓人数比，判断市场情绪方向。period: 5m/1H/1D',
        parameters: {
          type: 'object',
          properties: {
            ccy: { type: 'string', description: '币种，如 BTC' },
            period: { type: 'string', description: '时间周期: 5m / 1H / 1D' },
          },
          required: ['ccy'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getLongShortRatio(args.ccy as string, (args.period as string) || '1D');
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_contract_oi_volume',
        description: '获取合约持仓量及交易量历史数据，分析资金流入流出',
        parameters: {
          type: 'object',
          properties: {
            ccy: { type: 'string', description: '币种' },
            period: { type: 'string', description: '时间周期: 5m / 1H / 1D' },
          },
          required: ['ccy'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getContractOpenInterestVolume(args.ccy as string, (args.period as string) || '1D');
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_taker_volume',
        description: '获取 Taker 主动买入/卖出量，判断买方卖方力量对比。instType: SPOT(现货) / FUTURES(合约)',
        parameters: {
          type: 'object',
          properties: {
            ccy: { type: 'string', description: '币种' },
            instType: { type: 'string', description: '产品类型: SPOT / FUTURES' },
            period: { type: 'string', description: '时间周期: 5m / 1H / 1D' },
          },
          required: ['ccy', 'instType'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getTakerVolume(args.ccy as string, args.instType as string, (args.period as string) || '1D');
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  // ==================== 账户查询 ====================

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_balance',
        description: '查询交易账户余额。可指定币种，不指定则返回全部',
        parameters: {
          type: 'object',
          properties: {
            ccy: { type: 'string', description: '币种，如 USDT, BTC。留空查全部' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getBalance(args.ccy as string | undefined);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_positions',
        description: '查询当前持仓。可按产品类型或产品 ID 过滤',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型: SPOT / SWAP / FUTURES / OPTION / MARGIN' },
            instId: { type: 'string', description: '可选，特定产品 ID' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getPositions(args.instType as string | undefined, args.instId as string | undefined);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_account_config',
        description: '查询账户配置（账户模式、持仓模式、交易手续费等级等）',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    handler: async () => {
      try {
        const r = await client.getAccountConfig();
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_asset_balances',
        description: '查询资金账户余额（非交易账户），如充值到账但未划转的资产',
        parameters: {
          type: 'object',
          properties: {
            ccy: { type: 'string', description: '币种，留空查全部' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getAssetBalances(args.ccy as string | undefined);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_leverage_info',
        description: '查询某个产品当前设置的杠杆倍数',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
            mgnMode: { type: 'string', description: '保证金模式: cross / isolated' },
          },
          required: ['instId', 'mgnMode'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getLeverageInfo(args.instId as string, args.mgnMode as 'cross' | 'isolated');
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_max_size',
        description: '查询某个产品最大可交易数量（考虑余额、杠杆、保证金等），下单前推荐先查询',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
            tdMode: { type: 'string', description: '交易模式: cash / cross / isolated' },
            px: { type: 'string', description: '可选，委托价格（用于计算限价单最大量）' },
          },
          required: ['instId', 'tdMode'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getMaxSize(args.instId as string, args.tdMode as string, args.px as string | undefined);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_max_avail_size',
        description: '查询某个产品最大可用余额（可开仓量）',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
            tdMode: { type: 'string', description: '交易模式: cash / cross / isolated' },
          },
          required: ['instId', 'tdMode'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getMaxAvailSize(args.instId as string, args.tdMode as string);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_risk_state',
        description: '查询账户风险状态（保证金率、风险等级等），判断是否接近强平',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    handler: async () => {
      try {
        const r = await client.getRiskState();
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_bills',
        description: '查询交易账户近 7 天账单流水（盈亏、手续费、资金费明细）',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型' },
            ccy: { type: 'string', description: '币种' },
            type: { type: 'string', description: '账单类型: 1=划转 2=交易 3=交割 4=强平 5=保证金划转 等' },
            limit: { type: 'number', description: '条数，默认 20' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getBills(args.instType as string | undefined, args.ccy as string | undefined, args.type as string | undefined, (args.limit as number) || 20);
        return JSON.stringify(truncate(r.data));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_bills_archive',
        description: '查询交易账户近 3 个月账单流水（更长周期的盈亏回顾）',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型' },
            ccy: { type: 'string', description: '币种' },
            type: { type: 'string', description: '账单类型' },
            limit: { type: 'number', description: '条数' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getBillsArchive(args.instType as string | undefined, args.ccy as string | undefined, args.type as string | undefined, (args.limit as number) || 20);
        return JSON.stringify(truncate(r.data));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_trade_fee',
        description: '查询当前手续费费率（maker/taker），辅助计算交易成本',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型: SPOT / SWAP / FUTURES / OPTION' },
            instId: { type: 'string', description: '可选，查询特定产品费率' },
          },
          required: ['instType'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getTradeFee(args.instType as string, args.instId as string | undefined);
        return JSON.stringify(r.data);
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_positions_history',
        description: '查询已平仓的持仓历史（含盈亏统计），复盘交易表现',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型' },
            instId: { type: 'string', description: '产品 ID' },
            limit: { type: 'number', description: '条数，默认 20' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getPositionsHistory(args.instType as string | undefined, args.instId as string | undefined, (args.limit as number) || 20);
        return JSON.stringify(truncate(r.data));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_interest_accrued',
        description: '查询利息累计数据（借币利息），管理资金成本',
        parameters: {
          type: 'object',
          properties: {
            instId: { type: 'string', description: '产品 ID' },
            ccy: { type: 'string', description: '币种' },
            limit: { type: 'number', description: '条数' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getInterestAccrued(args.instId as string | undefined, args.ccy as string | undefined, (args.limit as number) || 20);
        return JSON.stringify(truncate(r.data));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_currencies',
        description: '获取 OKX 支持的全部币种列表及其充提配置',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    handler: async () => {
      try {
        const r = await client.getCurrencies();
        return JSON.stringify(truncate(r.data, 50));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  // ==================== 订单查询 ====================

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_pending_orders',
        description: '查询当前未成交的挂单',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型' },
            instId: { type: 'string', description: '产品 ID' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getPendingOrders(args.instType as string | undefined, args.instId as string | undefined);
        return JSON.stringify(truncate(r.data));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_order_history',
        description: '查询近 7 天历史订单。instType 必填',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型: SPOT / SWAP / FUTURES / OPTION' },
            instId: { type: 'string', description: '可选，特定产品' },
            limit: { type: 'number', description: '返回条数，默认 20' },
          },
          required: ['instType'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getOrderHistory(args.instType as string, args.instId as string | undefined, (args.limit as number) || 20);
        return JSON.stringify(truncate(r.data));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_fills',
        description: '查询近 3 天成交明细',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型' },
            instId: { type: 'string', description: '产品 ID' },
            limit: { type: 'number', description: '条数' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      try {
        const r = await client.getFills(args.instType as string | undefined, args.instId as string | undefined, (args.limit as number) || 20);
        return JSON.stringify(truncate(r.data));
      } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
    },
  });

  // ==================== 交易操作（涉及资金） ====================

  if (cfg.enableTrading) {
    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_place_order',
          description: `下单交易 (${modeLabel})。现货用 tdMode=cash，合约用 cross/isolated。市价单不需要 px，限价单必须指定 px。sz 为交易数量。`,
          parameters: {
            type: 'object',
            properties: {
              instId: { type: 'string', description: '产品 ID，如 BTC-USDT' },
              tdMode: { type: 'string', description: '交易模式: cash(现货) / cross(全仓) / isolated(逐仓)' },
              side: { type: 'string', description: '方向: buy / sell' },
              ordType: { type: 'string', description: '订单类型: market(市价) / limit(限价) / post_only / fok / ioc' },
              sz: { type: 'string', description: '数量' },
              px: { type: 'string', description: '价格（限价单必填）' },
              posSide: { type: 'string', description: '持仓方向: long / short / net（双向持仓时需指定）' },
              tgtCcy: { type: 'string', description: '市价单的计量单位: base_ccy(交易货币) / quote_ccy(计价货币)' },
            },
            required: ['instId', 'tdMode', 'side', 'ordType', 'sz'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.placeOrder({
            instId: args.instId as string,
            tdMode: args.tdMode as 'cash' | 'cross' | 'isolated',
            side: args.side as 'buy' | 'sell',
            ordType: args.ordType as 'market' | 'limit' | 'post_only' | 'fok' | 'ioc',
            sz: args.sz as string,
            px: args.px as string | undefined,
            posSide: args.posSide as 'long' | 'short' | 'net' | undefined,
            tgtCcy: args.tgtCcy as 'base_ccy' | 'quote_ccy' | undefined,
          });
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_cancel_order',
          description: '撤销一笔订单。需提供 instId + ordId 或 clOrdId',
          parameters: {
            type: 'object',
            properties: {
              instId: { type: 'string', description: '产品 ID' },
              ordId: { type: 'string', description: '订单 ID' },
              clOrdId: { type: 'string', description: '客户自定义订单 ID' },
            },
            required: ['instId'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.cancelOrder(args.instId as string, args.ordId as string | undefined, args.clOrdId as string | undefined);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_amend_order',
          description: '修改未成交订单的价格或数量',
          parameters: {
            type: 'object',
            properties: {
              instId: { type: 'string', description: '产品 ID' },
              ordId: { type: 'string', description: '订单 ID' },
              clOrdId: { type: 'string', description: '客户自定义订单 ID' },
              newSz: { type: 'string', description: '新数量' },
              newPx: { type: 'string', description: '新价格' },
            },
            required: ['instId'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.amendOrder({
            instId: args.instId as string,
            ordId: args.ordId as string | undefined,
            clOrdId: args.clOrdId as string | undefined,
            newSz: args.newSz as string | undefined,
            newPx: args.newPx as string | undefined,
          });
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_set_leverage',
          description: '设置合约杠杆倍数',
          parameters: {
            type: 'object',
            properties: {
              instId: { type: 'string', description: '产品 ID' },
              lever: { type: 'string', description: '杠杆倍数' },
              mgnMode: { type: 'string', description: '保证金模式: cross / isolated' },
              posSide: { type: 'string', description: '持仓方向 (双向持仓时需要): long / short' },
            },
            required: ['instId', 'lever', 'mgnMode'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.setLeverage(
            args.instId as string,
            args.lever as string,
            args.mgnMode as 'cross' | 'isolated',
            args.posSide as string | undefined,
          );
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_set_position_mode',
          description: `设置持仓模式 (${modeLabel})。long_short_mode=双向持仓, net_mode=单向持仓`,
          parameters: {
            type: 'object',
            properties: {
              posMode: { type: 'string', description: '持仓模式: long_short_mode / net_mode' },
            },
            required: ['posMode'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.setPositionMode(args.posMode as 'long_short_mode' | 'net_mode');
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_adjust_margin',
          description: `调整逐仓保证金 (${modeLabel})。可以增加或减少某个仓位的保证金`,
          parameters: {
            type: 'object',
            properties: {
              instId: { type: 'string', description: '产品 ID' },
              posSide: { type: 'string', description: '持仓方向: long / short / net' },
              type: { type: 'string', description: '调整类型: add(增加) / reduce(减少)' },
              amt: { type: 'string', description: '调整数量' },
            },
            required: ['instId', 'posSide', 'type', 'amt'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.adjustMarginBalance(args.instId as string, args.posSide as string, args.type as 'add' | 'reduce', args.amt as string);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_batch_place_orders',
          description: `批量下单 (${modeLabel})，一次最多 20 笔。传入订单数组，每个元素同单笔下单参数`,
          parameters: {
            type: 'object',
            properties: {
              orders: {
                type: 'array',
                description: '订单数组',
                items: {
                  type: 'object',
                  properties: {
                    instId: { type: 'string' },
                    tdMode: { type: 'string' },
                    side: { type: 'string' },
                    ordType: { type: 'string' },
                    sz: { type: 'string' },
                    px: { type: 'string' },
                    posSide: { type: 'string' },
                  },
                  required: ['instId', 'tdMode', 'side', 'ordType', 'sz'],
                },
              },
            },
            required: ['orders'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const orders = args.orders as Array<{ instId: string; tdMode: string; side: string; ordType: string; sz: string; px?: string; posSide?: string; tgtCcy?: string; clOrdId?: string }>;
          const r = await client.batchPlaceOrders(orders);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_batch_cancel_orders',
          description: `批量撤单 (${modeLabel})，一次最多 20 笔`,
          parameters: {
            type: 'object',
            properties: {
              orders: {
                type: 'array',
                description: '撤单数组',
                items: {
                  type: 'object',
                  properties: {
                    instId: { type: 'string' },
                    ordId: { type: 'string' },
                    clOrdId: { type: 'string' },
                  },
                  required: ['instId'],
                },
              },
            },
            required: ['orders'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.batchCancelOrders(args.orders as Array<{ instId: string; ordId?: string; clOrdId?: string }>);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_close_position',
          description: `市价全部平仓 (${modeLabel})。快速清仓指定产品的全部仓位`,
          parameters: {
            type: 'object',
            properties: {
              instId: { type: 'string', description: '产品 ID' },
              mgnMode: { type: 'string', description: '保证金模式: cross / isolated' },
              posSide: { type: 'string', description: '持仓方向（双向持仓时必填）: long / short' },
            },
            required: ['instId', 'mgnMode'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.closePosition(args.instId as string, args.mgnMode as 'cross' | 'isolated', args.posSide as string | undefined);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_get_order_detail',
          description: '查询单笔订单详情（状态、成交均价、手续费等）',
          parameters: {
            type: 'object',
            properties: {
              instId: { type: 'string', description: '产品 ID' },
              ordId: { type: 'string', description: '订单 ID（ordId 与 clOrdId 至少填一个）' },
              clOrdId: { type: 'string', description: '客户自定义订单 ID' },
            },
            required: ['instId'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.getOrderDetail(args.instId as string, args.ordId as string | undefined, args.clOrdId as string | undefined);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_get_fills_archive',
          description: '查询近 3 个月成交明细（更长周期的交易复盘）',
          parameters: {
            type: 'object',
            properties: {
              instType: { type: 'string', description: '产品类型: SPOT / SWAP / FUTURES / OPTION' },
              instId: { type: 'string', description: '产品 ID' },
              limit: { type: 'number', description: '条数' },
            },
            required: ['instType'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.getFillsArchive(args.instType as string, args.instId as string | undefined, (args.limit as number) || 20);
          return JSON.stringify(truncate(r.data));
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });
  }

  // ==================== 策略委托 ====================

  if (cfg.enableAlgo) {
    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_place_algo_order',
          description: `策略委托下单 (${modeLabel})。支持止盈止损(conditional)、双向止盈止损(oco)、计划委托(trigger)`,
          parameters: {
            type: 'object',
            properties: {
              instId: { type: 'string', description: '产品 ID' },
              tdMode: { type: 'string', description: '交易模式: cash / cross / isolated' },
              side: { type: 'string', description: '方向: buy / sell' },
              ordType: { type: 'string', description: '策略类型: conditional / oco / trigger' },
              sz: { type: 'string', description: '数量' },
              posSide: { type: 'string', description: '持仓方向' },
              tpTriggerPx: { type: 'string', description: '止盈触发价' },
              tpOrdPx: { type: 'string', description: '止盈委托价（-1 表示市价）' },
              slTriggerPx: { type: 'string', description: '止损触发价' },
              slOrdPx: { type: 'string', description: '止损委托价（-1 表示市价）' },
              triggerPx: { type: 'string', description: '计划委托触发价' },
              orderPx: { type: 'string', description: '计划委托委托价（-1 表示市价）' },
            },
            required: ['instId', 'tdMode', 'side', 'ordType', 'sz'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.placeAlgoOrder({
            instId: args.instId as string,
            tdMode: args.tdMode as 'cash' | 'cross' | 'isolated',
            side: args.side as 'buy' | 'sell',
            ordType: args.ordType as 'conditional' | 'oco' | 'trigger',
            sz: args.sz as string,
            posSide: args.posSide as 'long' | 'short' | 'net' | undefined,
            tpTriggerPx: args.tpTriggerPx as string | undefined,
            tpOrdPx: args.tpOrdPx as string | undefined,
            slTriggerPx: args.slTriggerPx as string | undefined,
            slOrdPx: args.slOrdPx as string | undefined,
            triggerPx: args.triggerPx as string | undefined,
            orderPx: args.orderPx as string | undefined,
          });
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_cancel_algo_order',
          description: '撤销策略委托订单',
          parameters: {
            type: 'object',
            properties: {
              algoId: { type: 'string', description: '策略订单 ID' },
              instId: { type: 'string', description: '产品 ID' },
            },
            required: ['algoId', 'instId'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.cancelAlgoOrder([{ algoId: args.algoId as string, instId: args.instId as string }]);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_get_pending_algo_orders',
          description: '查询未完成的策略委托',
          parameters: {
            type: 'object',
            properties: {
              ordType: { type: 'string', description: '策略类型: conditional / oco / trigger' },
              instType: { type: 'string', description: '产品类型' },
              instId: { type: 'string', description: '产品 ID' },
            },
            required: ['ordType'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.getPendingAlgoOrders(args.ordType as string, args.instType as string | undefined, args.instId as string | undefined);
          return JSON.stringify(truncate(r.data));
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_get_algo_order_history',
          description: '查询策略委托历史订单（已完成/已取消/已触发的止盈止损和计划委托）',
          parameters: {
            type: 'object',
            properties: {
              ordType: { type: 'string', description: '订单类型: conditional / oco / trigger' },
              instType: { type: 'string', description: '产品类型: SPOT / SWAP / FUTURES / OPTION' },
              instId: { type: 'string', description: '产品 ID' },
              limit: { type: 'number', description: '条数' },
            },
            required: ['ordType'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.getAlgoOrderHistory(args.ordType as string, args.instType as string | undefined, args.instId as string | undefined, (args.limit as number) || 20);
          return JSON.stringify(truncate(r.data));
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });
  }

  // ==================== 资金划转 ====================

  if (cfg.enableTransfer) {
    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_transfer',
          description: '资金划转。from/to 账户类型编号: 6=资金账户, 18=交易账户',
          parameters: {
            type: 'object',
            properties: {
              ccy: { type: 'string', description: '币种' },
              amt: { type: 'string', description: '数量' },
              from: { type: 'string', description: '转出账户: 6(资金) / 18(交易)' },
              to: { type: 'string', description: '转入账户: 6(资金) / 18(交易)' },
            },
            required: ['ccy', 'amt', 'from', 'to'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.transfer(args.ccy as string, args.amt as string, args.from as string, args.to as string);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_get_transfer_state',
          description: '查询资金划转状态',
          parameters: {
            type: 'object',
            properties: {
              transId: { type: 'string', description: '划转 ID' },
            },
            required: ['transId'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.getTransferState(args.transId as string);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_get_asset_bills',
          description: '查询资金账户账单流水（充值、提现、划转记录）',
          parameters: {
            type: 'object',
            properties: {
              ccy: { type: 'string', description: '币种' },
              type: { type: 'string', description: '账单类型' },
              limit: { type: 'number', description: '条数' },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.getAssetBills(args.ccy as string | undefined, args.type as string | undefined, (args.limit as number) || 20);
          return JSON.stringify(truncate(r.data));
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_get_deposit_address',
          description: '获取某个币种的充值地址',
          parameters: {
            type: 'object',
            properties: {
              ccy: { type: 'string', description: '币种，如 BTC / ETH / USDT' },
            },
            required: ['ccy'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.getDepositAddress(args.ccy as string);
          return JSON.stringify(r.data);
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_get_deposit_history',
          description: '查询充值记录',
          parameters: {
            type: 'object',
            properties: {
              ccy: { type: 'string', description: '币种' },
              limit: { type: 'number', description: '条数' },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.getDepositHistory(args.ccy as string | undefined, (args.limit as number) || 20);
          return JSON.stringify(truncate(r.data));
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });

    reg({
      definition: {
        type: 'function',
        function: {
          name: 'okx_get_withdrawal_history',
          description: '查询提现记录',
          parameters: {
            type: 'object',
            properties: {
              ccy: { type: 'string', description: '币种' },
              limit: { type: 'number', description: '条数' },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        try {
          const r = await client.getWithdrawalHistory(args.ccy as string | undefined, (args.limit as number) || 20);
          return JSON.stringify(truncate(r.data));
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
    });
  }
}
