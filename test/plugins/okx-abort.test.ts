import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import okxTrading from '../../packages/plugin-okx-trading/src/index.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// OKX 的请求接这次工具调用的中止信号，与 timeoutMs 谁先到按谁停。查询（GET）中止或超时了就是没查到；改变状态的请求（POST：
// 下单、撤单、改单、平仓、杠杆、保证金、策略委托、划转）发出之后被中止或超时，OKX 可能已经执行，回「结果未知」并提示先查询，
// 不按下单失败报；发出之前已中止的没有发出，照常回中止原因。fetch 被截下：一直不回，只在中止或超时时拒绝。
// ════════════════════════════════════════════════════════════

type ToolSpec = Omit<RegisteredTool, 'pluginName'>;

const apps: App[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.stop();
});

/** 起插件（模拟盘、开交易），收下登记的工具；fetch 一直不回，sent 记下每次请求收到的信号。config 覆盖插件配置 */
async function boot(config: Record<string, unknown> = {}) {
  const sent: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<never>((_, reject) => {
          const signal = init.signal as AbortSignal;
          sent.push(signal);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    ),
  );
  const registered = new Map<string, ToolSpec>();
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  app.bind({ provide }).provide.use(tools, {
    register(tool: ToolSpec) {
      registered.set(tool.definition.function.name, tool);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugins.register(okxTrading, { apiKey: 'k', secretKey: 's', passphrase: 'p', demo: true, ...config });
  await app.plugins.idle();
  const call = (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
    const tool = registered.get(name);
    if (!tool) throw new Error(`${name} 未注册`);
    return tool.handler(args, { ...toolContext({ sessionId: 's' }), signal });
  };
  return { sent, call };
}

const ORDER = { instId: 'BTC-USDT', tdMode: 'cash', side: 'buy', ordType: 'market', sz: '1' };
const errorOf = (out: unknown) => JSON.parse(String(out)).error as string;

describe('OKX 请求随这次调用中止', () => {
  it('查询途中中止：交给 fetch 的信号随之断开，回中止原因', async () => {
    const { sent, call } = await boot();
    const ac = new AbortController();
    const pending = call('okx_get_ticker', { instId: 'BTC-USDT' }, ac.signal);
    await expect.poll(() => sent.length).toBe(1);
    ac.abort();
    expect(sent[0].aborted).toBe(true);
    const error = errorOf(await pending);
    expect(error).toContain('aborted');
    expect(error).not.toContain('是否已执行未知');
  });

  it('下单发出之后中止：交给 fetch 的信号随之断开，回已中止、结果未知，提示先查询', async () => {
    const { sent, call } = await boot();
    const ac = new AbortController();
    const pending = call('okx_place_order', ORDER, ac.signal);
    await expect.poll(() => sent.length).toBe(1);
    ac.abort();
    expect(sent[0].aborted).toBe(true);
    expect(errorOf(await pending)).toBe(
      '请求已发出后中止，OKX 是否已执行未知：先查询订单、持仓或资金状态，确认之后再决定是否重试',
    );
  });

  it('下单之前已中止：不发请求，回中止原因，不说结果未知', async () => {
    const { sent, call } = await boot();
    const ac = new AbortController();
    ac.abort();
    const error = errorOf(await call('okx_place_order', ORDER, ac.signal));
    expect(sent).toEqual([]);
    expect(error).toContain('aborted');
    expect(error).not.toContain('是否已执行未知');
  });

  it('下单发出之后超时：回结果未知那句，与中止同一句', async () => {
    const { call } = await boot({ timeoutMs: 50 });
    expect(errorOf(await call('okx_place_order', ORDER, new AbortController().signal))).toBe(
      '请求已发出后中止，OKX 是否已执行未知：先查询订单、持仓或资金状态，确认之后再决定是否重试',
    );
  });

  it('查询超时：照旧回超时，不说结果未知', async () => {
    const { call } = await boot({ timeoutMs: 50 });
    const error = errorOf(await call('okx_get_ticker', { instId: 'BTC-USDT' }, new AbortController().signal));
    expect(error).toContain('timeout');
    expect(error).not.toContain('是否已执行未知');
  });
});
