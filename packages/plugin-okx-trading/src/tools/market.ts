import type { OkxClient } from '../client.js';
import { errJson, type RegFn, truncate } from './_shared.js';

export function registerMarketTools(reg: RegFn, client: OkxClient): void {
  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_ticker',
        description:
          '获取某个交易对的最新行情（最新价、24h 涨跌幅、成交量等）。instId 格式示例: BTC-USDT, ETH-USDT-SWAP',
        parameters: {
          type: 'object',
          properties: { instId: { type: 'string', description: '产品 ID，如 BTC-USDT' } },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getTicker(args.instId as string);
        return JSON.stringify(r.data);
      } catch (e) {
        return errJson(e);
      }
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
          properties: { instType: { type: 'string', description: '产品类型: SPOT / SWAP / FUTURES / OPTION' } },
          required: ['instType'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getTickers(args.instType as string);
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) {
        return errJson(e);
      }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_candles',
        description:
          '获取 K 线数据。bar 可选值: 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W, 1M 等。返回数组每个元素为 [时间戳, 开, 高, 低, 收, 成交量, ...]',
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
    handler: async args => {
      try {
        const limit = Math.min((args.limit as number) || 50, 300);
        const r = await client.getCandles(args.instId as string, (args.bar as string) || '1H', limit);
        return JSON.stringify(r.data);
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.getOrderBook(args.instId as string, (args.sz as number) || 5);
        return JSON.stringify(r.data);
      } catch (e) {
        return errJson(e);
      }
    },
  });

  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_instruments',
        description:
          '获取可交易产品列表，可用于查看某个交易对是否存在及其合约面值等信息。instType: SPOT / SWAP / FUTURES / OPTION',
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
    handler: async args => {
      try {
        const r = await client.getInstruments(args.instType as string, args.instId as string | undefined);
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.getMarkPrice(args.instType as string, args.instId as string | undefined);
        return JSON.stringify(truncate(r.data));
      } catch (e) {
        return errJson(e);
      }
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
          properties: { instId: { type: 'string', description: '永续合约 ID，如 BTC-USDT-SWAP' } },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getFundingRate(args.instId as string);
        return JSON.stringify(r.data);
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.getFundingRateHistory(args.instId as string, (args.limit as number) || 30);
        return JSON.stringify(truncate(r.data, 50));
      } catch (e) {
        return errJson(e);
      }
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
          properties: { instId: { type: 'string', description: '产品 ID' } },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getPriceLimit(args.instId as string);
        return JSON.stringify(r.data);
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.getOpenInterest(args.instType as string, args.instId as string | undefined);
        return JSON.stringify(truncate(r.data));
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.getTrades(args.instId as string, (args.limit as number) || 30);
        return JSON.stringify(truncate(r.data, 50));
      } catch (e) {
        return errJson(e);
      }
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
            limit: { type: 'number', description: '数据条数,最大 100' },
            after: { type: 'string', description: '时间戳（ms），获取此时间之前的数据' },
          },
          required: ['instId'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const limit = Math.min((args.limit as number) || 100, 100);
        const r = await client.getHistoryCandles(
          args.instId as string,
          (args.bar as string) || '1D',
          limit,
          args.after as string | undefined,
        );
        return JSON.stringify(r.data);
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.getIndexTickers(args.instId as string | undefined, args.quoteCcy as string | undefined);
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.getIndexCandles(
          args.instId as string,
          (args.bar as string) || '1H',
          (args.limit as number) || 50,
        );
        return JSON.stringify(r.data);
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.getMarkPriceCandles(
          args.instId as string,
          (args.bar as string) || '1H',
          (args.limit as number) || 50,
        );
        return JSON.stringify(r.data);
      } catch (e) {
        return errJson(e);
      }
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
      } catch (e) {
        return errJson(e);
      }
    },
  });
}
