import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import okxTrading from '../../packages/plugin-okx-trading/src/index.js';

// ════════════════════════════════════════════════════════════
// 分页查询条数统一走 defaultPageLimit / maxPageLimit：
// trade / algo / transfer 里的 5 个分页查询与 account / orders 同口径，
// 未传 limit 用默认条数，传入的 limit 被 cap 到最大条数。
// ════════════════════════════════════════════════════════════

const PAGED_TOOLS = [
  'okx_get_fills_archive',
  'okx_get_algo_order_history',
  'okx_get_asset_bills',
  'okx_get_deposit_history',
  'okx_get_withdrawal_history',
];

/** 各工具的必填参数 */
const REQUIRED_ARGS: Record<string, Record<string, unknown>> = {
  okx_get_fills_archive: { instType: 'SPOT' },
  okx_get_algo_order_history: { ordType: 'conditional' },
};

type ToolSpec = Omit<RegisteredTool, 'pluginName'>;

let registered: Map<string, ToolSpec>;

beforeAll(async () => {
  registered = new Map();
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide });
  host.provide(tools, {
    register(tool: ToolSpec) {
      registered.set(tool.definition.function.name, tool);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugins.register(okxTrading, {
    apiKey: 'k',
    secretKey: 's',
    passphrase: 'p',
    demo: true,
    enableTrading: true,
    enableAlgo: true,
    enableTransfer: true,
    defaultPageLimit: 7,
    maxPageLimit: 9,
  });
  await app.plugins.idle();
  await app.stop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 调用工具，返回它发给 OKX 的 limit 查询参数 */
async function sentLimit(name: string, args: Record<string, unknown>): Promise<string | null> {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ code: '0', msg: '', data: [] }), { status: 200 });
    }),
  );
  const tool = registered.get(name);
  if (!tool) throw new Error(`${name} 未注册`);
  await tool.handler({ ...REQUIRED_ARGS[name], ...args }, { sessionId: 's', enabledGroups: undefined });
  expect(urls, name).toHaveLength(1);
  return new URL(urls[0]).searchParams.get('limit');
}

describe('OKX 分页查询条数跟随配置', () => {
  it.each(PAGED_TOOLS)('%s：未传 limit 用 defaultPageLimit，超限的 limit 被 cap 到 maxPageLimit', async name => {
    expect(await sentLimit(name, {})).toBe('7');
    expect(await sentLimit(name, { limit: 500 })).toBe('9');
    expect(await sentLimit(name, { limit: 3 })).toBe('3');
  });

  it.each(PAGED_TOOLS)('%s：limit 参数说明写出默认值与上限', name => {
    const limit = (registered.get(name)?.definition.function.parameters as { properties: Record<string, unknown> })
      .properties.limit as { description: string };
    expect(limit.description).toBe('条数，默认 7，最多 9');
  });
});
