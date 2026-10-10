import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type HTTPResponse, type Page, type Viewport } from 'puppeteer';
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import { hostLogs } from '../../packages/api-host-logs/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { webuiClient } from '../../packages/api-webui/src/index.js';
import { type App, LogHub, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import { MINIMAL_BASE } from '../../packages/create-aalis/src/cli.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { setupFileLogger } from '../../packages/runtime/src/file-logger.js';
import { createHostLogs } from '../../packages/runtime/src/host-logs.js';
import { freePort } from '../helpers/net.js';
import { hostedApp } from './app.js';
import { provideHostPaths } from './host-paths.js';
import { seedRooms } from './rooms.js';

// ════════════════════════════════════════════════════════════
// WebUI 端到端的共用部分：构建前端、起浏览器、起最少插件组合的运行时（create-aalis 的 minimal 档，加内存记忆、
// 给定的模型与 webui-server）、按 token 登录打开页面。各个端到端文件自己写场景与探针插件。
// ════════════════════════════════════════════════════════════

const CLIENT = join(import.meta.dirname, '../../packages/plugin-webui-client');

export const TOKEN = 'zz-e2e-webui-token-placeholder-0000';

export const VIEWPORTS: Record<'desktop' | 'phone', Viewport> = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

/** 按读屏树的名字与角色找 */
export const aria = (name: string, role: string) => `::-p-aria([name="${name}"][role="${role}"])`;
/** 按文字找 */
export const text = (content: string) => `::-p-text(${content})`;

/** 用例结束时按登记的反序执行 */
export type Cleanups = Array<() => Promise<void>>;

/** 构建前端到一个临时目录，回这个目录 */
function buildClient(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-e2e-webui-client-'));
  const vite = join(dirname(createRequire(join(CLIENT, 'package.json')).resolve('vite/package.json')), 'bin/vite.js');
  const build = spawnSync(process.execPath, [vite, 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: CLIENT,
    encoding: 'utf-8',
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 120_000,
  });
  expect(build.status, `前端构建失败：${build.stderr}`).toBe(0);
  return dir;
}

const launchBrowser = () => puppeteer.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server'] });

/** 收尾须有界：浏览器 10 秒仍未关掉就直接杀进程，不留残余 Chrome；再删掉构建出的前端 */
async function closeBrowser(browser: Browser | undefined, clientDir: string): Promise<void> {
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
}

/**
 * 一个端到端文件的共用部分：文件开始时构建前端、起浏览器，结束时关掉；每个用例结束时按登记的反序执行 cleanups。
 * clientDir 与 browser 在 beforeAll 之后才有
 */
export function useWebuiE2E() {
  const e2e = { cleanups: [] as Cleanups } as { clientDir: string; browser: Browser; cleanups: Cleanups };
  beforeAll(async () => {
    e2e.clientDir = buildClient();
    e2e.browser = await launchBrowser();
  }, 180_000);
  afterAll(() => closeBrowser(e2e.browser, e2e.clientDir), 30_000);
  afterEach(async () => {
    for (const cleanup of e2e.cleanups.splice(0).reverse()) await cleanup();
  });
  return e2e;
}

/** 在临时目录里搭一个带插件前端的包：webui 目录里放 files，回插件的 module 地址。收尾登记进 cleanups */
export function framePackage(name: string, files: Record<string, string>, cleanups: Cleanups): string {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'aalis-e2e-frames-'))), name);
  cleanups.push(async () => rmSync(dirname(root), { recursive: true, force: true }));
  mkdirSync(join(root, 'webui'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, files: ['dist', 'webui'] }));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, 'webui', file), content);
  return pathToFileURL(join(root, 'dist/index.js')).href;
}

/**
 * 起运行时，还没 start：minimal 档的插件、内存记忆、model（模型的插件，不给时不装模型）、webui-server 与 extra，逐个核已激活。
 * webui 是 webui-server 另加的配置（如市场的检索源），slowThresholdMs 是慢激活阈值，doc 是宿主配置文档（如脚手架写的那份），
 * rooms 是会话表里预置的已收录房间（会话 id → 名字）。
 * 日志与 runtime 一样记到 info、写进家目录的 logs/latest.log，日志标签的历史读它。收尾登记进 cleanups
 */
export async function webuiStack(options: {
  clientDir: string;
  model?: PluginDefinition;
  extra: PluginDefinition[];
  cleanups: Cleanups;
  webui?: Record<string, unknown>;
  slowThresholdMs?: number;
  doc?: Partial<AalisConfig>;
  rooms?: Record<string, string>;
}): Promise<{ app: App; port: number }> {
  const { clientDir, model, extra, cleanups, webui, slowThresholdMs, doc, rooms } = options;
  const home = mkdtempSync(join(tmpdir(), 'aalis-e2e-webui-'));
  const { app } = hostedApp({ ...doc, logLevel: 'info' }, { slowThresholdMs });
  cleanups.push(async () => {
    await app.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { logs } = provideHostPaths(app, home);
  const fileLog = await setupFileLogger(join(logs, 'latest.log'));
  cleanups.push(() => fileLog.dispose());
  // 与 runtime 一样在根上提供读日志的 host-logs：历史读这份文件日志，实时接默认中枢
  const host = app.bind({ provide }).provide;
  host.use(hostLogs, createHostLogs(LogHub.default, fileLog, app.logger), { exclusive: true });
  host.use(webuiClient, { getClientDir: () => clientDir });
  const minimal = await Promise.all(
    MINIMAL_BASE.map(async name => ((await import(name)) as { default: PluginDefinition }).default),
  );
  const port = await freePort();
  // 房间的来源字段只经原生入站记下，而这里起的是整条入站链（发原生入站会跑一轮回合）：要房间时内存记忆先起，
  // 在会话管理读表之前把收录过的记录预置进去
  if (rooms) {
    await app.plugin(memoryInMemoryPlugin, {});
    await app.plugins.idle();
    await seedRooms(app.bind({ memory }).memory.use, rooms);
  }
  const definitions = [
    ...minimal,
    ...(rooms ? [] : [memoryInMemoryPlugin]),
    ...(model ? [model] : []),
    webuiServerPlugin,
    ...extra,
  ];
  await app.pluginAll(
    definitions.map(definition => ({
      definition,
      config:
        definition === webuiServerPlugin
          ? { host: '127.0.0.1', port, autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN, ...webui }
          : {},
    })),
  );
  await app.plugins.idle();
  // 慢激活阈值调低时，忙的机器上基础插件也会超过阈值转入后台，idle 不等它们：逐个等到已激活
  for (const definition of definitions) {
    await vi.waitFor(
      () => expect(app.plugins.getPlugin(definition.name)?.state, `${definition.name} 未激活`).toBe('active'),
      { timeout: 10_000 },
    );
  }
  return { app, port };
}

/**
 * 开一个新的浏览器上下文（各用例的存储互不相通），按 token 登录后打开 origin 上的 path。页面里的未捕获异常、
 * CSP 拦下的加载与回 4xx、5xx 的请求都记进 problems，用例结束时应为空。回错误码的请求要等浏览器补齐响应的附加信息
 * 才记下，可能晚于页面里的请求结束：断言具体的错误请求时用 vi.waitFor 等它出现
 */
export async function openWebui(browser: Browser, origin: string, viewport: Viewport, cleanups: Cleanups, path = '/') {
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
  const response = (await page.goto(`${origin}${path}?token=${TOKEN}`)) as HTTPResponse;
  return { page, problems, response };
}

/** scope 里的一组行（「需要处理」与「开始使用」同一个样子）：标题、说明与行尾的操作 */
export const attentionRows = (page: Page, scope: string) =>
  page.$$eval(`${scope} .attention-row`, items =>
    items.map(row =>
      ['.attention-title', '.attention-detail', 'a, button'].map(part => row.querySelector(part)?.textContent),
    ),
  );

/** 等到写着 message 的 Toast 再关掉它：手机上 Toast 在顶部，会盖住下面的按钮 */
export async function toastSays(page: Page, message: string) {
  await page.waitForSelector(`.toast ${text(message)}`);
  await page.locator(`.toast ${aria('关闭', 'button')}`).click();
  await page.waitForSelector('.toast', { hidden: true });
}

/** 当前会话的 id：地址是 /s/:id */
export async function sessionIdOf(page: Page): Promise<string> {
  await page.waitForFunction(() => /^\/s\/[^/]+/.test(location.pathname));
  return decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
}

/** 按宽度走的几步操作：phone 为真时是手机（触屏、三层逐级进入） */
export function onViewport(phone: boolean) {
  return {
    /** 打开新会话的输入框：桌面上首页就是；手机上从第一层点「新会话」进第二层 */
    async newSession(page: Page) {
      if (phone) await page.locator(aria('新会话', 'button')).click();
      await page.waitForSelector(aria('消息', 'textbox'));
    },

    /**
     * 发一条消息：桌面上按回车发；触屏上回车只换行，按发送键发。先等上一轮收尾（输入框空着时出现的是发送键、
     * 不是停止键）：回合还在跑时发的新消息会让 agent 停掉那一轮
     */
    async send(page: Page, message: string) {
      await page.waitForSelector(aria('发送', 'button'));
      const box = await page.waitForSelector(aria('消息', 'textbox'));
      await box?.type(message);
      await page.keyboard.press('Enter');
      if (!phone) return;
      expect(await box?.evaluate(element => (element as HTMLTextAreaElement).value)).toBe(`${message}\n`);
      await page.locator(aria('发送', 'button')).click();
    },

    /** 进当前会话的会话面板：桌面上它就在右侧；手机上从会话头的「更多」进去 */
    async openPanel(page: Page) {
      if (!phone) return;
      await page.locator(`main ${aria('更多', 'button')}`).click();
      await page.locator(aria('会话面板', 'menuitem')).click();
    },

    /** 打开当前会话的「后台」标签：桌面点头部的「后台 N」，手机从带着点的「更多」里点 */
    async openBackground(page: Page, count: number) {
      const label = `后台 ${count}`;
      if (phone) {
        await page.locator(`main ${aria('更多', 'button')}[data-dot]`).click();
        await page.locator(aria(label, 'menuitem')).click();
      } else {
        await page.locator(`main ${aria(label, 'button')}`).click();
      }
    },
  };
}
