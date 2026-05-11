import type { OkxClient } from '../client.js';
import { errJson, type RegFn, truncate } from './_shared.js';

export function registerAccountTools(reg: RegFn, client: OkxClient): void {
  reg({
    definition: {
      type: 'function',
      function: {
        name: 'okx_get_balance',
        description: '查询交易账户余额。可指定币种，不指定则返回全部',
        parameters: {
          type: 'object',
          properties: { ccy: { type: 'string', description: '币种，如 USDT, BTC。留空查全部' } },
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getBalance(args.ccy as string | undefined);
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
    handler: async args => {
      try {
        const r = await client.getPositions(args.instType as string | undefined, args.instId as string | undefined);
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
        name: 'okx_get_account_config',
        description: '查询账户配置（账户模式、持仓模式、交易手续费等级等）',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    handler: async () => {
      try {
        const r = await client.getAccountConfig();
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
        name: 'okx_get_asset_balances',
        description: '查询资金账户余额（非交易账户），如充值到账但未划转的资产',
        parameters: {
          type: 'object',
          properties: { ccy: { type: 'string', description: '币种，留空查全部' } },
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getAssetBalances(args.ccy as string | undefined);
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
    handler: async args => {
      try {
        const r = await client.getLeverageInfo(args.instId as string, args.mgnMode as 'cross' | 'isolated');
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
    handler: async args => {
      try {
        const r = await client.getMaxSize(args.instId as string, args.tdMode as string, args.px as string | undefined);
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
    handler: async args => {
      try {
        const r = await client.getMaxAvailSize(args.instId as string, args.tdMode as string);
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
        name: 'okx_get_risk_state',
        description: '查询账户风险状态（保证金率、风险等级等），判断是否接近强平',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    handler: async () => {
      try {
        const r = await client.getRiskState();
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
    handler: async args => {
      try {
        const r = await client.getBills(
          args.instType as string | undefined,
          args.ccy as string | undefined,
          args.type as string | undefined,
          (args.limit as number) || 20,
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
    handler: async args => {
      try {
        const r = await client.getBillsArchive(
          args.instType as string | undefined,
          args.ccy as string | undefined,
          args.type as string | undefined,
          (args.limit as number) || 20,
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
    handler: async args => {
      try {
        const r = await client.getTradeFee(args.instType as string, args.instId as string | undefined);
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
    handler: async args => {
      try {
        const r = await client.getPositionsHistory(
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
    handler: async args => {
      try {
        const r = await client.getInterestAccrued(
          args.instId as string | undefined,
          args.ccy as string | undefined,
          (args.limit as number) || 20,
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
        name: 'okx_get_currencies',
        description: '获取 OKX 支持的全部币种列表及其充提配置',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    handler: async () => {
      try {
        const r = await client.getCurrencies();
        return JSON.stringify(truncate(r.data, 50));
      } catch (e) {
        return errJson(e);
      }
    },
  });
}
