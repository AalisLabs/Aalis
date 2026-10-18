import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { llm, metered } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import {
  type App,
  config,
  definePlugin,
  defineService,
  events,
  type PluginDefinition,
  provide,
} from '../../packages/core/src/index.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';
import { MockLLMService } from '../fixtures/mock-llm.js';
import {
  aria,
  attentionRows,
  onViewport,
  openWebui,
  text,
  useWebuiE2E,
  VIEWPORTS,
  webuiStack,
} from '../fixtures/webui-e2e.js';
import { deferred } from '../helpers/deferred.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 上手与故障的端到端：没有能对话的模型时首页的「开始使用」（待配置的模型插件与市场里可装的提供者，填好 key 后消失、能对话）；
// 「需要处理」里缺服务沿依赖链追到根（失败、没有提供者、成环），只在等别的插件启动的不计数；根已停用时在详情的依赖块里
// 一键启用；记忆后端坏了时「会话服务未启用」写链、去根插件；市场按服务搜。测试插件与假模型、假检索源，不连真实服务。
// 桌面与手机两种宽度各走一遍
// ════════════════════════════════════════════════════════════

const e2e = useWebuiE2E();
const { cleanups } = e2e;

/** 要 apiKey 的测试模型：没填起不来（待配置），填了就提供一个能对话的假模型 */
const MODEL = 'zz-onboard-model';
const MODEL_SCHEMA = { apiKey: { type: 'string', label: 'API Key', required: true, secret: true } } as const;
const REPLY = '你好，我在。';
const keyedModel = definePlugin({
  name: MODEL,
  displayName: '测试模型',
  provides: [llm],
  configSchema: MODEL_SCHEMA,
  uses: { config, provide, events },
  apply({ config: value, provide, events }) {
    parseConfig(MODEL_SCHEMA, value.use);
    const service = new MockLLMService({ responses: [{ content: REPLY }] });
    provide.use(llm, metered(service, events.use), { entryId: `${MODEL}/${service.id}` });
  },
});

/** 一个只提供服务、什么都不做的测试插件；requires 是它 required 的服务 */
function probe(name: string, displayName: string, provides: string[], requires: string[] = []) {
  return definePlugin({
    name,
    displayName,
    provides: provides.map(service => defineService<object>(service)),
    uses: { provide, ...Object.fromEntries(requires.map(service => [service, defineService<object>(service)])) },
    apply({ provide }) {
      for (const service of provides) provide.use(defineService<object>(service), {});
    },
  });
}

/** 激活就失败的测试插件 */
function broken(name: string, displayName: string, provides: string[], message: string) {
  return definePlugin({
    name,
    displayName,
    provides: provides.map(service => defineService<object>(service)),
    apply() {
      throw new Error(message);
    },
  });
}

/** 假检索源：检索按关键词回包名与说明，`/{包}/latest` 回带 aalis.service.provides 的清单 */
const PACKAGES = [
  { name: '@aalis/plugin-zz-onboard-chat', description: '另一个对话模型', provides: ['llm'] },
  { name: '@aalis/plugin-zz-onboard-embed', description: '文本向量', provides: ['embedding'] },
];
async function fakeRegistry(): Promise<string> {
  const port = await freePort();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/-/v1/search') {
      const plugins = url.searchParams.get('text')?.startsWith('keywords:aalis-plugin') ?? false;
      res.end(
        JSON.stringify({
          objects: plugins
            ? PACKAGES.map(({ name, description }) => ({
                package: { name, version: '1.0.0', description, keywords: ['aalis', 'aalis-plugin'] },
              }))
            : [],
        }),
      );
      return;
    }
    const found = PACKAGES.find(pkg => url.pathname === `/${pkg.name}/latest`);
    if (!found) {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    res.end(JSON.stringify({ name: found.name, version: '1.0.0', aalis: { service: { provides: found.provides } } }));
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

/**
 * 起运行时：没有模型的 minimal 档，市场的检索源是假的（首页的「开始使用」会去取市场）；extra 是装上后不一定起得来的
 * 测试插件，在 start 之前登记
 */
async function start(extra: PluginDefinition[], options: { slowThresholdMs?: number } = {}) {
  const { app, port } = await webuiStack({
    clientDir: e2e.clientDir,
    extra: [],
    cleanups,
    slowThresholdMs: options.slowThresholdMs,
    webui: { marketplaceRegistry: await fakeRegistry() },
  });
  for (const definition of extra) await app.plugin(definition, {});
  await app.start();
  await waitListening(port);
  return { app, origin: `http://127.0.0.1:${port}` };
}

describe.each(Object.entries(VIEWPORTS))('%s', (width, viewport) => {
  const phone = width === 'phone';
  const { newSession, send } = onViewport(phone);
  /** 首页上方的一块：桌面在主区，手机在第一层 */
  const home = (name: string) => `${phone ? 'nav[aria-label="会话"]' : 'main'} ${aria(name, 'region')}`;

  it('开始使用：列出待配置的模型插件与市场里可装的提供者；在另一个标签页填上 key 后首页的它随之消失，发消息有回复；市场按服务搜得到提供者', async () => {
    const stack = await start([keyedModel]);
    const { page, problems } = await openWebui(e2e.browser, stack.origin, viewport, cleanups);
    const card = home('开始使用');
    await page.waitForSelector(`${card} ${text('@aalis/plugin-zz-onboard-chat')}`);
    expect(await attentionRows(page, card)).toEqual([
      ['测试模型', '待配置：apiKey', '去配置'],
      ['@aalis/plugin-zz-onboard-chat', '另一个对话模型', '安装'],
    ]);

    expect(await page.$eval(`${card} ${aria('去配置', 'link')}`, link => link.getAttribute('href'))).toBe(
      `/plugins/${MODEL}#config`,
    );

    // 首页开着，在另一个标签页里填 key：插件列表一变，首页重取模型列表，「开始使用」随之消失
    const settings = await openWebui(e2e.browser, stack.origin, viewport, cleanups, `/plugins/${MODEL}`);
    await settings.page.locator('main ::-p-aria(API Key)').fill('sk-placeholder-0000');
    await settings.page.locator(`main ${aria('保存并重载', 'button')}`).click();
    await settings.page.waitForSelector(`.plugin-summary ${text('运行中')}`);
    expect(stack.app.plugins.getPlugin(MODEL)?.state).toBe('active');
    await page.waitForSelector(card, { hidden: true });

    await newSession(page);
    await send(page, '在吗');
    await page.waitForSelector(text(REPLY));

    await page.goto(`${stack.origin}/market`);
    await page.locator(`main ${aria('搜索', 'searchbox')}`).fill('embedding');
    await page.waitForSelector(`main ${text('提供：embedding')}`);
    const listed = await page.$$eval('main .market-entry-title > :first-child', titles =>
      titles.map(t => t.textContent),
    );
    expect(listed).toEqual(['@aalis/plugin-zz-onboard-embed']);
    expect(problems).toEqual([]);
    expect(settings.problems).toEqual([]);
  }, 90_000);

  it('需要处理：缺的服务沿链追到根，每个没起来的插件计 1；没有提供者、成环各有写法；只在等别的插件启动的不计数、启动完转为运行', async () => {
    const gate = deferred();
    cleanups.push(async () => gate.resolve());
    const slow = definePlugin({
      name: 'zz-onboard-slow',
      displayName: '慢启动',
      provides: [defineService<object>('zz-onboard-slow-svc')],
      uses: { provide },
      async apply({ provide }) {
        provide.use(defineService<object>('zz-onboard-slow-svc'), {});
        await gate.promise;
      },
    });
    const stack = await start(
      [
        broken('zz-onboard-root', '链根', ['zz-onboard-c'], '打不开数据库'),
        probe('zz-onboard-middle', '链中', ['zz-onboard-b'], ['zz-onboard-c']),
        probe('zz-onboard-top', '链顶', [], ['zz-onboard-b']),
        probe('zz-onboard-lonely', '孤儿', [], ['zz-onboard-nowhere']),
        probe('zz-onboard-x', '环甲', ['zz-onboard-sx'], ['zz-onboard-sy']),
        probe('zz-onboard-y', '环乙', ['zz-onboard-sy'], ['zz-onboard-sx']),
        slow,
        probe('zz-onboard-patient', '耐心', [], ['zz-onboard-slow-svc']),
      ],
      { slowThresholdMs: 50 },
    );
    const { page, problems } = await openWebui(e2e.browser, stack.origin, viewport, cleanups, '/health');
    const block = `main ${aria('需要处理', 'region')}`;
    await page.waitForSelector(`${block} ${text('链顶')}`);
    expect(await attentionRows(page, block)).toEqual([
      ['链根', '失败：打不开数据库', '去处理'],
      ['链中', '缺服务：链根（失败：打不开数据库）', '去处理 链根'],
      ['链顶', '缺服务：链中 → 链根（失败：打不开数据库）', '去处理 链根'],
      ['孤儿', '缺服务：没有已装的插件提供 zz-onboard-nowhere，可以在插件市场按服务搜 zz-onboard-nowhere', '去处理'],
      ['环甲', '缺服务：环乙（互相等待成环：环甲、环乙）', '去处理'],
      ['环乙', '缺服务：环甲（互相等待成环：环乙、环甲）', '去处理'],
    ]);
    if (!phone) {
      const entry = '.shell-rail a[href="/health"]';
      expect(await page.$eval(`${entry} .badge`, badge => badge.textContent)).toBe('6');
    }

    await page.goto(`${stack.origin}/plugins`);
    const patient = `nav[aria-label="插件"] a[href="/plugins/zz-onboard-patient"]`;
    expect(await (await page.waitForSelector(patient))?.evaluate(link => link.textContent)).toBe('耐心等待启动');
    gate.resolve();
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '耐心', {}, patient);

    await page.locator(`nav[aria-label="插件"] a[href="/plugins/zz-onboard-top"]`).click();
    await page.locator(`main ${aria('去处理 链根', 'link')}`).click();
    await page.waitForFunction(() => location.pathname === '/plugins/zz-onboard-root');
    expect(problems).toEqual([]);
  }, 90_000);

  it('根已停用：详情的依赖块里一键启用根插件，链随之消失', async () => {
    const stack = await start([
      probe('zz-onboard-off', '停用的提供者', ['zz-onboard-d']),
      probe('zz-onboard-user', '用它的', [], ['zz-onboard-d']),
    ]);
    await stack.app.plugins.disable('zz-onboard-off');
    const { page, problems } = await openWebui(
      e2e.browser,
      stack.origin,
      viewport,
      cleanups,
      '/plugins/zz-onboard-user',
    );
    await page.waitForSelector(`main ${text('停用的提供者（已停用）')}`);
    await page.locator(`main ${aria('启用 停用的提供者', 'button')}`).click();
    await page.waitForSelector(`.plugin-summary ${text('运行中')}`);
    expect(await page.$(`main ${text('已停用')}`)).toBeNull();
    expect(problems).toEqual([]);
  }, 60_000);

  it('记忆后端坏了：「会话服务未启用」写提供会话协议的插件的链与根，按钮去根插件', async () => {
    const stack = await start([]);
    await replaceMemory(stack.app);
    const { page, problems } = await openWebui(e2e.browser, stack.origin, viewport, cleanups);
    const absent = phone ? 'nav[aria-label="会话"]' : 'main';
    await page.waitForSelector(`${absent} ${text('会话服务未启用')}`);
    const description = await page.$eval(`${absent} .empty-state-description`, node => node.textContent ?? '');
    expect(description).toContain('→ 坏的记忆（失败：打不开数据库）');
    await page.locator(`${absent} ${aria('去处理 坏的记忆', 'link')}`).click();
    await page.waitForFunction(() => location.pathname === '/plugins/zz-onboard-memory');
    expect(problems).toEqual([]);
  }, 60_000);
});

/** 换掉记忆后端：卸掉内存记忆，换上一个激活就失败的 */
async function replaceMemory(app: App) {
  await app.plugins.unload('@aalis/plugin-memory-inmemory');
  await app.plugin(broken('zz-onboard-memory', '坏的记忆', [memory.name], '打不开数据库'), {});
  await app.plugins.idle();
}
