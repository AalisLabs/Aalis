import type { Context } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_READ_OKX_TOOLS, apply, MUTATING_OKX_TOOLS } from '../../packages/plugin-okx-trading/src/index.js';

// ════════════════════════════════════════════════════════════
// OKX 工具权限三分结构——全量快照 + 补集断言。
//
// 动账户 → visibility restricted（等级门禁 2）；账户读（余额/持仓/账单/挂单/
// 成交/充提记录/链上地址/算法单）→ risk sensitive（挡等级 0 读 owner 资金全貌）；
// 行情/量化 → public（公开数据）。
// 教训（对抗审计两轮）：第一版按文件包装漏掉 trade/algo/transfer 里 9 个查询
// 工具；第一版测试用手写白名单锚不住补集。本版断言**全部注册工具**都被三分
// 名单覆盖——新增工具不归类即红，逼着写它的人做一次有意识的档位决定。
// 另：MUTATING 与 ACCOUNT_READ 必须互斥——capabilityMinLevel 里 risk 遮蔽
// visibility，同标会把门槛从 2 反降到 1。
// ════════════════════════════════════════════════════════════

/** 公开数据类（market.ts + rubik.ts）：行情与量化指标，不含任何 owner 账户信息 */
const PUBLIC_MARKET_OKX_TOOLS = new Set([
  'okx_get_24h_volume',
  'okx_get_candles',
  'okx_get_funding_rate',
  'okx_get_funding_rate_history',
  'okx_get_history_candles',
  'okx_get_index_candles',
  'okx_get_index_tickers',
  'okx_get_instruments',
  'okx_get_mark_price',
  'okx_get_mark_price_candles',
  'okx_get_open_interest',
  'okx_get_orderbook',
  'okx_get_price_limit',
  'okx_get_ticker',
  'okx_get_tickers',
  'okx_get_trades',
  'okx_get_contract_oi_volume',
  'okx_get_long_short_ratio',
  'okx_get_taker_volume',
]);

interface Captured {
  name: string;
  risk?: string;
  visibility?: string;
}

function runApply(): Captured[] {
  const captured: Captured[] = [];
  const fakeTools = {
    register: (tool: { definition: { function: { name: string } }; risk?: string; visibility?: string }) => {
      captured.push({ name: tool.definition.function.name, risk: tool.risk, visibility: tool.visibility });
      return () => {};
    },
    registerGroup: () => {},
  };
  const ctx = {
    id: '@aalis/plugin-okx-trading',
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    getService: (name: string) => (name === 'tools' ? fakeTools : undefined),
    whenService: (name: string, cb: (svc: unknown) => void) => {
      if (name === 'tools') cb(fakeTools);
      return () => {};
    },
    onDispose: () => {},
  } as unknown as Context;
  // 全开关打开：让 trade/algo/transfer 的全部工具都注册进来接受断言
  apply(ctx, {
    apiKey: 'k',
    secretKey: 's',
    passphrase: 'p',
    demo: true,
    enableTrading: true,
    enableAlgo: true,
    enableTransfer: true,
  });
  return captured;
}

describe('OKX 工具权限三分结构（全量快照）', () => {
  const tools = runApply();

  it('MUTATING 与 ACCOUNT_READ 互斥（risk 遮蔽 visibility，同标即降门槛）', () => {
    const overlap = [...MUTATING_OKX_TOOLS].filter(n => ACCOUNT_READ_OKX_TOOLS.has(n));
    expect(overlap).toEqual([]);
  });

  it('补集断言：每个注册的工具都必须属于三分名单之一——新工具不归类即红', () => {
    const unclassified = tools
      .map(t => t.name)
      .filter(n => !MUTATING_OKX_TOOLS.has(n) && !ACCOUNT_READ_OKX_TOOLS.has(n) && !PUBLIC_MARKET_OKX_TOOLS.has(n));
    expect(unclassified, '未归类工具——请在三分名单中做一次有意识的档位决定').toEqual([]);
  });

  it('动账户类全部 restricted 且不带 risk（防降档），账户读全部 sensitive，公开类双无', () => {
    for (const t of tools) {
      if (MUTATING_OKX_TOOLS.has(t.name)) {
        expect(t.visibility, t.name).toBe('restricted');
        expect(t.risk, `${t.name} 不得带 risk（会把门槛从 2 降到 1）`).toBeUndefined();
      } else if (ACCOUNT_READ_OKX_TOOLS.has(t.name)) {
        expect(t.risk, t.name).toBe('sensitive');
      } else {
        expect(t.risk, t.name).toBeUndefined();
        expect(t.visibility, t.name).toBeUndefined();
      }
    }
  });

  it('审计点名的 9 个漏网工具已全部入列（含 2 个默认开启的）', () => {
    for (const name of [
      'okx_get_fills_archive',
      'okx_get_order_detail',
      'okx_get_asset_bills',
      'okx_get_deposit_address',
      'okx_get_deposit_history',
      'okx_get_withdrawal_history',
      'okx_get_transfer_state',
      'okx_get_pending_algo_orders',
      'okx_get_algo_order_history',
    ]) {
      expect(ACCOUNT_READ_OKX_TOOLS.has(name), name).toBe(true);
    }
  });
});
