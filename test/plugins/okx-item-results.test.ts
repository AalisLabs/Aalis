import { afterEach, describe, expect, it, vi } from 'vitest';
import { OkxClient } from '../../packages/plugin-okx-trading/src/client.js';

// ════════════════════════════════════════════════════════════
// 下单、撤单、改单的回执在 data 里逐项带结果（sCode 为 0 即这一项成功，否则 sMsg 是原因）。批量操作部分成功时 OKX 回业务码 2：
// 照常交回逐项的结果，不报整体失败，否则模型照着整批重下，已经下成的那几单又下一遍。别的业务码报失败时带上逐项的结果（单笔下单
// 失败回 1，原因只在 data 里）。fetch 被截下，按给定的响应体回 HTTP 200。
// ════════════════════════════════════════════════════════════

afterEach(() => {
  vi.unstubAllGlobals();
});

function clientAnswering(body: unknown): OkxClient {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body))),
  );
  return new OkxClient({
    credentials: { apiKey: 'k', secretKey: 's', passphrase: 'p' },
    baseUrl: 'https://zz.invalid',
    demo: true,
    timeoutMs: 1000,
  });
}

const ORDER = { instId: 'BTC-USDT', tdMode: 'cash', side: 'buy', ordType: 'market', sz: '1' } as const;

describe('OKX 回执里逐项的结果', () => {
  it('批量下单部分成功（业务码 2）：交回逐单的结果，不报整体失败', async () => {
    const data = [
      { ordId: '1', clOrdId: '', tag: '', sCode: '0', sMsg: 'Order placed' },
      { ordId: '', clOrdId: '', tag: '', sCode: '51008', sMsg: 'Order failed. Insufficient USDT balance' },
    ];
    const client = clientAnswering({ code: '2', msg: 'Bulk operation partially succeeded', data });
    expect((await client.batchPlaceOrders([ORDER, ORDER])).data).toEqual(data);
  });

  it('全部失败（业务码 1，单笔下单失败也是它）：报错带上各项的原因', async () => {
    const data = [
      { ordId: '1', sCode: '51400', sMsg: 'Cancellation failed as the order has been filled' },
      { ordId: '2', sCode: '51400', sMsg: 'Cancellation failed as the order has been canceled' },
    ];
    const client = clientAnswering({ code: '1', msg: 'All operations failed', data });
    await expect(client.batchCancelOrders([{ instId: 'BTC-USDT', ordId: '1' }])).rejects.toThrow(
      'OKX API 错误 [1]: All operations failed（[51400] Cancellation failed as the order has been filled；[51400] Cancellation failed as the order has been canceled）',
    );
  });

  it.each([
    ['没有 data', undefined],
    ['各项没有 sCode', [{ ordId: '1' }]],
  ])('没有逐项结果的业务错误（%s）：照旧只报业务码与原话', async (_label, data) => {
    const client = clientAnswering({ code: '51000', msg: 'Parameter sz error', data });
    await expect(client.placeOrder(ORDER)).rejects.toThrow(/^OKX API 错误 \[51000\]: Parameter sz error$/);
  });
});
