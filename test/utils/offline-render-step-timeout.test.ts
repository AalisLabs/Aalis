import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineRenderer, type RenderRequest, StepTimeoutError } from '../../packages/util-offline-render/src/index.js';

// ════════════════════════════════════════════════════════════
// 渲染步骤卡住时（真 Chromium）：
// - 截图卡住：约在步骤时限抛 StepTimeoutError，这一代浏览器被关掉（不等关上下文），下次渲染重新启动。不关浏览器时，
//   底层截图一直挂着、持有浏览器级的锁，收尾的关上下文要等它，要到 CDP 命令的时限才返回。
// - 同一代里被锁挡住的在飞渲染随之失败，不等到那条截图命令的时限。
// - 没套步骤时限的 CDP 调用（动画的时长探测）挂住时，以两倍步骤时限为上限。
// - 取消：signal 一断，渲染立刻以取消原因失败；挂住的那一代照样由步骤时限换掉，之后的渲染照常。
// 卡死是真的：让渲染进程的主线程陷入死循环，截图等不到新帧（puppeteer 的 launch、上下文与截图外包一层，被测代码不动）。
// ════════════════════════════════════════════════════════════

const probe = vi.hoisted(() => ({
  browsers: [] as Array<{ connected: boolean }>,
  /** 为真时，下一次截图前先让渲染进程卡死（只作用一次） */
  hangNextScreenshot: false,
  /** 卡死的那次截图开始的时刻 */
  hungAt: 0,
  /** 为真时，动画的时长探测换成一个永不落定的求值（只作用一次） */
  hangNextProbe: false,
}));

vi.mock(
  '../../packages/util-offline-render/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
  async importOriginal => {
    // 根目录不直接依赖 puppeteer：只声明用到的部分，不经类型导入引用它
    type Page = {
      evaluate(expr: unknown, ...args: unknown[]): Promise<unknown>;
      screenshot(opts: unknown): Promise<Uint8Array>;
    };
    type Context = { newPage(): Promise<Page>; close(): Promise<void> };
    type Browser = { connected: boolean; createBrowserContext(...a: unknown[]): Promise<Context> };
    type Launch = (options?: { args?: string[] } & Record<string, unknown>) => Promise<Browser>;
    const actual = await importOriginal<{ launch: Launch; default: Record<string, unknown> }>();
    const launch: Launch = async options => {
      const args = options?.args ?? [];
      const browser = await actual.launch({
        ...options,
        // 测试保底：被测代码没给代理（变异时）就直连，不走本机的系统代理
        args: args.some(a => a.startsWith('--proxy-server=')) ? args : [...args, '--no-proxy-server'],
      });
      probe.browsers.push(browser);
      const createBrowserContext = browser.createBrowserContext.bind(browser);
      browser.createBrowserContext = async (...a: unknown[]) => {
        const context = await createBrowserContext(...a);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          const screenshot = page.screenshot.bind(page);
          const evaluate = page.evaluate.bind(page);
          page.screenshot = async opts => {
            if (probe.hangNextScreenshot) {
              probe.hangNextScreenshot = false;
              probe.hungAt = Date.now();
              // 卡住的上下文也关不掉：真实的关闭要等截图锁，这里让它永不落定
              context.close = () => new Promise<void>(() => {});
              evaluate('for(;;){}').catch(() => {});
              await new Promise(r => setTimeout(r, 300));
            }
            return screenshot(opts);
          };
          page.evaluate = (expr: unknown, ...rest: unknown[]) => {
            if (probe.hangNextProbe && typeof expr === 'string' && expr.includes('pauseAnimations')) {
              probe.hangNextProbe = false;
              return evaluate('new Promise(() => {})');
            }
            return evaluate(expr, ...rest);
          };
          return page;
        };
        return context;
      };
      return browser;
    };
    return { ...actual, default: { ...actual.default, launch }, launch };
  },
);

const STEP_MS = 1500;
const ENTRY = 'https://render.invalid/';
const req: RenderRequest = {
  entry: ENTRY,
  resources: new Map([
    [
      ENTRY,
      {
        body: new TextEncoder().encode(
          '<body style="margin:0"><div style="width:40px;height:40px;background:#333"></div>',
        ),
        contentType: 'text/html; charset=utf-8',
      },
    ],
  ]),
  viewport: { width: 40, height: 40 },
  clip: { kind: 'viewport' },
};
const logger = { debug: () => {}, info: () => {}, warn: () => {} };

let renderer: OfflineRenderer | undefined;

function makeRenderer(): OfflineRenderer {
  renderer = new OfflineRenderer({
    sandbox: 'preferred',
    idleShutdownSec: 0,
    stepTimeoutMs: STEP_MS,
    maxConcurrency: 2,
    logger,
  });
  return renderer;
}

afterEach(async () => {
  probe.hangNextScreenshot = false;
  probe.hangNextProbe = false;
  probe.hungAt = 0;
  probe.browsers.length = 0;
  await renderer?.dispose();
  renderer = undefined;
});

describe('渲染步骤卡住（真浏览器）', () => {
  it('截图卡住：约在步骤时限抛 StepTimeoutError，这一代浏览器被关掉，下次渲染起新一代', async () => {
    const r = makeRenderer();
    await r.renderPng(req); // 先把浏览器起好，计时不含冷启动
    expect(probe.browsers).toHaveLength(1);

    probe.hangNextScreenshot = true;
    const error = await r.renderPng(req).then(
      () => null,
      (err: Error) => err,
    );
    const elapsed = Date.now() - probe.hungAt;
    expect(error).toBeInstanceOf(StepTimeoutError);
    expect(error?.message).toBe('渲染步骤超时（screenshot）');
    expect(elapsed).toBeGreaterThanOrEqual(STEP_MS - 50);
    // 不关浏览器时要等截图命令到 CDP 时限（两倍步骤时限）失败、锁释放，收尾的关上下文才落定
    expect(elapsed).toBeLessThan(STEP_MS + 1000);
    await vi.waitFor(() => expect(probe.browsers[0].connected).toBe(false));

    await r.renderPng(req);
    expect(probe.browsers).toHaveLength(2);
  }, 60_000);

  it('同一代里被截图锁挡住的在飞渲染随之失败，不等到那条截图命令的时限', async () => {
    const r = makeRenderer();
    await r.renderPng(req);

    probe.hangNextScreenshot = true;
    const hung = r.renderPng(req).then(
      () => null,
      (err: Error) => err,
    );
    await vi.waitFor(() => expect(probe.hungAt).toBeGreaterThan(0));
    await new Promise(res => setTimeout(res, 500));
    // 截图挂着时，同一浏览器里的另一次渲染要等截图锁
    const blocked = r.renderPng(req).then(
      () => null,
      (err: Error) => err,
    );

    expect((await hung)?.message).toBe('渲染步骤超时（screenshot）');
    const hungDone = Date.now();
    const blockedError = await blocked;
    expect(blockedError).toBeInstanceOf(Error);
    expect(blockedError).not.toBeInstanceOf(StepTimeoutError);
    expect(Date.now() - hungDone).toBeLessThan(1000);
  }, 60_000);

  it('没套步骤时限的 CDP 调用挂住时，以两倍步骤时限为上限', async () => {
    const r = makeRenderer();
    probe.hangNextProbe = true;
    const started = Date.now();
    const error = await r.renderFrames(req, { fps: 2, maxFrames: 4, maxDurationMs: 1000 }).then(
      () => null,
      (err: Error) => err,
    );
    const elapsed = Date.now() - started;
    expect(error?.message).toContain('timed out');
    expect(elapsed).toBeGreaterThanOrEqual(2 * STEP_MS - 50);
    // 含冷启动
    expect(elapsed).toBeLessThan(2 * STEP_MS + 5000);
  }, 60_000);
});

describe('取消', () => {
  it('signal 已断：立刻以取消原因失败，不起浏览器', async () => {
    const r = makeRenderer();
    const controller = new AbortController();
    controller.abort(new Error('works-取消'));
    await expect(r.renderPng({ ...req, signal: controller.signal })).rejects.toThrow('works-取消');
    expect(probe.browsers).toHaveLength(0);
  });

  it('截图卡住时断 signal：渲染立刻失败；挂住的那一代由步骤时限换掉，之后的渲染照常', async () => {
    const r = makeRenderer();
    await r.renderPng(req);

    probe.hangNextScreenshot = true;
    const controller = new AbortController();
    const pending = r.renderPng({ ...req, signal: controller.signal }).then(
      () => null,
      (err: Error) => err,
    );
    await vi.waitFor(() => expect(probe.hungAt).toBeGreaterThan(0));
    const abortedAt = Date.now();
    controller.abort(new Error('works-取消'));
    expect((await pending)?.message).toBe('works-取消');
    expect(Date.now() - abortedAt).toBeLessThan(300);

    await vi.waitFor(() => expect(probe.browsers[0].connected).toBe(false), { timeout: 2 * STEP_MS });
    await r.renderPng(req);
    expect(probe.browsers).toHaveLength(2);
  }, 60_000);
});
