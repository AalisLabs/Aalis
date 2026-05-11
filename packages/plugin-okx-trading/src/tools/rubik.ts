import type { OkxClient } from '../client.js';
import { errJson, type RegFn, truncate } from './_shared.js';

export function registerRubikTools(reg: RegFn, client: OkxClient): void {
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
    handler: async args => {
      try {
        const r = await client.getLongShortRatio(args.ccy as string, (args.period as string) || '1D');
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
    handler: async args => {
      try {
        const r = await client.getContractOpenInterestVolume(args.ccy as string, (args.period as string) || '1D');
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
    handler: async args => {
      try {
        const r = await client.getTakerVolume(
          args.ccy as string,
          args.instType as string,
          (args.period as string) || '1D',
        );
        return JSON.stringify(truncate(r.data, 30));
      } catch (e) {
        return errJson(e);
      }
    },
  });
}
