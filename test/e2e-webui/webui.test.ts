import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type AddressInfo, connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer, { type Browser, type HTTPResponse, type Page, type Viewport } from 'puppeteer';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { webuiClient } from '../../packages/api-webui/src/index.js';
import { type PluginDefinition, provide } from '../../packages/core/src/index.js';
import { MINIMAL_BASE } from '../../packages/create-aalis/src/cli.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 端到端：构建前端，起最少插件组合的运行时（create-aalis 的 minimal 档，加内存记忆、假模型与 webui-server，
// 不装计划、检查点、摘要），在真的 Chromium 里按桌面与手机两种宽度走主流程；按宽度变的排版（房间表的容器查询）
// 只有真的排版才验得了，也在这里核。浏览器经一个可以切断的中转连到 webui-server，断线重连靠它模拟。假模型按这一轮的
// 最后一条消息回话，流式回复逐块慢慢出；需要批准的是一个声明了命令展示的探针工具。页面里的请求只到这个中转，外站一律不连。
// ════════════════════════════════════════════════════════════

const ROOT = join(import.meta.dirname, '../..');
const CLIENT = join(ROOT, 'packages/plugin-webui-client');
const TOKEN = 'zz-e2e-webui-token-placeholder-0000';
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/** 流式回复每 4 个字一块，块与块之间隔这么久 */
const CHUNK_MS = 60;
const EXTERNAL_IMAGE = 'https://img.example.invalid/cat.png';
const DEPLOY = 'zz_deploy';
const COMMAND = 'deploy --prod';
const DEPLOYED = '部署完成';

/**
 * 假模型：不带工具定义的是会话标题之类的辅助调用，回一个固定标题；最后一条是工具结果时按批没批准收尾；
 * 用户说「部署」就叫探针工具；其余按 replies 里出现在用户消息中的那句回话
 */
function script(replies: Record<string, string>) {
  return (request: ChatModelRequest): ChatResponse => {
    if (!request.tools) return { content: '测试会话' };
    const last = request.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : '';
    if (last?.role === 'tool') return { content: text.includes(DEPLOYED) ? '部署好了。' : '好的，不部署了。' };
    if (text.includes('部署')) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: DEPLOY, arguments: JSON.stringify({ command: COMMAND }) },
          },
        ],
      };
    }
    const reply = Object.entries(replies).find(([said]) => text.includes(said))?.[1];
    if (reply === undefined) throw new Error(`假模型没有准备对「${text}」的回复`);
    return { content: reply };
  };
}

const VIEWPORTS: Record<'desktop' | 'phone', Viewport> = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

let clientDir: string;
let browser: Browser;

beforeAll(async () => {
  clientDir = mkdtempSync(join(tmpdir(), 'aalis-e2e-webui-client-'));
  const vite = join(dirname(createRequire(join(CLIENT, 'package.json')).resolve('vite/package.json')), 'bin/vite.js');
  const build = spawnSync(
    process.execPath,
    [vite, 'build', '--outDir', clientDir, '--emptyOutDir', '--logLevel', 'error'],
    {
      cwd: CLIENT,
      encoding: 'utf-8',
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 120_000,
    },
  );
  expect(build.status, `前端构建失败：${build.stderr}`).toBe(0);
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
}, 180_000);

// 浏览器的收尾须有界：10 秒仍未关掉就直接杀进程，不留残余 Chrome
afterAll(async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    browser?.close().catch(() => {}),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, 10_000);
    }),
  ]);
  clearTimeout(timer);
  browser?.process()?.kill('SIGKILL');
  rmSync(clientDir, { recursive: true, force: true });
}, 30_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 浏览器与 webui-server 之间的中转：cut() 切断现有的全部连接，之后的新连接照常转发 */
async function relay(target: number) {
  const sockets = new Set<Socket>();
  const server = createServer(inbound => {
    const outbound = connect(target, '127.0.0.1');
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // 切断时另一端会报连接被重置，这是预期的
      socket.on('error', () => {});
    }
    inbound.pipe(outbound).pipe(inbound);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const cut = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    port: (server.address() as AddressInfo).port,
    cut,
    close: () =>
      new Promise<void>(resolve => {
        cut();
        server.close(() => resolve());
      }),
  };
}

/** 起运行时：minimal 档的插件、内存记忆、假模型与 webui-server，再加一个需要批准的探针工具 */
async function startStack(replies: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aalis-e2e-webui-'));
  const { app } = hostedApp();
  cleanups.push(async () => {
    await app.stop();
    rmSync(home, { recursive: true, force: true });
  });
  provideHostPaths(app, home);
  app.bind({ provide }).provide(webuiClient, { getClientDir: () => clientDir });
  const minimal = await Promise.all(
    MINIMAL_BASE.map(async name => ((await import(name)) as { default: PluginDefinition }).default),
  );
  const port = await freePort();
  const definitions = [
    ...minimal,
    memoryInMemoryPlugin,
    createMockLLMPlugin({ responses: script(replies), latencyMs: CHUNK_MS }),
    webuiServerPlugin,
  ];
  await app.pluginAll(
    definitions.map(definition => ({
      definition,
      config:
        definition === webuiServerPlugin
          ? { host: '127.0.0.1', port, autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN }
          : {},
    })),
  );
  await app.plugins.idle();
  for (const definition of definitions) {
    expect(app.plugins.getPlugin(definition.name)?.state, `${definition.name} 未激活`).toBe('active');
  }
  const runs: string[] = [];
  app.bind({ tools }).tools.register({
    confirm: 'session',
    display: { kind: 'command', fields: { command: 'command' } },
    definition: {
      type: 'function',
      function: {
        name: DEPLOY,
        description: '部署',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    },
    handler: async args => {
      runs.push(String(args.command));
      return DEPLOYED;
    },
  });
  await app.start();
  await waitListening(port);
  const proxy = await relay(port);
  cleanups.push(proxy.close);
  return { origin: `http://127.0.0.1:${proxy.port}`, cut: proxy.cut, runs, app };
}

type Stack = Awaited<ReturnType<typeof startStack>>;

/**
 * 开一个新的浏览器上下文（各用例的存储互不相通），按 token 登录后打开 path。页面里的未捕获异常、
 * CSP 拦下的加载与回 4xx、5xx 的请求都记进 problems，用例结束时应为空
 */
async function openPage(stack: Stack, viewport: Viewport, path = '/') {
  const context = await browser.createBrowserContext();
  cleanups.push(() => context.close());
  const page = await context.newPage();
  await page.setViewport(viewport);
  const problems: string[] = [];
  page.on('pageerror', error => void problems.push(`未捕获的异常：${String(error)}`));
  page.on('response', response => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await page.exposeFunction('reportViolation', (text: string) => void problems.push(text));
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('securitypolicyviolation', event => {
      (window as unknown as { reportViolation(text: string): void }).reportViolation(
        `CSP 拦下了 ${event.blockedURI}（${event.violatedDirective}）`,
      );
    });
  });
  const response = (await page.goto(`${stack.origin}${path}?token=${TOKEN}`)) as HTTPResponse;
  return { page, problems, response };
}

const aria = (name: string, role: string) => `::-p-aria([name="${name}"][role="${role}"])`;
const text = (content: string) => `::-p-text(${content})`;
const toolLine = (page: Page) => page.$eval('.tool-line', element => element.textContent);

/** 当前会话的 id：地址是 /s/:id */
async function sessionIdOf(page: Page): Promise<string> {
  await page.waitForFunction(() => /^\/s\/[^/]+/.test(location.pathname));
  return decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
}

describe.each(Object.entries(VIEWPORTS))('%s', (width, viewport) => {
  const phone = width === 'phone';

  /** 打开新会话的输入框：桌面上首页就是；手机上从第一层点「新会话」进第二层 */
  async function newSession(page: Page) {
    if (phone) await page.locator(aria('新会话', 'button')).click();
    await page.waitForSelector(aria('消息', 'textbox'));
  }

  /**
   * 发一条消息：桌面上按回车发；触屏上回车只换行，按发送键发。先等上一轮收尾（输入框空着时出现的是发送键、
   * 不是停止键）：回合还在跑时发的新消息会让 agent 停掉那一轮
   */
  async function send(page: Page, message: string) {
    await page.waitForSelector(aria('发送', 'button'));
    const box = await page.waitForSelector(aria('消息', 'textbox'));
    await box?.type(message);
    await page.keyboard.press('Enter');
    if (!phone) return;
    expect(await box?.evaluate(element => (element as HTMLTextAreaElement).value)).toBe(`${message}\n`);
    await page.locator(aria('发送', 'button')).click();
  }

  it('打开、发消息、流式回复；外站图片只显示成链接；HTML 带 CSP', async () => {
    const stack = await startStack({
      你好: `收到，这是一段慢慢流出来的回复，用来看流式显示。![外站图片](${EXTERNAL_IMAGE})`,
    });
    const { page, problems, response } = await openPage(stack, viewport);
    expect(response.headers()['content-security-policy']).toBe(CSP);

    await newSession(page);
    await send(page, '你好');
    await sessionIdOf(page);
    const timeline = await page.waitForSelector(aria('对话', 'region'));
    // 每来一块都看一次：正在输出时正文至少长出过两个不同的前半段
    await page.waitForFunction(
      () => {
        const page = window as unknown as { partials?: Set<string> };
        page.partials ??= new Set();
        const shown = document.querySelector('[aria-label="对话"]')?.textContent ?? '';
        if (document.querySelector('[aria-label="正在输出"]') && !shown.includes('流式显示')) page.partials.add(shown);
        return page.partials.size >= 2;
      },
      { polling: 'mutation' },
    );
    await page.waitForSelector('::-p-aria(正在输出)', { hidden: true });
    expect(await timeline?.evaluate(element => element.textContent ?? '')).toContain('用来看流式显示');

    const link = await page.waitForSelector(`.message[data-from="agent"] a[href="${EXTERNAL_IMAGE}"]`);
    expect(await link?.evaluate(element => [element.textContent, element.getAttribute('rel')])).toEqual([
      '外站图片',
      'noopener noreferrer',
    ]);
    expect(await page.$$('img[src*="example.invalid"]')).toHaveLength(0);
    expect(problems).toEqual([]);
  }, 60_000);

  it('审批：批准；卡片不抢焦点，结算后收成一句，刷新后仍在', async () => {
    const stack = await startStack({ 你好: '先说一句。' });
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '你好');
    await sessionIdOf(page);
    await page.waitForSelector(text('先说一句。'));

    await send(page, '部署一下');
    const card = await page.waitForSelector(aria('审批', 'region'));
    expect(await card?.evaluate(element => element.textContent)).toContain(COMMAND);
    expect(await card?.evaluate(element => element.contains(document.activeElement))).toBe(false);
    if (!phone) {
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('消息');
    }
    expect(await toolLine(page)).toContain('等你批准');

    await page.locator(aria('批准', 'button')).click();
    await page.waitForSelector(text('部署好了。'));
    expect(await page.$$(aria('审批', 'region'))).toHaveLength(0);
    expect(await toolLine(page)).toMatch(/已批准 · \d{2}:\d{2}/);
    expect(stack.runs).toEqual([COMMAND]);

    await page.reload();
    await page.waitForSelector(text('部署好了。'));
    expect(await toolLine(page)).toMatch(/已批准 · \d{2}:\d{2}/);
    const said = await page.$$eval('.message[data-from="user"]', elements =>
      elements.map(element => element.textContent),
    );
    expect(said).toEqual(['你好', '部署一下']);
    await page.waitForSelector(text('先说一句。'));
    expect(problems).toEqual([]);
  }, 60_000);

  it('审批：拒绝，工具不执行，模型照常收尾', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '部署一下');
    await page.waitForSelector(aria('审批', 'region'));
    await page.locator(aria('拒绝', 'button')).click();
    await page.waitForSelector(text('好的，不部署了。'));
    expect(await toolLine(page)).toMatch(/已拒绝 · \d{2}:\d{2}/);
    expect(stack.runs).toEqual([]);
    expect(problems).toEqual([]);
  }, 60_000);

  it('切会话：从列表点开另一个会话，时间线跟着换', async () => {
    const stack = await startStack({ 第一个: '第一个的回复', 第二个: '第二个的回复' });
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '第一个会话');
    const first = await sessionIdOf(page);
    await page.waitForSelector(text('第一个的回复'));

    if (phone) await page.locator(aria('返回', 'button')).click();
    else await page.locator(aria('新会话', 'button')).click();
    await newSession(page);
    await send(page, '第二个会话');
    await page.waitForSelector(text('第二个的回复'));
    expect(await sessionIdOf(page)).not.toBe(first);

    if (phone) await page.locator(aria('返回', 'button')).click();
    await page.locator(`a[href="/s/${encodeURIComponent(first)}"]`).click();
    await page.waitForSelector(text('第一个的回复'));
    expect(await sessionIdOf(page)).toBe(first);
    const timeline = await page.waitForSelector(aria('对话', 'region'));
    expect(await timeline?.evaluate(element => element.textContent)).not.toContain('第二个');
    expect(problems).toEqual([]);
  }, 60_000);

  it('断线重连：重订打开着的会话、立即重报在场，等着的审批仍然可以批', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '部署一下');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(aria('审批', 'region'));

    const sent: string[] = [];
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameSent', ({ response }) => void sent.push(response.payloadData));
    stack.cut();
    await page.waitForSelector(text('连接断开，正在重连…'));
    await page.waitForSelector(text('已恢复'));

    const frames = sent.map(frame => JSON.parse(frame) as { method?: string; params?: unknown });
    expect(frames).toContainEqual(expect.objectContaining({ method: 'session/subscribe', params: { sessionId } }));
    expect(frames).toContainEqual(expect.objectContaining({ method: 'presence/update', params: { active: true } }));

    await page.locator(aria('批准', 'button')).click();
    await page.waitForSelector(text('部署好了。'));
    expect(stack.runs).toEqual([COMMAND]);
    expect(problems).toEqual([]);
  }, 60_000);

  it('房间表：窄时（容器窄于 36em）只留名称与状态，宽时各列都在', async () => {
    const stack = await startStack();
    await stack.app.bind({ sessionManager }).sessionManager.require().ensureSession('onebot:10000:group:20001', {
      name: '读书会',
    });
    const { page, problems } = await openPage(stack, viewport);
    await page.goto(`${stack.origin}/rooms?platform=onebot`);
    await page.waitForSelector(`td[data-column="name"] ${text('读书会')}`);
    const { width, columns } = await page.$eval('.table', table => ({
      width: table.clientWidth / Number.parseFloat(getComputedStyle(table).fontSize),
      columns: [...table.querySelectorAll('th[data-column]')]
        .filter(cell => getComputedStyle(cell).display !== 'none')
        .map(cell => cell.getAttribute('data-column')),
    }));
    if (phone) expect(width).toBeLessThanOrEqual(36);
    expect(columns).toEqual(width <= 36 ? ['name', 'status'] : ['name', 'type', 'status', 'active', 'replied']);
    expect(problems).toEqual([]);
  }, 60_000);

  it('最少插件组合：没有计划标签、回滚、压缩与压缩线，也没有空着的区域', async () => {
    const stack = await startStack({ 你好: '好的。' });
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '你好');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(text('好的。'));
    const meter = await page.waitForSelector('[aria-label^="上下文已用"]');

    // 回滚按钮平时藏着、悬停才出现，按属性找，不按读屏树找
    expect(await page.$$('[aria-label="回滚这一轮"]')).toHaveLength(0);
    await page.locator(`main ${aria('更多', 'button')}`).click();
    const items = await page.$$eval('[role="menuitem"]', elements => elements.map(element => element.textContent));
    expect(items).toEqual([...(phone ? ['全部展开', '会话面板'] : []), '改名', '归档', '删除']);
    await page.keyboard.press('Escape');
    expect(
      await meter?.evaluate(element => [element.getAttribute('title'), element.hasAttribute('data-tone')]),
    ).toEqual([expect.stringMatching(/^上下文已用 \d+%$/), false]);

    if (phone) {
      await meter?.click();
      await page.waitForSelector(aria('上下文用量', 'table'));
      expect(await page.$$(text('自动压缩'))).toHaveLength(0);
      await page.locator(aria('关闭', 'button')).click();
      await page.locator(`main ${aria('更多', 'button')}`).click();
      await page.locator(aria('会话面板', 'menuitem')).click();
      await page.waitForFunction(id => location.pathname === `/s/${encodeURIComponent(id)}/settings`, {}, sessionId);
    }
    const tabs = await page.$$eval('[role="tab"]', elements => elements.map(element => element.textContent));
    expect(tabs).toEqual(phone ? ['设置'] : ['设置', '用量']);
    expect(await page.$$('.setting-row')).not.toHaveLength(0);
    if (!phone) {
      await page.locator(aria('用量', 'tab')).click();
      await page.waitForSelector(aria('上下文用量', 'table'));
      expect(await page.$$(text('自动压缩'))).toHaveLength(0);
    }
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('文档与主题', () => {
  it('在 /s/:id 上刷新能加载；缺失的静态资源回 404', async () => {
    const stack = await startStack({ 你好: '好的。' });
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop);
    const box = await page.waitForSelector(aria('消息', 'textbox'));
    await box?.type('你好');
    await page.keyboard.press('Enter');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(text('好的。'));

    const reload = (await page.reload()) as HTTPResponse;
    expect(reload.status()).toBe(200);
    expect(reload.headers()['content-security-policy']).toBe(CSP);
    await page.waitForSelector(text('好的。'));
    expect(await sessionIdOf(page)).toBe(sessionId);

    const missing = await page.evaluate(async () => {
      const res = await fetch('/assets/missing-0000.js');
      return { status: res.status, body: await res.text() };
    });
    expect(missing).toEqual({ status: 404, body: '' });
    expect(problems).toEqual([`404 ${stack.origin}/assets/missing-0000.js`]);
  }, 60_000);

  it('跟随系统：系统切换深浅时页面跟着换主题；刷新时第一帧就是选定的主题', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop);
    const shows = (theme: string, background: string) =>
      page.waitForFunction(
        (theme, background) =>
          document.documentElement.dataset.theme === theme &&
          getComputedStyle(document.documentElement).backgroundColor === background,
        {},
        theme,
        background,
      );

    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await shows('calm-dark', 'rgb(29, 29, 32)');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await shows('calm-light', 'rgb(251, 251, 250)');

    // 第一帧之前的 requestAnimationFrame 回调里记下当时的主题与底色
    await page.evaluateOnNewDocument(() => {
      requestAnimationFrame(() => {
        (window as unknown as { firstFrame: unknown }).firstFrame = [
          document.documentElement.dataset.theme,
          getComputedStyle(document.documentElement).backgroundColor,
        ];
      });
    });
    await page.reload();
    await page.waitForFunction(() => 'firstFrame' in window);
    expect(await page.evaluate(() => (window as unknown as { firstFrame: unknown }).firstFrame)).toEqual([
      'calm-light',
      'rgb(251, 251, 250)',
    ]);

    // 固定一个内置主题：首帧脚本在内置主题的规则之后执行，认得出它，不会当成不在了换回默认
    await page.evaluate(() => localStorage.setItem('aalis.appearance', '{"follow":false,"theme":"brand-dark"}'));
    await page.reload();
    await page.waitForFunction(() => 'firstFrame' in window);
    expect(await page.evaluate(() => (window as unknown as { firstFrame: unknown[] }).firstFrame[0])).toBe(
      'brand-dark',
    );
    expect(problems).toEqual([]);
  }, 60_000);
});
