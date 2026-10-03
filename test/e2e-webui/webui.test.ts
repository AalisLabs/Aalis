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
import { type PageHandle, type TableRow, webuiClient, webuiServer } from '../../packages/api-webui/src/index.js';
import { definePlugin, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import { MINIMAL_BASE } from '../../packages/create-aalis/src/cli.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import schedulerPlugin from '../../packages/plugin-scheduler/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 端到端：构建前端，起最少插件组合的运行时（create-aalis 的 minimal 档，加内存记忆、假模型与 webui-server，
// 不装计划、检查点、摘要），在真的 Chromium 里按桌面与手机两种宽度走主流程；按宽度变的排版（房间表、声明式页面与
// 会话面板的容器查询）只有真的排版才验得了，也在这里核。声明式页面用一个探针插件登记，另装迁移过来的计划任务与工作流看
// 真实插件的页面。浏览器经一个可以切断的中转连到 webui-server，断线重连靠它模拟。假模型按这一轮的
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
/** 经工作流页「新建或覆盖」填进去的定义 */
const WORKFLOW = `id: zz-daily
name: 每日整理
trigger:
  type: manual
nodes:
  - id: pause
    type: wait
    seconds: 1`;

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

/** 看板里名字很长的一行，带一段中间没有断行机会的文件名：窄时写字的列折行，不把后面的状态列挤出视野 */
const LONG_NAME = '把这个季度的周报整理进 weekly_summary_final_2026_q3_reviewed_by_everyone.md 再发给负责人确认';

/** 带原因的失败状态：窄时折行，不撑出横向滚动，也不把同一行的第一列挤成一字一行 */
const LONG_FAILURE = '失败：远端代理返回 500 Internal Server Error，请稍后再试';

/** 看板的行与登记拿到的句柄：用例改了行、经句柄推 invalidate，看打开着的页面跟着变；每次激活重置 */
const board: { rows: TableRow[]; page?: PageHandle } = { rows: [] };

/**
 * 页面探针：一个位置为插件详情的看板（带详情与行动作的表格）、一个键值加关系图的统计页，以及一个适用于全部会话的便签面板
 */
const PAGES_PROBE = 'zz-e2e-pages';
const probePages = definePlugin({
  name: PAGES_PROBE,
  uses: { webui: webuiServer },
  apply({ webui }) {
    board.rows = [
      { id: 'a', name: '整理周报', owner: '小明', state: { text: '进行中', state: 'running' }, note: '周一前' },
      { id: 'b', name: '部署文档', owner: '小红', state: { text: '待办' }, note: '' },
      { id: 'c', name: LONG_NAME, owner: '小刚', state: { text: '待办' }, note: '' },
    ];
    board.page = webui.definePage({
      key: 'board',
      title: '看板',
      icon: 'kanban',
      actions: {
        mark: { label: '标记', effect: 'write', row: true, handler: ({ rowKey }) => `已标记 ${rowKey}` },
        drop: { label: '删除', effect: 'destructive', row: true, handler: () => undefined },
      },
      content: [
        { type: 'info', id: 'summary', data: () => [{ label: '条目数', value: board.rows.length }] },
        {
          type: 'table',
          id: 'items',
          rowKey: 'id',
          columns: [
            { key: 'name', label: '名称', primary: true },
            { key: 'owner', label: '负责人' },
            { key: 'state', label: '状态', kind: 'status', primary: true },
            { key: 'note', label: '备注' },
          ],
          rowActions: [{ action: 'mark' }, { action: 'drop' }],
          detail: [{ type: 'info', id: 'item', data: ({ rowKey }) => [{ label: '编号', value: rowKey }] }],
          data: () => board.rows,
        },
      ],
    });
    webui.definePage({
      key: 'stats',
      title: '统计',
      content: [
        { type: 'info', id: 'numbers', data: () => [{ label: '总数', value: 2 }] },
        {
          type: 'graph',
          id: 'links',
          nodeKinds: [
            { kind: 'person', label: '人物', tone: 1 },
            { kind: 'thing', label: '实体', tone: 3 },
          ],
          edgeKinds: [{ kind: 'knows', label: '认识', tone: 2 }],
          data: () => ({
            nodes: [
              { id: 'a', label: '小明', kind: 'person' },
              { id: 'b', label: '小红', kind: 'person' },
            ],
            edges: [{ source: 'a', target: 'b', kind: 'knows' }],
          }),
          detail: [{ type: 'info', id: 'person', data: ({ rowKey }) => [{ label: '编号', value: rowKey }] }],
        },
        {
          type: 'table',
          id: 'log',
          label: '日志',
          rowKey: 'id',
          columns: [
            { key: 'message', label: '说明', kind: 'long-text', primary: true },
            { key: 'state', label: '状态', kind: 'status', primary: true },
          ],
          data: () => [
            { id: '1', message: `${LONG_NAME}；${LONG_NAME}`, state: { text: '进行中', state: 'running' } },
            { id: '2', message: '整理周报', state: { text: LONG_FAILURE, state: 'error' } },
          ],
        },
      ],
    });
    webui.definePage({
      key: 'notes',
      title: '便签',
      placement: 'session',
      content: [
        {
          type: 'table',
          id: 'notes',
          rowKey: 'id',
          columns: [
            { key: 'text', label: '内容', primary: true },
            { key: 'at', label: '时间', kind: 'time' },
          ],
          data: ({ ctx }) => [{ id: '1', text: `会话 ${ctx.sessionId}`, at: Date.now() }],
        },
      ],
    });
  },
});

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

/** 起运行时：minimal 档的插件、内存记忆、假模型与 webui-server，再加一个需要批准的探针工具；extra 是另加的插件 */
async function startStack(replies: Record<string, string> = {}, extra: PluginDefinition[] = []) {
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
    ...extra,
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

/** 位置为插件详情的页面的地址 */
const pagePath = (instance: string, pageKey: string) =>
  `/p/${encodeURIComponent(instance)}/${encodeURIComponent(pageKey)}`;

/** 图标栏里各项的名字（桌面） */
const railNames = (page: Page) =>
  page.$$eval('.shell-rail a', links => links.map(link => link.getAttribute('aria-label')));

/** 显示着的列 */
const shownColumns = (page: Page, scope: string) =>
  page.$$eval(`${scope} .table th[data-column]`, cells =>
    cells.filter(cell => getComputedStyle(cell).display !== 'none').map(cell => cell.getAttribute('data-column')),
  );

/** 等到写着 message 的 Toast 再关掉它：手机上 Toast 在顶部，会盖住下面的按钮 */
async function toastSays(page: Page, message: string) {
  await page.waitForSelector(`.toast ${text(message)}`);
  await page.locator(`.toast ${aria('关闭', 'button')}`).click();
  await page.waitForSelector('.toast', { hidden: true });
}

/** 带输入的动作弹出的表单里，按标签找到输入框填进去 */
async function fill(page: Page, dialog: string, fields: Record<string, string>) {
  for (const [label, value] of Object.entries(fields)) {
    await page.locator(`${aria(dialog, 'dialog')} ${aria(label, 'textbox')}`).fill(value);
  }
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

  it('代码块的复制按钮：桌面上悬停才出现，代码照常从内边距开始；触屏上常显，不压住第一行代码', async () => {
    const stack = await startStack({
      代码: '```sh\nnpm run build --workspace packages/plugin-webui-client --if-present\nnpm test\n```',
    });
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '代码');
    const block = await page.waitForSelector('.message[data-from="agent"] .markdown-code');
    await page.waitForSelector('::-p-aria(正在输出)', { hidden: true });
    /** 复制按钮的可见性与上下边，第一行代码的上下边（pre 内容区的顶上一行，长行横向铺满内容区） */
    const measure = () =>
      block?.evaluate(element => {
        const button = element.querySelector('button') as HTMLElement;
        const pre = element.querySelector('pre') as HTMLElement;
        const style = getComputedStyle(pre);
        const top = pre.getBoundingClientRect().top + Number.parseFloat(style.paddingTop);
        const { top: buttonTop, bottom: buttonBottom } = button.getBoundingClientRect();
        return {
          visible: getComputedStyle(button).visibility === 'visible',
          label: button.getAttribute('aria-label'),
          paddingTop: style.paddingTop,
          button: [buttonTop, buttonBottom],
          line: [top, top + Number.parseFloat(style.lineHeight)],
        };
      });
    if (phone) {
      const shown = await measure();
      expect(shown).toMatchObject({ visible: true, label: '复制代码' });
      const [buttonTop, buttonBottom] = shown?.button ?? [];
      const [lineTop, lineBottom] = shown?.line ?? [];
      expect(
        (buttonBottom as number) <= (lineTop as number) || (buttonTop as number) >= (lineBottom as number),
        `按钮 ${shown?.button} 压住了第一行 ${shown?.line}`,
      ).toBe(true);
    } else {
      expect(await measure()).toMatchObject({ visible: false, paddingTop: '12px' });
      await block?.hover();
      expect(await measure()).toMatchObject({ visible: true, label: '复制代码', paddingTop: '12px' });
    }
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

  it('最少插件组合：没有计划标签、回滚、压缩与压缩线，没有页面时图标栏只有宿主项（手机上第一层没有固定的页面）、右侧面板没有「+」，也没有空着的区域', async () => {
    const stack = await startStack({ 你好: '好的。' });
    const { page, problems } = await openPage(stack, viewport);
    await page.waitForNetworkIdle({ idleTime: 300 });
    if (phone) expect(await page.$$(aria('固定的页面', 'list'))).toHaveLength(0);
    else expect(await railNames(page)).toEqual(['会话']);
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
    await page.waitForNetworkIdle({ idleTime: 300 });
    expect(await page.$$(aria('打开标签', 'button'))).toHaveLength(0);
    if (!phone) {
      await page.locator(aria('用量', 'tab')).click();
      await page.waitForSelector(aria('上下文用量', 'table'));
      expect(await page.$$(text('自动压缩'))).toHaveLength(0);
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('声明式页面按宽度变形：宽时各列都在、行上第一个动作是文字按钮、详情在右边；窄时只留 primary 列、长的字折行而不把后面的列挤出视野、动作都在「更多」、详情代替列表', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, viewport, pagePath(PAGES_PROBE, 'board'));
    await page.waitForSelector(`td[data-column="name"] ${text('整理周报')}`);
    expect(await shownColumns(page, 'main')).toEqual(phone ? ['name', 'state'] : ['name', 'owner', 'state', 'note']);
    expect(await page.$$(aria('标记', 'button'))).toHaveLength(phone ? 0 : 3);
    /** 表格在自己的框里放得下，不用横向滚动才看得到后面的列 */
    const fits = (scope: string) =>
      page.$eval(`${scope} .table-scroll`, element => element.scrollWidth <= element.clientWidth);
    expect(await fits('main')).toBe(true);

    await page.locator(`tr:first-child ${aria('更多', 'button')}`).click();
    const items = await page.$$eval('[role="menuitem"]', elements => elements.map(element => element.textContent));
    expect(items).toEqual(phone ? ['标记', '删除'] : ['删除']);
    await page.keyboard.press('Escape');

    await page.locator(aria('整理周报', 'link')).click();
    await page.waitForSelector(`${aria('整理周报', 'region')} ${text('编号')}`);
    const listShown = () => page.$eval('.page-master-list', element => getComputedStyle(element).display !== 'none');
    expect(await listShown()).toBe(!phone);
    // 窄时详情代替这一屏：同一屏的其他组件收起；宽时列表变窄，按表格的窄宽度规则只留主要列
    const shownBlocks = await page.$$eval(
      'main .page-screen > .page-block',
      blocks =>
        blocks.filter(block => !block.closest('.page-detail') && getComputedStyle(block).display !== 'none').length,
    );
    expect(shownBlocks).toBe(phone ? 1 : 2);
    if (phone) {
      await page.locator(aria('返回列表', 'button')).click();
      await page.waitForSelector(aria('整理周报', 'region'), { hidden: true });
      expect(await listShown()).toBe(true);
    } else {
      expect(await page.$$(aria('返回列表', 'button'))).toHaveLength(0);
      const [list, detail] = await page.$$eval('.page-master-list, .page-detail', elements =>
        elements.map(element => element.getBoundingClientRect().toJSON() as DOMRect),
      );
      expect(detail.left).toBeGreaterThanOrEqual(list.right);
      expect(await shownColumns(page, '.page-master-list')).toEqual(['name', 'state']);
      expect(await fits('.page-master-list')).toBe(true);
      await page.locator(aria('关闭详情', 'button')).click();
      await page.waitForSelector(aria('整理周报', 'region'), { hidden: true });
    }
    expect(new URL(page.url()).search).toBe('');
    expect(problems).toEqual([]);
  }, 60_000);

  it('关系图：缩放按钮里的图标与标题栏的一样大；图例只列图里有的类别；点选节点看详情，不留浏览器的默认焦点框', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, viewport, pagePath(PAGES_PROBE, 'stats'));
    await page.waitForSelector(`.page-graph ${text('小明')}`);
    const sizes = await page.$$eval('main header [aria-label="刷新"] .lucide, .page-graph-zoom .lucide', icons =>
      icons.map(icon => icon.getBoundingClientRect().width),
    );
    expect(sizes).toHaveLength(4);
    expect(new Set(sizes).size).toBe(1);
    expect(await page.$$eval('.page-graph-legend li', items => items.map(item => item.textContent))).toEqual([
      '人物',
      '认识',
    ]);

    await page.locator(aria('小明', 'button')).click();
    await page.waitForSelector(`${aria('小明', 'region')} ${text('编号')}`);
    // 触屏上点按不移焦点；桌面上点中的节点得到焦点，但不该画出焦点框
    if (!phone)
      expect(
        await page.evaluate(() => [
          document.activeElement?.getAttribute('aria-pressed'),
          getComputedStyle(document.activeElement as Element).outlineStyle,
        ]),
      ).toEqual(['true', 'none']);
    expect(problems).toEqual([]);
  }, 60_000);

  it('长文本与状态单元格：长文本收起时只占一行、点开后显示全文，短的状态不折开、长的窄时折行；表格在自己的框里放得下', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, viewport, pagePath(PAGES_PROBE, 'stats'));
    const log = `${aria('日志', 'table')}`;
    await page.waitForSelector(`${log} .page-long-text`);
    /** 一个元素占几行：按它的高度与行高算 */
    const lines = (selector: string) =>
      page.$eval(selector, element =>
        Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight)),
      );
    const fits = () =>
      page.$eval(`${log}`, table => {
        const scroll = table.closest('.table-scroll') as HTMLElement;
        return scroll.scrollWidth <= scroll.clientWidth;
      });
    expect(await lines(`${log} .page-long-text > span`)).toBe(1);
    expect(await lines(`${log} .status-text`)).toBe(1);
    expect(await fits()).toBe(true);
    const failed = `${log} tbody tr:nth-child(2)`;
    expect(
      await page.$eval(`${failed} td[data-column="message"]`, cell => cell.getBoundingClientRect().width),
    ).toBeGreaterThan(80);
    if (phone) expect(await lines(`${failed} .status-text`)).toBeGreaterThan(1);
    await page.locator(`${log} .page-long-text`).click();
    await page.waitForSelector(`${log} .page-long-text[aria-expanded="true"]`);
    // 点开后按格子的宽度折行，全文都不再被截
    expect(await lines(`${log} .page-long-text > span`)).toBeGreaterThan(1);
    expect(await page.$eval(`${log} .page-long-text > span`, span => span.scrollHeight <= span.clientHeight)).toBe(
      true,
    );
    expect(await fits()).toBe(true);
    expect(problems).toEqual([]);
  }, 60_000);

  it('计划任务：「新建」是带输入的动作，保存后经 page.invalidate 出现在表里；「编辑」按这一行预填；「删除」先确认', async () => {
    const stack = await startStack({}, [cronEnginePlugin, schedulerPlugin]);
    const { page, problems } = await openPage(stack, viewport, pagePath(schedulerPlugin.name, 'scheduler'));
    await page.waitForSelector(text('还没有计划任务'));

    await page.locator(`main ${aria('新建', 'button')}`).click();
    await fill(page, '新建', {
      名称: '早报',
      'Cron 表达式': '0 8 * * *',
      '目标会话 ID': 'internal',
      消息内容: '整理今天的新闻',
    });
    await page.locator(`${aria('新建', 'dialog')} ${aria('新建', 'button')}`).click();
    await toastSays(page, '已保存任务 早报');
    await page.waitForSelector(`td[data-column="name"] ${text('早报')}`);
    await page.waitForSelector(aria('新建', 'dialog'), { hidden: true });

    await page.locator(`tbody tr ${aria('更多', 'button')}`).click();
    await page.locator(aria('编辑', 'menuitem')).click();
    const field = (label: string) =>
      page.$eval(`${aria('编辑', 'dialog')} ${aria(label, 'textbox')}`, element => (element as HTMLInputElement).value);
    expect([await field('Cron 表达式'), await field('目标会话 ID'), await field('消息内容')]).toEqual([
      '0 8 * * *',
      'internal',
      '整理今天的新闻',
    ]);
    await page.locator(`${aria('编辑', 'dialog')} ${aria('取消', 'button')}`).click();
    await page.waitForSelector(aria('编辑', 'dialog'), { hidden: true });

    await page.locator(`tbody tr ${aria('更多', 'button')}`).click();
    await page.locator(aria('删除', 'menuitem')).click();
    const confirm = await page.waitForSelector(aria('删除？', 'dialog'));
    expect(await confirm?.evaluate(element => element.textContent)).toContain('删除这个计划任务？');
    await page.locator(`${aria('删除？', 'dialog')} ${aria('删除', 'button')}`).click();
    await toastSays(page, '已删除 早报');
    await page.waitForSelector(text('还没有计划任务'));
    expect(problems).toEqual([]);
  }, 60_000);

  it('工作流：「新建或覆盖」保存后出现在表里，选中一行看 YAML 详情', async () => {
    const stack = await startStack({}, [cronEnginePlugin, workflowPlugin]);
    const { page, problems } = await openPage(stack, viewport, pagePath(workflowPlugin.name, 'workflows'));
    await page.waitForSelector(text('还没有工作流'));

    await page.locator(aria('新建或覆盖', 'button')).click();
    await fill(page, '新建或覆盖', { 'YAML 定义': WORKFLOW });
    await page.locator(`${aria('新建或覆盖', 'dialog')} ${aria('新建或覆盖', 'button')}`).click();
    await toastSays(page, '已保存工作流 zz-daily');
    await page.waitForSelector(aria('新建或覆盖', 'dialog'), { hidden: true });

    await page.locator(aria('每日整理', 'link')).click();
    await page.waitForSelector(`${aria('每日整理', 'region')} ${text('id: zz-daily')}`);
    if (phone) {
      expect(await page.$$(aria('定义', 'table'))).toHaveLength(0);
      await page.locator(aria('返回列表', 'button')).click();
      await page.waitForSelector(aria('每日整理', 'region'), { hidden: true });
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('固定与取消：从标题栏固定后出现在图标栏（手机上在第一层的「固定的页面」里），再按一次取消；所属插件停用时显示占位，重新启用后回到原页', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, viewport, pagePath(PAGES_PROBE, 'board'));
    await page.waitForSelector(aria('看板', 'heading'));
    const pin = aria('固定到图标栏', 'button');
    const pressed = (value: string) =>
      page.waitForFunction(
        value => document.querySelector('[aria-label="固定到图标栏"]')?.getAttribute('aria-pressed') === value,
        {},
        value,
      );
    /** 固定着的页面：桌面看图标栏；手机回第一层看「固定的页面」，再回到看板 */
    async function pinned(): Promise<Array<string | null>> {
      if (!phone) return (await railNames(page)).slice(1);
      await page.locator(aria('返回', 'button')).click();
      await page.waitForFunction(() => location.pathname === '/');
      await page.waitForNetworkIdle({ idleTime: 300 });
      const names = await page.$$eval('[aria-label="固定的页面"] a', links => links.map(link => link.textContent));
      await page.goto(`${stack.origin}${pagePath(PAGES_PROBE, 'board')}`);
      await page.waitForSelector(aria('看板', 'heading'));
      return names;
    }

    await page.locator(pin).click();
    await pressed('true');
    expect(await pinned()).toEqual(['看板']);
    if (!phone) {
      expect(await page.$eval('.shell-rail a[aria-label="看板"]', link => link.getAttribute('aria-current'))).toBe(
        'page',
      );
    }

    await stack.app.plugins.disable(PAGES_PROBE);
    await page.waitForSelector(text('这个页面所属的插件已停用'));
    if (!phone) await page.waitForFunction(() => document.querySelectorAll('.shell-rail a').length === 1);
    await stack.app.plugins.enable(PAGES_PROBE);
    await page.waitForSelector(`td[data-column="name"] ${text('整理周报')}`);
    expect(await pinned()).toEqual(['看板']);

    await page.locator(pin).click();
    await pressed('false');
    expect(await pinned()).toEqual([]);
    expect(problems).toEqual([]);
  }, 60_000);

  it('会话面板：「+」打开便签，追加在宿主标签后面，换一个浏览器仍在；数据源拿到当前会话；面板宽度下表格只留 primary 列，刷新在标签栏里；关闭按钮只在当前标签上，关了的标签（宿主的也一样）进「+」，再打开回到原位', async () => {
    const stack = await startStack({ 你好: '好的。' }, [probePages]);
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '你好');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(text('好的。'));
    await page.waitForSelector('[aria-label^="上下文已用"]');
    const notes = `aside ${text(`会话 ${sessionId}`)}`;
    const tabNames = () => page.$$eval('aside [role="tab"]', tabs => tabs.map(tab => tab.textContent));
    const closeButtons = () =>
      page.$$eval('aside [aria-label^="关闭「"]', buttons => buttons.map(button => button.getAttribute('aria-label')));
    /** 手机上会话面板是从会话头的「更多」进去的一层，关掉标签回到会话 */
    async function openPanel() {
      if (!phone) return;
      await page.waitForFunction(id => location.pathname === `/s/${encodeURIComponent(id)}`, {}, sessionId);
      await page.locator(`main ${aria('更多', 'button')}`).click();
      await page.locator(aria('会话面板', 'menuitem')).click();
    }
    /** 从「+」打开一项 */
    async function reopen(name: string) {
      await page.locator(aria('打开标签', 'button')).click();
      await page.locator(aria(name, 'menuitem')).click();
    }
    const opened = phone ? ['设置', '便签'] : ['设置', '用量', '便签'];

    await openPanel();
    await reopen('便签');
    await page.waitForSelector(notes);
    expect(new URL(page.url()).pathname).toBe(`/s/${encodeURIComponent(sessionId)}/p/${PAGES_PROBE}/notes`);
    expect(await tabNames()).toEqual(opened);
    expect(await closeButtons()).toEqual(['关闭「便签」']);
    expect(await shownColumns(page, 'aside')).toEqual(['text']);
    expect(await page.$$(`aside .tabs-bar ${aria('刷新', 'button')}`)).toHaveLength(1);

    await page.reload();
    await page.waitForSelector(notes);
    // 标签记录跟着 owner 存在服务端：换一个浏览器打开这个会话的面板，便签的标签照样在
    const other = await openPage(stack, viewport, `/s/${encodeURIComponent(sessionId)}/settings`);
    await other.page.waitForSelector(aria('便签', 'tab'));
    expect(other.problems).toEqual([]);

    await page.locator(aria('关闭「便签」', 'button')).click();
    await openPanel();
    await page.waitForSelector(aria('便签', 'tab'), { hidden: true });
    await reopen('便签');
    await page.waitForSelector(notes);
    expect(await tabNames()).toEqual(opened);

    await page.locator(aria('设置', 'tab')).click();
    await page.locator(aria('关闭「设置」', 'button')).click();
    await openPanel();
    await page.waitForSelector(aria('设置', 'tab'), { hidden: true });
    await page.locator(aria('打开标签', 'button')).click();
    expect(await page.$$eval('[role="menuitem"]', items => items.map(item => item.textContent))).toEqual(['设置']);
    await page.locator(aria('设置', 'menuitem')).click();
    await page.waitForSelector('.setting-row');
    expect(await tabNames()).toEqual(opened);
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('页面数据', () => {
  it('page.invalidate：插件改了数据推一次，打开着的页面跟着更新，不用手动刷新', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop, pagePath(PAGES_PROBE, 'board'));
    await page.waitForSelector(`td[data-column="name"] ${text('整理周报')}`);
    board.rows = [...board.rows, { id: 'd', name: '新来的一项', owner: '小李', state: { text: '待办' }, note: '' }];
    board.page?.invalidate('items');
    await page.waitForSelector(`td[data-column="name"] ${text('新来的一项')}`);
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('页面在外壳里的位置', () => {
  const desktop = VIEWPORTS.desktop;

  it('固定：两台设备同时从标题栏固定不同页面，两项都在、互相推到；换一个浏览器仍在，顺序一致', async () => {
    const stack = await startStack({}, [probePages]);
    const first = await openPage(stack, desktop, pagePath(PAGES_PROBE, 'board'));
    const second = await openPage(stack, desktop, pagePath(PAGES_PROBE, 'stats'));
    await first.page.waitForSelector(aria('看板', 'heading'));
    await second.page.waitForSelector(text('总数'));
    expect(await railNames(first.page)).toEqual(['会话']);

    await Promise.all([
      first.page.locator(aria('固定到图标栏', 'button')).click(),
      second.page.locator(aria('固定到图标栏', 'button')).click(),
    ]);
    for (const { page } of [first, second]) {
      await page.waitForFunction(() => document.querySelectorAll('.shell-rail a').length === 3);
      expect((await railNames(page)).sort()).toEqual(['会话', '看板', '统计'].sort());
    }
    const order = await railNames(first.page);
    const third = await openPage(stack, desktop);
    await third.page.waitForFunction(() => document.querySelectorAll('.shell-rail a').length === 3);
    expect(await railNames(third.page)).toEqual(order);
    for (const { problems } of [first, second, third]) expect(problems).toEqual([]);
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
