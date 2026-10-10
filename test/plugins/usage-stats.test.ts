import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatResponse,
  type LLMBalance,
  type LLMModel,
  type LLMUsageEvent,
  llm,
  metered,
} from '../../packages/api-llm/src/index.js';
import { type InfoItem, type PageTab, type TableRow, webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, events, type Logger, provide } from '../../packages/core/src/index.js';
import usageStats from '../../packages/plugin-usage-stats/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 记账插件：订阅 llm:usage，每次调用记一行到家目录 state 下的账本，重启后读回；「用量统计」页按天、按周、按模型
// 列出输入、缓存命中、输出 token。配置里填了单价才有费用一列；服务商实现了余额查询才有「余额」一页
// ════════════════════════════════════════════════════════════

const PAGE = 'usage-stats';

const apps: App[] = [];
const hosts: PageHost[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const host of hosts.splice(0)) host.dispose();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aalis-usage-stats-'));
  homes.push(home);
  return home;
}

const ledgerOf = (home: string) => join(home, 'state', 'usage', 'llm-calls.jsonl');

/** 一个服务商：displayName 是它的显示名，balance 给了才实现余额查询 */
function providerPlugin(name: string, balance?: () => Promise<LLMBalance[]>) {
  const model: LLMModel = {
    id: `${name}-model`,
    providerId: name,
    contextLength: 1000,
    capabilities: ['chat'],
    chat: async () => ({ content: '' }),
    ...(balance ? { balance } : {}),
  };
  return definePlugin({
    name,
    displayName: `显示名 ${name}`,
    provides: [llm],
    uses: { provide },
    apply({ provide }) {
      provide.use(llm, model, { entryId: `${name}/${model.id}` });
    },
  });
}

async function start(home: string, config: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')),
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'warn', logger });
  apps.push(app);
  provideHostPaths(app, home);
  const pages = pageHost();
  hosts.push(pages);
  app.bind({ provide }).provide.use(webuiServer, pages.service);
  await app.plugin(usageStats, config);
  await app.plugins.idle();
  const host = app.bind({ events });
  return {
    app,
    pages,
    warnings,
    state: () => app.plugins.getPlugin(usageStats.name)?.state,
    error: () => app.plugins.getPlugin(usageStats.name)?.error,
    /** 发一次用量，等账本落盘 */
    async record(at: Date, usage: Partial<LLMUsageEvent>) {
      vi.setSystemTime(at);
      await host.events.use.emit('llm:usage', {
        provider: 'fake-llm',
        model: 'a',
        inputTokens: 0,
        outputTokens: 0,
        ...usage,
      });
    },
    tabs: () => {
      const content = pages.view(PAGE).content as {
        tabs: PageTab<{ id?: string; columns?: Array<{ key: string; primary?: boolean }> }>[];
      };
      return content.tabs;
    },
  };
}

/** 标了 primary 的列（窄时只显示它们） */
const primaryOf = (columns: Array<{ key: string; primary?: boolean }> | undefined) =>
  (columns ?? []).filter(column => column.primary).map(column => column.key);

const SEP_28 = new Date(2026, 8, 28, 9);
const OCT_4 = new Date(2026, 9, 4, 23);
const OCT_5 = new Date(2026, 9, 5, 1);

/** 两周、三天、两个模型的用量 */
async function seed(stack: Awaited<ReturnType<typeof start>>) {
  await stack.record(SEP_28, {
    model: 'a',
    sessionId: 's1',
    purpose: '对话',
    caller: '@aalis/plugin-agent',
    inputTokens: 1_000_000,
    cachedTokens: 400_000,
    outputTokens: 100_000,
  });
  await stack.record(OCT_4, { model: 'a', purpose: '摘要', inputTokens: 2_000_000, outputTokens: 200_000 });
  await stack.record(OCT_4, {
    provider: 'other-llm',
    model: 'b',
    purpose: '识图',
    inputTokens: 500_000,
    cachedTokens: 100_000,
    outputTokens: 50_000,
  });
  await stack.record(OCT_5, {
    provider: 'other-llm',
    model: 'b',
    purpose: '子任务',
    inputTokens: 300_000,
    cachedTokens: 0,
    outputTokens: 30_000,
  });
}

describe('plugin-usage-stats', () => {
  it('每次调用记一行到账本，带用途、会话与调用方；重启后读回，读不懂的行跳过并告警', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const home = tempHome();
    const first = await start(home);
    expect(first.state()).toBe('active');
    await seed(first);
    await first.app.stop();

    const lines = readFileSync(ledgerOf(home), 'utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(lines.map(line => [line.purpose, line.model])).toEqual([
      ['对话', 'a'],
      ['摘要', 'a'],
      ['识图', 'b'],
      ['子任务', 'b'],
    ]);
    expect(lines[0]).toEqual({
      at: SEP_28.getTime(),
      provider: 'fake-llm',
      model: 'a',
      caller: '@aalis/plugin-agent',
      sessionId: 's1',
      purpose: '对话',
      inputTokens: 1_000_000,
      cachedTokens: 400_000,
      outputTokens: 100_000,
    });

    writeFileSync(ledgerOf(home), `${readFileSync(ledgerOf(home), 'utf8')}不是 JSON\n{"at":1}\n`);
    const second = await start(home);
    expect(second.warnings).toEqual([expect.stringContaining('2 行')]);
    expect((await second.pages.data<TableRow[]>(PAGE, 'days')).map(row => row.day)).toEqual([
      '2026-10-05',
      '2026-10-04',
      '2026-09-28',
    ]);
  });

  it('账本读不出来（不是不存在）时插件起不来，不会照空账本往下记', async () => {
    const home = tempHome();
    mkdirSync(ledgerOf(home), { recursive: true });
    const stack = await start(home);
    expect(stack.state()).toBe('error');
    // 写明怎么修，原因（EISDIR）跟在后面
    expect(stack.error()).toMatch(
      /^用量账本 .+ 读不出来：检查它的读写权限；要从空账本开始就把它移走后重载本插件 ← .*EISDIR/,
    );
  });

  it('按天、按周、按模型列出输入、缓存命中与输出；没报缓存命中的不算 0，整格没有就空着；没填单价时没有费用', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const home = tempHome();
    const stack = await start(home);
    await seed(stack);
    expect(stack.tabs().map(tab => tab.title)).toEqual(['按天', '按周', '按模型']);
    expect(stack.tabs().flatMap(tab => tab.content.flatMap(component => component.columns ?? []))).not.toContainEqual(
      expect.objectContaining({ key: 'cost' }),
    );
    // 窄时留首列、输入与输出
    expect(primaryOf(stack.tabs()[0]?.content[0]?.columns)).toEqual(['day', 'input', 'output']);

    expect(await stack.pages.data(PAGE, 'days')).toEqual([
      { day: '2026-10-05', input: 300_000, cached: 0, output: 30_000 },
      { day: '2026-10-04', input: 2_500_000, cached: 100_000, output: 250_000 },
      { day: '2026-09-28', input: 1_000_000, cached: 400_000, output: 100_000 },
    ]);
    expect(await stack.pages.data(PAGE, 'weeks')).toEqual([
      { week: '2026-10-05 – 10-11', input: 300_000, cached: 0, output: 30_000 },
      { week: '2026-09-28 – 10-04', input: 3_500_000, cached: 500_000, output: 350_000 },
    ]);
    expect(await stack.pages.data(PAGE, 'models')).toEqual([
      { key: '["fake-llm","a"]', model: 'a', provider: 'fake-llm', input: 3_000_000, cached: 400_000, output: 300_000 },
      { key: '["other-llm","b"]', model: 'b', provider: 'other-llm', input: 800_000, cached: 100_000, output: 80_000 },
    ]);

    await stack.record(OCT_5, { model: 'c', inputTokens: 10, outputTokens: 1 });
    const models = await stack.pages.data<TableRow[]>(PAGE, 'models');
    expect(models.find(row => row.model === 'c')).toEqual(expect.objectContaining({ cached: null }));
    // 记账只作废三张表，「余额」不跟着每次调用重查
    expect(new Set(stack.pages.invalidations.map(call => call.componentId))).toEqual(
      new Set(['days', 'weeks', 'models']),
    );
  });

  it('服务商回的用量缺字段或带 null 时页面不出 NaN，重启前后合计一致', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(OCT_4);
    const home = tempHome();
    const first = await start(home);
    const replies: unknown[] = [
      { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedPromptTokens: null },
      { completionTokens: 5, totalTokens: 5 },
      { promptTokens: 50, completionTokens: 5, totalTokens: 55, cachedPromptTokens: 80 },
    ];
    const loose = definePlugin({
      name: 'loose-llm',
      provides: [llm],
      uses: { provide, events },
      apply({ provide, events }) {
        const model: LLMModel = {
          id: 'loose',
          providerId: 'loose-llm',
          contextLength: 1000,
          capabilities: ['chat'],
          chat: async () => ({ content: '', usage: replies.shift() as ChatResponse['usage'] }),
        };
        provide.use(llm, metered(model, events.use), { entryId: 'loose-llm/loose' });
      },
    });
    await first.app.plugin(loose, {});
    await first.app.plugins.idle();
    const model = first.app.bind({ llm }).llm.use;
    for (let i = 0; i < 3; i++) await model.chat({ messages: [] });
    const expected = [{ day: '2026-10-04', input: 150, cached: 50, output: 15 }];
    await vi.waitFor(async () => expect(await first.pages.data(PAGE, 'days')).toEqual(expected));
    await first.app.stop();

    const second = await start(home);
    expect(second.warnings).toEqual([]);
    expect(await second.pages.data(PAGE, 'days')).toEqual(expected);
  });

  it('填了单价才有费用：按每百万 token 的输入、缓存命中、输出价估算，没填单价的模型那一格空着；单价写错时插件起不来', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const stack = await start(tempHome(), { prices: { a: '2, 0.5, 8' }, currency: 'USD' });
    await seed(stack);
    const columns = stack.tabs()[0]?.content[0]?.columns;
    expect(columns).toContainEqual(expect.objectContaining({ key: 'cost', label: '费用（USD）' }));
    // 有费用时窄时留首列、输入与费用
    expect(primaryOf(columns)).toEqual(['day', 'input', 'cost']);
    // a：1M 输入里 0.4M 命中、0.1M 输出 → 0.6×2 + 0.4×0.5 + 0.1×8 = 2.2；10-04 的 2M 输入没报命中 → 2×2 + 0.2×8 = 5.6
    const days = await stack.pages.data<TableRow[]>(PAGE, 'days');
    expect(days.map(row => row.cost)).toEqual([null, 5.6, 2.2]);
    const models = await stack.pages.data<TableRow[]>(PAGE, 'models');
    expect(models.map(row => row.cost)).toEqual([7.8, null]);

    const broken = await start(tempHome(), { prices: { a: '2,8' } });
    expect(broken.state()).toBe('error');
    expect(broken.error()).toContain('单价「a」');
  });

  it('服务商实现了余额查询才有「余额」一页，查不到时写明原因；服务商停了这一页随之消失', async () => {
    const stack = await start(tempHome());
    expect(stack.tabs().map(tab => tab.key)).not.toContain('balance');

    await stack.app.plugin(providerPlugin('plain-llm'), {});
    await stack.app.plugins.idle();
    expect(stack.tabs().map(tab => tab.key)).not.toContain('balance');

    const rich = providerPlugin('rich-llm', async () => [
      { currency: 'CNY', amount: 12.5 },
      { currency: 'USD', amount: 3 },
    ]);
    const broken = providerPlugin('broken-llm', async () => {
      throw new Error('认证失败');
    });
    await stack.app.plugin(rich, {});
    await stack.app.plugin(broken, {});
    await stack.app.plugins.idle();
    expect(stack.tabs().map(tab => tab.title)).toEqual(['按天', '按周', '按模型', '余额']);
    expect(await stack.pages.data<InfoItem[]>(PAGE, 'balance')).toEqual([
      { label: '显示名 rich-llm（CNY）', value: 12.5 },
      { label: '显示名 rich-llm（USD）', value: 3 },
      { label: '显示名 broken-llm', value: { text: '查不到：认证失败', state: 'error' }, kind: 'status' },
    ]);

    await stack.app.plugins.unload(rich.name);
    await stack.app.plugins.unload(broken.name);
    await stack.app.plugins.idle();
    expect(stack.tabs().map(tab => tab.key)).not.toContain('balance');
  });

  it('页面过登记门槛', async () => {
    const stack = await start(tempHome());
    expect(stack.pages.view(PAGE)).toEqual(expect.objectContaining({ title: '用量统计', placement: 'plugin' }));
    expect(stack.pages.logs).toEqual([]);
  });
});
