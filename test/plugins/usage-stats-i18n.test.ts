import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { type App, config, definePlugin, events, type Logger, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import usageStats from '../../packages/plugin-usage-stats/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { defineTexts, TextError } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 用量统计页按全局层的语言：服务商的显示名是文字对象时，服务商一列与余额的标签按读者的语言写出，查余额失败的原因也是；
// 页面自己的说明、空表文字、列名与费用一列的币种进字典。账本读不出来时插件页的失败原因同样按全局层的语言。真的
// plugin-usage-stats、webui-server 与 plugin-i18n。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-usage-stats-i18n-token-placeholder';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const t = defineTexts({
  ns: '@zz/usage-stats-i18n',
  language: 'zh-CN',
  source: { provider: '甲服务商', down: '余额接口不通' } as const,
  locales: { en: { provider: 'Provider A', down: 'The balance API is down' } },
});

/** 服务商：显示名是文字对象，可复用；配置的 instance 是这个实例的 id（作 providerId），broken 时余额查不到 */
const providerPlugin = definePlugin({
  name: '@zz/usage-provider',
  displayName: t('provider'),
  reusable: true,
  provides: [llm],
  uses: { provide, config },
  apply({ provide, config }) {
    const { instance, broken } = config.use as { instance: string; broken?: boolean };
    const model: LLMModel = {
      id: 'm',
      providerId: instance,
      contextLength: 1000,
      capabilities: ['chat'],
      chat: async () => ({ content: '' }),
      balance: async () => {
        if (broken) throw new TextError(t('down'));
        return [{ currency: 'CNY', amount: 1 }];
      },
    };
    provide.use(llm, model, { entryId: `${instance}/m` });
  },
});

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 数据目录 home、全局语言 language：起 plugin-i18n、before 起的插件、usage-stats 与 webui-server；回 app 与取 REST 的 request */
async function serve(home: string, language: string, before: (app: App) => Promise<unknown> = async () => {}) {
  const port = await freePort();
  const { app } = hostedApp(i18nSection([language]), { logger: silent });
  apps.push(app);
  provideHostPaths(app, home);
  await app.plugin(i18nPlugin);
  await before(app);
  await app.plugin(usageStats, { prices: { m: '1, 0.5, 2' }, currency: 'USD' });
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  const request = async (path: string) =>
    (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie: `aalis_webui_token=${TOKEN}` } })).json();
  return { app, request };
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aalis-usage-i18n-'));
  homes.push(home);
  return home;
}

describe('用量统计页按全局层的语言', () => {
  it('en：服务商一列、余额标签与查不到的原因、说明、空表文字与列名', async () => {
    const { app, request } = await serve(tempHome(), 'en', async host => {
      await host.plugin(providerPlugin, { instance: providerPlugin.name });
      await host.plugin(
        providerPlugin,
        { instance: `${providerPlugin.name}:work`, broken: true },
        `${providerPlugin.name}:work`,
      );
    });
    const at = `/api/pages/${encodeURIComponent(usageStats.name)}/usage-stats`;

    const { pages } = await request('/api/pages');
    const page = pages.find((p: { key: string }) => p.key === 'usage-stats');
    const [days] = page.content.tabs[0].content;
    expect([days.description, days.empty, days.columns.map((c: { label: string }) => c.label)]).toEqual([
      'Costs are estimated from the prices in the config; models without a price are not counted',
      'No model calls recorded yet',
      ['Date', 'Input', 'Cache hits', 'Output', 'Cost (USD)'],
    ]);

    await app.bind({ events }).events.use.emit('llm:usage', {
      provider: '@zz/usage-provider:work',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
    });
    const models = (await request(`${at}/data/models`)).data;
    expect(models.map((row: { provider: string }) => row.provider)).toEqual(['Provider A (work)']);
    expect((await request(`${at}/data/balance`)).data).toEqual([
      { label: 'Provider A (CNY)', value: 1 },
      {
        label: 'Provider A (work)',
        value: { text: 'Unavailable: The balance API is down', state: 'error' },
        kind: 'status',
      },
    ]);
  });

  it.each([
    [
      'en',
      (file: string) =>
        `The usage ledger ${file} cannot be read: check its read and write permissions; to start from an empty ledger, move it away and reload this plugin ← EISDIR: illegal operation on a directory, read`,
    ],
    [
      'zh-CN',
      (file: string) =>
        `用量账本 ${file} 读不出来：检查它的读写权限；要从空账本开始就把它移走后重载本插件 ← EISDIR: illegal operation on a directory, read`,
    ],
  ])('%s：账本读不出来（换成同名目录），插件页的失败原因写明修法，底层原因跟在后面', async (language, expected) => {
    const home = tempHome();
    const ledger = join(home, 'state', 'usage', 'llm-calls.jsonl');
    mkdirSync(ledger, { recursive: true });
    const { request } = await serve(home, language);
    const { plugins } = await request('/api/plugins');
    const entry = plugins.find((plugin: { instanceId: string }) => plugin.instanceId === usageStats.name);
    expect([entry.state, entry.error]).toEqual(['error', expected(ledger)]);
  });
});
