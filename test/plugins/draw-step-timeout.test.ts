import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawEngine } from '../../packages/plugin-draw/src/engine.js';
import { type DrawCaps, resolveCanvas } from '../../packages/plugin-draw/src/plan.js';

// ════════════════════════════════════════════════════════════
// 渲染步骤卡住时（真 Chromium）：
// - 截图卡住：约在步骤时限返回「渲染步骤超时」，这一代浏览器被关掉（不等关页面），下次渲染重新启动。此前底层截图
//   一直挂着、持有浏览器级的锁，收尾的 page.close() 要等它，要到 CDP 命令的时限（puppeteer 默认 180 秒）才返回。
// - 同一代里被锁挡住的在飞渲染随之失败，不等到那条截图命令的时限。
// - 没套步骤时限的 CDP 调用挂住时，以两倍步骤时限为上限。
// 卡死是真的：让渲染进程的主线程陷入死循环，截图等不到新帧（puppeteer 的 launch 与截图外包一层，引擎代码不动）。
// 不外发：测试启动的 Chrome 不走系统代理，除 127.0.0.1 外的主机一律映射到 127.0.0.1:1。
// ════════════════════════════════════════════════════════════

const probe = vi.hoisted(() => ({
  browsers: [] as Array<{ connected: boolean }>,
  /** 为真时，下一次截图前先让渲染进程卡死（只作用一次） */
  hangNextScreenshot: false,
  /** 卡死的那次截图开始的时刻 */
  hungAt: 0,
}));

vi.mock('../../packages/plugin-draw/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', async importOriginal => {
  // 根目录不直接依赖 puppeteer：只声明用到的部分，不经类型导入引用它
  type Page = {
    evaluate(expr: string): Promise<unknown>;
    screenshot(opts: unknown): Promise<Uint8Array>;
    close(): Promise<void>;
  };
  type Browser = { connected: boolean; newPage(): Promise<Page> };
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
    browser.newPage = async () => {
      const page = await newPage();
      const screenshot = page.screenshot.bind(page);
      page.screenshot = async opts => {
        if (probe.hangNextScreenshot) {
          probe.hangNextScreenshot = false;
          probe.hungAt = Date.now();
          // 卡住的页面也关不掉：真实的 page.close() 要等截图锁，这里让它永不落定
          page.close = () => new Promise<void>(() => {});
          page.evaluate('for(;;){}').catch(() => {});
          await new Promise(r => setTimeout(r, 300));
        }
        return screenshot(opts);
      };
      return page;
    };
    return browser;
  };
  return { ...actual, default: { ...actual.default, launch }, launch };
});

const STEP_MS = 1500;
const caps: DrawCaps = { defaultWidth: 800, maxWidth: 1600, maxPixels: 4_000_000, maxSourceBytes: 262144, scale: 1 };
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, child: () => logger } as never;
const plan = resolveCanvas('<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#333"/></svg>', 40, caps);

let engine: DrawEngine;

function makeEngine(): DrawEngine {
  engine = new DrawEngine(logger, { headless: true, idleShutdownMs: 0, stepTimeoutMs: STEP_MS, maxConcurrency: 2 });
  return engine;
}

afterEach(async () => {
  probe.hangNextScreenshot = false;
  probe.hungAt = 0;
  probe.browsers.length = 0;
  await engine?.dispose();
});

describe('渲染步骤卡住（真浏览器）', () => {
  it('截图卡住：约在步骤时限返回超时，这一代浏览器被关掉，下次渲染重新启动', async () => {
    makeEngine();
    await engine.renderPng(plan, 1, caps.maxPixels); // 先把浏览器起好，计时不含冷启动
    expect(probe.browsers).toHaveLength(1);

    probe.hangNextScreenshot = true;
    const error = await engine.renderPng(plan, 1, caps.maxPixels).then(
      () => null,
      (err: Error) => err,
    );
    const elapsed = Date.now() - probe.hungAt;
    expect(error?.message).toBe('渲染步骤超时（screenshot）');
    expect(elapsed).toBeGreaterThanOrEqual(STEP_MS - 50);
    // 不关浏览器时要等截图命令到 CDP 时限（两倍步骤时限）失败、锁释放，收尾的 page.close() 才落定
    expect(elapsed).toBeLessThan(STEP_MS + 1000);
    await vi.waitFor(() => expect(probe.browsers[0].connected).toBe(false));

    const r = await engine.renderPng(plan, 1, caps.maxPixels);
    expect(r.width).toBe(40);
    expect(probe.browsers).toHaveLength(2);
  }, 60_000);

  it('同一代里被截图锁挡住的在飞渲染随之失败，不等到那条截图命令的时限', async () => {
    makeEngine();
    await engine.renderPng(plan, 1, caps.maxPixels);

    probe.hangNextScreenshot = true;
    const hung = engine.renderPng(plan, 1, caps.maxPixels).then(
      () => null,
      (err: Error) => err,
    );
    await vi.waitFor(() => expect(probe.hungAt).toBeGreaterThan(0));
    await new Promise(r => setTimeout(r, 500));
    // 截图挂着时，同一浏览器里开新页要等截图锁
    const blocked = engine.renderPng(plan, 1, caps.maxPixels).then(
      () => null,
      (err: Error) => err,
    );

    expect((await hung)?.message).toBe('渲染步骤超时（screenshot）');
    const hungDone = Date.now();
    const blockedError = await blocked;
    expect(blockedError).toBeInstanceOf(Error);
    expect(blockedError?.message).not.toContain('渲染步骤超时');
    expect(Date.now() - hungDone).toBeLessThan(1000);
  }, 60_000);

  it('没套步骤时限的 CDP 调用挂住时，以两倍步骤时限为上限', async () => {
    makeEngine();
    let elapsed = 0;
    const error = await engine
      .withPage(plan, 40, async page => {
        const started = Date.now();
        try {
          await page.evaluate('new Promise(() => {})');
        } finally {
          elapsed = Date.now() - started;
        }
      })
      .then(
        () => null,
        (err: Error) => err,
      );
    expect(error?.message).toContain('timed out');
    expect(elapsed).toBeGreaterThanOrEqual(2 * STEP_MS - 50);
    expect(elapsed).toBeLessThan(2 * STEP_MS + 1500);
  }, 60_000);
});
