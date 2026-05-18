import type { OkxClient } from '../client.js';
import { errJson, type PageLimitCfg, pickLimit, type RegFn, truncate } from './_shared.js';

export function registerOrderQueryTools(reg: RegFn, client: OkxClient, pageLimit: PageLimitCfg): void {
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
    handler: async args => {
      try {
        const r = await client.getPendingOrders(args.instType as string | undefined, args.instId as string | undefined);
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
        name: 'okx_get_order_history',
        description: '查询近 7 天历史订单。instType 必填',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型: SPOT / SWAP / FUTURES / OPTION' },
            instId: { type: 'string', description: '可选，特定产品' },
            limit: {
              type: 'number',
              description: `返回条数，默认 ${pageLimit.defaultLimit}，最多 ${pageLimit.maxLimit}`,
            },
          },
          required: ['instType'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getOrderHistory(
          args.instType as string,
          args.instId as string | undefined,
          pickLimit(args, pageLimit),
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
        name: 'okx_get_fills',
        description: '查询近 3 天成交明细',
        parameters: {
          type: 'object',
          properties: {
            instType: { type: 'string', description: '产品类型' },
            instId: { type: 'string', description: '产品 ID' },
            limit: {
              type: 'number',
              description: `返回条数，默认 ${pageLimit.defaultLimit}，最多 ${pageLimit.maxLimit}`,
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getFills(
          args.instType as string | undefined,
          args.instId as string | undefined,
          pickLimit(args, pageLimit),
        );
        return JSON.stringify(truncate(r.data));
      } catch (e) {
        return errJson(e);
      }
    },
  });
}
