import type { OkxClient } from '../client.js';
import { errJson, type RegFn, truncate } from './_shared.js';

export function registerTradeTools(reg: RegFn, client: OkxClient, modeLabel: string): void {
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
    handler: async args => {
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
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.cancelOrder(
          args.instId as string,
          args.ordId as string | undefined,
          args.clOrdId as string | undefined,
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
    handler: async args => {
      try {
        const r = await client.amendOrder({
          instId: args.instId as string,
          ordId: args.ordId as string | undefined,
          clOrdId: args.clOrdId as string | undefined,
          newSz: args.newSz as string | undefined,
          newPx: args.newPx as string | undefined,
        });
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
    handler: async args => {
      try {
        const r = await client.setLeverage(
          args.instId as string,
          args.lever as string,
          args.mgnMode as 'cross' | 'isolated',
          args.posSide as string | undefined,
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
        name: 'okx_set_position_mode',
        description: `设置持仓模式 (${modeLabel})。long_short_mode=双向持仓, net_mode=单向持仓`,
        parameters: {
          type: 'object',
          properties: { posMode: { type: 'string', description: '持仓模式: long_short_mode / net_mode' } },
          required: ['posMode'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.setPositionMode(args.posMode as 'long_short_mode' | 'net_mode');
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
    handler: async args => {
      try {
        const r = await client.adjustMarginBalance(
          args.instId as string,
          args.posSide as string,
          args.type as 'add' | 'reduce',
          args.amt as string,
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
    handler: async args => {
      try {
        const orders = args.orders as Array<{
          instId: string;
          tdMode: string;
          side: string;
          ordType: string;
          sz: string;
          px?: string;
          posSide?: string;
          tgtCcy?: string;
          clOrdId?: string;
        }>;
        const r = await client.batchPlaceOrders(orders);
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
    handler: async args => {
      try {
        const r = await client.batchCancelOrders(
          args.orders as Array<{ instId: string; ordId?: string; clOrdId?: string }>,
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
    handler: async args => {
      try {
        const r = await client.closePosition(
          args.instId as string,
          args.mgnMode as 'cross' | 'isolated',
          args.posSide as string | undefined,
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
    handler: async args => {
      try {
        const r = await client.getOrderDetail(
          args.instId as string,
          args.ordId as string | undefined,
          args.clOrdId as string | undefined,
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
    handler: async args => {
      try {
        const r = await client.getFillsArchive(
          args.instType as string,
          args.instId as string | undefined,
          (args.limit as number) || 20,
        );
        return JSON.stringify(truncate(r.data));
      } catch (e) {
        return errJson(e);
      }
    },
  });
}
