import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import okxTrading from '../../packages/plugin-okx-trading/src/index.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// OKX 的请求接这次工具调用的中止信号，与 timeoutMs 谁先到按谁停。查询（GET）中止或超时了就是没查到；改变状态的请求（POST：
// 下单、撤单、改单、平仓、杠杆、保证金、策略委托、划转）发出之后被中止或超时，OKX 可能已经执行，回「结果未知」并提示先查询，
// 不按下单失败报；发出之前已中止的没有发出，照常回中止原因。改变状态的请求没拿到确切结果的（连接出错、读到一半断开、2xx 而
// 响应体不是 OKX 的回执、网关报 5xx、OKX 的 50004 接口超时）同样回结果未知，别的照常报失败。fetch 被截下：缺省一直不回，只在中止或超时时拒绝；给了 respond 的按它回。
// ════════════════════════════════════════════════════════════

type ToolSpec = Omit<RegisteredTool, 'pluginName'>;

const apps: App[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.stop();
});

/**
 * 启动插件（模拟盘、开交易），收下登记的工具；sent 记下每次请求收到的信号。config 覆盖插件配置。fetch 缺省一直不回，给了
 * respond 的按它回
 */
async function boot(config: Record<string, unknown> = {}, respond?: () => Promise<Response>) {
  const sent: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: unknown, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      sent.push(signal);
      if (respond) return respond();
      return new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }),
  );
  const registered = new Map<string, ToolSpec>();
  const app = new App({ logLevel: 'error' });
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

describe('改变状态的请求没拿到确切结果', () => {
  it('下单没拿到答复（连接被重置）：回结果未知，带上 cause 里的出错原因，提示先查询', async () => {
    const reset = () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    const { call } = await boot({}, reset);
    expect(errorOf(await call('okx_place_order', ORDER, new AbortController().signal))).toBe(
      '请求没拿到 OKX 的确切结果（fetch failed: ECONNRESET），是否已执行未知：先查询订单、持仓或资金状态，确认之后再决定是否重试',
    );
  });

  it.each([
    [
      '遇到连接被重置',
      () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })),
      'fetch failed',
    ],
    ['拿到 HTTP 200 的网页', async () => new Response('<html>zz</html>'), 'OKX HTTP 200: <html>zz</html>'],
  ])('查询%s：照常报失败', async (_label, respond, expected) => {
    const { call } = await boot({}, respond);
    const error = errorOf(await call('okx_get_ticker', { instId: 'BTC-USDT' }, new AbortController().signal));
    expect(error).toContain(expected);
    expect(error).not.toContain('是否已执行未知');
  });

  it('下单的响应体读到一半断开：回结果未知，带上出错原因', async () => {
    const body = new ReadableStream({ start: controller => controller.error(new TypeError('terminated')) });
    const { call } = await boot({}, async () => new Response(body));
    expect(errorOf(await call('okx_place_order', ORDER, new AbortController().signal))).toContain(
      '请求没拿到 OKX 的确切结果（terminated），是否已执行未知',
    );
  });

  // 按连接关闭定界的响应读到一半断开时 fetch 不报错，读到的是截断的 JSON；中转或代理也可能回 200 的网页或别的 JSON
  it.each([
    ['截断的 JSON', '{"code":"0","data":[{"ordId":"1'],
    ['网页', '<html>zz</html>'],
    ['业务码不是字符串的 JSON', '{"code":502,"msg":"Bad Gateway"}'],
    ['null', 'null'],
  ])('下单拿到 HTTP 200，响应体（%s）不是 OKX 的回执：回结果未知', async (_label, text) => {
    const { call } = await boot({}, async () => new Response(text));
    expect(errorOf(await call('okx_place_order', ORDER, new AbortController().signal))).toContain(
      '请求没拿到 OKX 的确切结果（HTTP 200, not an OKX reply），是否已执行未知',
    );
  });

  it('下单遇到 OKX 的普通业务错误（HTTP 200）：照常报失败', async () => {
    const body = JSON.stringify({ code: '51000', msg: 'Parameter sz error', data: [] });
    const { call } = await boot({}, async () => new Response(body));
    expect(errorOf(await call('okx_place_order', ORDER, new AbortController().signal))).toBe(
      'OKX API 错误 [51000]: Parameter sz error',
    );
  });

  it.each([
    ['okx_place_order', 502, '请求没拿到 OKX 的确切结果（HTTP 502），是否已执行未知'],
    ['okx_place_order', 401, 'OKX HTTP 401'],
    ['okx_get_ticker', 502, 'OKX HTTP 502'],
  ])('%s 遇到 HTTP %i：只有改变状态的请求遇到 5xx 回结果未知', async (name, status, expected) => {
    const { call } = await boot({}, async () => new Response('zz', { status }));
    const args = name === 'okx_get_ticker' ? { instId: 'BTC-USDT' } : ORDER;
    expect(errorOf(await call(name, args, new AbortController().signal))).toContain(expected);
  });

  it.each([
    ['okx_place_order', 400, '请求没拿到 OKX 的确切结果（OKX 50004），是否已执行未知'],
    ['okx_place_order', 200, '请求没拿到 OKX 的确切结果（OKX 50004），是否已执行未知'],
    ['okx_get_ticker', 200, 'OKX API 错误 [50004]'],
  ])('%s 遇到 OKX 的 50004（接口超时，HTTP %i）：只有改变状态的请求回结果未知', async (name, status, expected) => {
    const body = JSON.stringify({ code: '50004', msg: 'API endpoint request timeout', data: [] });
    const { call } = await boot({}, async () => new Response(body, { status }));
    const args = name === 'okx_get_ticker' ? { instId: 'BTC-USDT' } : ORDER;
    expect(errorOf(await call(name, args, new AbortController().signal))).toContain(expected);
  });
});
