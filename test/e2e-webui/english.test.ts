import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Frame, Page } from 'puppeteer';
import { describe, expect, it } from 'vitest';
import type { PluginDefinition } from '../../packages/core/src/index.js';
import { generate } from '../../packages/create-aalis-plugin/src/cli.js';
import { aria, openWebui, useWebuiE2E, VIEWPORTS, webuiStack } from '../fixtures/webui-e2e.js';
import { waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 英文界面的端到端：共用的最少插件组合，plugin-i18n 的配置（全局层）写 ['en']，在桌面宽度按英文的读屏名与文字找元素。
// 每个出口查一处：登录页（服务端输出）、外壳（前端自带的字典）、插件详情的配置标签（REST）、指令回复的卡片（会话协议）、
// 脚手架生成的插件前端（插件的字典经 frame.t）。期望取自各字典的 en。换语言、审批卡、页面动作的报错与宿主确认框由快测试守着
// ════════════════════════════════════════════════════════════

/** 登录页的说明（plugin-webui-server） */
const LOGIN_HINT =
  'The access token is in state/webui/access.txt under the data directory; the startup log line “Access credentials written” gives its full path. A fixed token is stored in secrets.yaml under the data directory.';
/** /help clear 回复卡片的标题（plugin-commands） */
const CLEAR_TITLE =
  '/clear — Clear the memory of this session; use --type to pick what to clear, such as messages, summaries, vectors and images';

/** 脚手架生成的插件：包名，页面键取包名 */
const SCAFFOLD = 'zz-e2e-english';

const e2e = useWebuiE2E();
const { cleanups } = e2e;

/** 启动运行时：共用的最少插件组合加 extra，全局层的语言是英文；回地址 */
async function start(extra: PluginDefinition[] = []): Promise<string> {
  const { app, port } = await webuiStack({
    clientDir: e2e.clientDir,
    extra,
    cleanups,
    doc: { plugins: { '@aalis/plugin-i18n': { language: ['en'] } } },
  });
  await app.start();
  await waitListening(port);
  return `http://127.0.0.1:${port}`;
}

/** 用脚手架在临时目录里生成一个页面用自带前端的插件（原文中文，带英文译文），加载它的定义 */
async function scaffolded(): Promise<PluginDefinition> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-e2e-english-')));
  cleanups.push(async () => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, SCAFFOLD);
  await generate(
    dir,
    {
      packageName: SCAFFOLD,
      displayName: '示例条目',
      sourceLanguage: 'zh-CN',
      features: { tool: false, command: false, webui: 'frame', sessionSetting: false },
    },
    // 只用生成的源码与网页，依赖的版本不进这条用例
    { '@aalis/core': '0.1.0', '@aalis/api-webui': '0.1.0', '@aalis/schema-i18n': '0.1.0' },
  );
  return ((await import(join(dir, 'src/index.ts'))) as { default: PluginDefinition }).default;
}

/** 插件前端的框架：等握手完成（宿主给 iframe 标上 data-ready），回它的框架句柄 */
async function frameIn(page: Page): Promise<Frame> {
  const frame = await (await page.waitForSelector('iframe[data-ready]'))?.contentFrame();
  if (!frame) throw new Error('框架不在');
  return frame;
}

describe('英文界面', () => {
  it('登录页的 lang 是 en、说明是英文；登录后图标栏、插件详情的配置标签（REST）与 /help clear 回复卡片的标题（会话协议）是英文', async () => {
    const origin = await start();
    // 没登录打开入口：服务端回登录页
    const context = await e2e.browser.createBrowserContext();
    cleanups.push(() => context.close());
    const login = await context.newPage();
    await login.goto(origin);
    expect(
      await login.evaluate(() => [document.documentElement.lang, document.querySelector('form p')?.textContent]),
    ).toEqual(['en', LOGIN_HINT]);

    const { page, problems } = await openWebui(e2e.browser, origin, VIEWPORTS.desktop, cleanups);
    await page.waitForSelector(`.shell-rail ${aria('Settings', 'link')}`);

    await page.goto(`${origin}/plugins/${encodeURIComponent('@aalis/plugin-webui-server')}`);
    await page.waitForSelector(`main ${aria('Listen address', 'textbox')}`);

    await page.goto(origin);
    await page.waitForSelector(aria('Send', 'button'));
    await (await page.waitForSelector(aria('Message', 'textbox')))?.type('/help clear');
    await page.keyboard.press('Enter');
    expect(
      await (await page.waitForSelector('.command-reply .markdown > p'))?.evaluate(element => element.textContent),
    ).toBe(CLEAR_TITLE);
    expect(problems).toEqual([]);
  }, 60_000);

  it('插件前端（脚手架生成，原文中文、带英文）：框架的 lang 是 en，按钮与列表空了的文字是英文', async () => {
    const origin = await start([await scaffolded()]);
    const ref = `${encodeURIComponent(SCAFFOLD)}/${encodeURIComponent(SCAFFOLD)}`;
    const { page, problems } = await openWebui(e2e.browser, origin, VIEWPORTS.desktop, cleanups, `/p/${ref}`);
    const frame = await frameIn(page);
    await frame.waitForFunction(() => document.querySelectorAll('li').length === 3);
    expect(
      await frame.evaluate(() => [document.documentElement.lang, document.querySelector('li button')?.textContent]),
    ).toEqual(['en', 'Remove']);

    // 经页面动作的接口删光条目（宿主确认框不在这里查），插件通知重取后框架写列表空了
    const statuses: number[] = [];
    for (const item of await frame.$$eval('li span', spans => spans.map(span => span.textContent))) {
      statuses.push(
        await page.evaluate(
          async (url, item) =>
            (
              await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: { item } }),
              })
            ).status,
          `/api/pages/${ref}/actions/remove`,
          item,
        ),
      );
    }
    expect(statuses).toEqual([200, 200, 200]);
    await frame.waitForFunction(() => document.querySelector('#status')?.textContent === 'The list is empty');
    expect(problems).toEqual([]);
  }, 60_000);
});
