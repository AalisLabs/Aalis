import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';

// ════════════════════════════════════════════════════════════
// 页面卡住时的时限（真 Chromium + 本机 http 服务）：
// - browser_screenshot 按 defaultTimeout 返回超时错误，关掉这一代浏览器（页面表一起清），下次调用重新启动。
//   此前截图没有自己的时限，底层截图一直挂着、持有浏览器级的锁，要到 CDP 命令的时限（puppeteer 默认 180 秒）才返回，
//   其间同一浏览器里开新页、关页面、别的截图都排在它后面。
// - 其它操作挂住时，以两倍 defaultTimeout 为上限。
// 卡死是真的：让页面渲染进程的主线程陷入死循环，截图等不到新帧（puppeteer 的 launch 与截图外包一层，插件代码不动）。
// 不外发：测试启动的 Chrome 不走系统代理，除 127.0.0.1 外的主机一律映射到 127.0.0.1:1。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

const probe = vi.hoisted(() => ({
  browsers: [] as Array<{ connected: boolean }>,
  pages: [] as Array<{ evaluate(expr: string): Promise<unknown> }>,
  /** 为真时，下一次截图前先让渲染进程卡死（只作用一次） */
  hangNextScreenshot: false,
}));

vi.mock(
  '../../packages/plugin-tool-browser/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
  async importOriginal => {
    // 根目录不直接依赖 puppeteer：只声明用到的部分，不经类型导入引用它
    type Page = { evaluate(expr: string): Promise<unknown>; screenshot(opts: unknown): Promise<Uint8Array> };
    type Browser = { connected: boolean; newPage(opts?: unknown): Promise<Page> };
    type Launch = (options?: { args?: string[] } & Record<string, unknown>) => Promise<Browser>;
    const actual = await importOriginal<{ launch: Launch; default: Record<string, unknown> }>();
    const launch: Launch = async options => {
      const browser = await actual.launch({
        ...options,
        args: [
          ...(options?.args ?? []),
          '--no-proxy-server',
          '--host-resolver-rules=MAP * 127.0.0.1:1, EXCLUDE 127.0.0.1',
        ],
      });
      probe.browsers.push(browser);
      const newPage = browser.newPage.bind(browser);
      browser.newPage = async opts => {
        const page = await newPage(opts);
        probe.pages.push(page);
        const screenshot = page.screenshot.bind(page);
        page.screenshot = async shotOpts => {
          if (probe.hangNextScreenshot) {
            probe.hangNextScreenshot = false;
            page.evaluate('for(;;){}').catch(() => {});
            await new Promise(r => setTimeout(r, 300));
          }
          return screenshot(shotOpts);
        };
        return page;
      };
      return browser;
    };
    return { ...actual, default: { ...actual.default, launch }, launch };
  },
);

const TIMEOUT_MS = 2000;

type Call = (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

let server: Server;
let origin: string;
let app: App;
let call: Call;

/** 起一份浏览器工具，返回按名调用工具、解析文本结果的函数（未接 storage：截图不落盘，随 images 交出） */
async function startBrowserTools(defaultTimeout: number): Promise<{ app: App; call: Call }> {
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide });
  const handlers: Record<string, Handler> = {};
  host.provide(tools, {
    register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(webuiServer, { registerPage: () => () => {}, registerAction: () => () => {} } as never);
  // blockPrivate:false 才连得上本机测试服务（同时不起网络闸）
  await app.plugins.register(browserPlugin, { headless: true, blockPrivate: false, defaultTimeout });
  await app.plugins.idle();
  return {
    app,
    call: async (tool, args) => {
      const out = await handlers[tool](args, { sessionId: 's', acceptsImages: true });
      return JSON.parse(typeof out === 'string' ? out : out.content);
    },
  };
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<title>zz-page</title><body style="background:#3b82f6">hello</body>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ({ app, call } = await startBrowserTools(TIMEOUT_MS));
}, 60_000);

afterAll(async () => {
  await app.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
}, 30_000);

async function openPage(callTool: Call = call): Promise<string> {
  const out = await callTool('browser_navigate', { url: `${origin}/` });
  if (out.error) throw new Error(`打开页面失败: ${out.error}`);
  return out.pageId as string;
}

describe('页面卡住时的时限', () => {
  it('截图卡住：按 defaultTimeout 返回超时，这一代浏览器被关掉、页面表清空，下次调用重新启动', async () => {
    const pageId = await openPage();
    expect(probe.browsers).toHaveLength(1);

    probe.hangNextScreenshot = true;
    const started = Date.now();
    const out = await call('browser_screenshot', { pageId });
    const elapsed = Date.now() - started;
    expect(out.error).toBe(
      `截图超过 ${TIMEOUT_MS}ms 未完成，已关闭浏览器，全部页面随之关闭；下次调用时重新启动，需重新 browser_navigate 打开页面`,
    );
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 1000);
    await vi.waitFor(() => expect(probe.browsers[0].connected).toBe(false));
    expect(await call('browser_get_text', { pageId })).toEqual({ error: '页面不存在' });

    const fresh = await openPage();
    expect(probe.browsers).toHaveLength(2);
    expect(await call('browser_screenshot', { pageId: fresh })).toMatchObject({ ok: true });
  }, 60_000);

  it('其它操作挂住时，以两倍 defaultTimeout 为上限', async () => {
    const pageId = await openPage();
    probe.pages
      .at(-1)
      ?.evaluate('for(;;){}')
      .catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const started = Date.now();
    const out = await call('browser_get_text', { pageId });
    const elapsed = Date.now() - started;
    expect(out.error).toContain('timed out');
    expect(elapsed).toBeGreaterThanOrEqual(2 * TIMEOUT_MS - 400);
    expect(elapsed).toBeLessThan(2 * TIMEOUT_MS + 1500);
  }, 60_000);

  it('defaultTimeout 为 0 时截图不设时限（与 puppeteer 对 0 的约定一致），照常完成', async () => {
    const unlimited = await startBrowserTools(0);
    try {
      const pageId = await openPage(unlimited.call);
      expect(await unlimited.call('browser_screenshot', { pageId })).toMatchObject({ ok: true });
    } finally {
      await unlimited.app.stop();
    }
  }, 60_000);
});
