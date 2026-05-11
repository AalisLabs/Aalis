import type { OkxClient } from '../client.js';
import { errJson, type RegFn, truncate } from './_shared.js';

export function registerAlgoTools(reg: RegFn, client: OkxClient, modeLabel: string): void {
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
    handler: async args => {
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
      } catch (e) {
        return errJson(e);
      }
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
    handler: async args => {
      try {
        const r = await client.cancelAlgoOrder([{ algoId: args.algoId as string, instId: args.instId as string }]);
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
    handler: async args => {
      try {
        const r = await client.getPendingAlgoOrders(
          args.ordType as string,
          args.instType as string | undefined,
          args.instId as string | undefined,
        );
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
    handler: async args => {
      try {
        const r = await client.getAlgoOrderHistory(
          args.ordType as string,
          args.instType as string | undefined,
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
