import type { OkxClient } from '../client.js';
import { errJson, type RegFn, truncate } from './_shared.js';

export function registerTransferTools(reg: RegFn, client: OkxClient): void {
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
    handler: async args => {
      try {
        const r = await client.transfer(args.ccy as string, args.amt as string, args.from as string, args.to as string);
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
        name: 'okx_get_transfer_state',
        description: '查询资金划转状态',
        parameters: {
          type: 'object',
          properties: { transId: { type: 'string', description: '划转 ID' } },
          required: ['transId'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getTransferState(args.transId as string);
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
    handler: async args => {
      try {
        const r = await client.getAssetBills(
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
        name: 'okx_get_deposit_address',
        description: '获取某个币种的充值地址',
        parameters: {
          type: 'object',
          properties: { ccy: { type: 'string', description: '币种，如 BTC / ETH / USDT' } },
          required: ['ccy'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      try {
        const r = await client.getDepositAddress(args.ccy as string);
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
    handler: async args => {
      try {
        const r = await client.getDepositHistory(args.ccy as string | undefined, (args.limit as number) || 20);
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
    handler: async args => {
      try {
        const r = await client.getWithdrawalHistory(args.ccy as string | undefined, (args.limit as number) || 20);
        return JSON.stringify(truncate(r.data));
      } catch (e) {
        return errJson(e);
      }
    },
  });
}
