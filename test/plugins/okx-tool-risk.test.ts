import type { Context } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { apply } from '../../packages/plugin-okx-trading/src/index.js';

// ════════════════════════════════════════════════════════════
// OKX 工具权限档定格。
//
// 三层：动账户（下单/撤单/划转/杠杆…）→ visibility restricted（等级门禁）；
// 账户/订单查询（余额/持仓/账单/挂单/成交）读的是 owner 真实资金全貌 →
// risk sensitive（挡等级 0 的陌生群成员经 LLM 读账户，owner/授权用户不受影响）；
// 行情/量化数据（candles/ticker/rubik）是公开数据 → 维持 public。
// 大评审遗留 medium：此前查询类全 public——本文件钉死修后的三层结构。
// ════════════════════════════════════════════════════════════

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
  apply(ctx, { apiKey: 'k', secretKey: 's', passphrase: 'p', demo: true, enableTrading: true, enableTransfer: true });
  return captured;
}

describe('OKX 工具权限三层结构', () => {
  const tools = runApply();
  const byName = new Map(tools.map(t => [t.name, t]));

  it('账户查询与订单查询：risk=sensitive（真实资金视图不给等级 0）', () => {
    const accountRead = ['okx_get_balance', 'okx_get_bills', 'okx_get_asset_balances', 'okx_get_leverage_info'];
    const orderRead = ['okx_get_pending_orders', 'okx_get_order_history', 'okx_get_fills'];
    for (const name of [...accountRead, ...orderRead]) {
      expect(byName.get(name)?.risk, name).toBe('sensitive');
    }
  });

  it('行情类：无 risk 标注（公开数据维持 public）', () => {
    for (const name of ['okx_get_candles', 'okx_get_funding_rate']) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)?.risk, name).toBeUndefined();
    }
  });

  it('动账户类：visibility=restricted（原有等级门禁不回归）', () => {
    for (const name of ['okx_place_order', 'okx_cancel_order', 'okx_transfer', 'okx_close_position']) {
      expect(byName.get(name)?.visibility, name).toBe('restricted');
    }
  });
});
