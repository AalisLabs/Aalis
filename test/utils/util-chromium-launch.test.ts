import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineRenderer, type RenderRequest, RenderUnavailableError } from '../../packages/util-chromium/src/index.js';

// ════════════════════════════════════════════════════════════
// 启动与沙箱（真 Chromium）：
// - 关掉 puppeteer 的 SIGINT/SIGTERM/SIGHUP 处理（它默认在 SIGINT 时先杀浏览器、再 process.exit(130)，截断宿主的
//   优雅停机），浏览器由调用方的生命周期关。
// - sandbox 为假：带 --no-sandbox --disable-setuid-sandbox 启动。
// - sandbox 为真：不带这两项启动，启动失败就抛 RenderUnavailableError，不加 --no-sandbox 再启动，下次渲染照样带沙箱启动。
// - 宿主这一侧的连接一断，浏览器随之退出：宿主不经停机退出（崩溃、被 SIGKILL、未捕获异常）时系统关掉宿主持有的
//   全部句柄，浏览器不能整组留下（崩溃与 SIGKILL 时 exit 钩子也不跑）。用例照此关掉与浏览器的连接和子进程的全部管道来模拟。
// 「沙箱起不来」由外包的 launch 模拟：参数里没有 --no-sandbox 就抛错。
// ════════════════════════════════════════════════════════════

const probe = vi.hoisted(() => ({
  /** 为真时，参数里没有 --no-sandbox 的启动一律失败 */
  failSandboxed: false,
  launches: [] as Array<{ args: string[]; options: Record<string, unknown> }>,
  /** 每次启动的浏览器 */
  browsers: [] as Array<{ process(): ChildProcess | null; disconnect(): Promise<void> }>,
}));

vi.mock('../../packages/util-chromium/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', async importOriginal => {
  type Launch = (options?: { args?: string[] } & Record<string, unknown>) => Promise<unknown>;
  const actual = await importOriginal<{ launch: Launch; default: Record<string, unknown> }>();
  const launch: Launch = async (options = {}) => {
    const args = options.args ?? [];
    probe.launches.push({ args: [...args], options: { ...options } });
    if (probe.failSandboxed && !args.includes('--no-sandbox')) {
      throw new Error('Failed to launch the browser process! No usable sandbox!（模拟）');
    }
    // 测试保底：被测代码没给代理（变异时）就直连，不走本机的系统代理
    const browser = await actual.launch({
      ...options,
      args: args.some(a => a.startsWith('--proxy-server=')) ? args : [...args, '--no-proxy-server'],
    });
    probe.browsers.push(browser as (typeof probe.browsers)[number]);
    return browser;
  };
  return { ...actual, default: { ...actual.default, launch }, launch };
});

const ENTRY = 'https://render.invalid/';
const req: RenderRequest = {
  entry: ENTRY,
  resources: new Map([
    [ENTRY, { body: new TextEncoder().encode('<p>hello</p>'), contentType: 'text/html; charset=utf-8' }],
  ]),
  viewport: { width: 64, height: 32 },
  clip: { kind: 'viewport' },
};

function makeRenderer(sandbox: boolean) {
  const warn = vi.fn();
  const renderer = new OfflineRenderer({
    sandbox,
    idleShutdownSec: 0,
    logger: { debug: () => {}, info: () => {}, warn },
  });
  renderers.push(renderer);
  return { renderer, warn };
}

const renderers: OfflineRenderer[] = [];

afterEach(async () => {
  for (const r of renderers.splice(0)) await r.dispose();
  // 宿主一侧关掉后没退出的浏览器由这里收掉（主进程一退，辅助进程随之退出）
  for (const b of probe.browsers.splice(0)) {
    const chrome = b.process();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  }
  probe.failSandboxed = false;
  probe.launches.length = 0;
});

describe('启动参数（真浏览器）', () => {
  it('sandbox 为假时带 --no-sandbox --disable-setuid-sandbox 启动；SIGINT/SIGTERM/SIGHUP 不交给 puppeteer 处理；启动的是 Chrome', async () => {
    const { renderer } = makeRenderer(false);
    await renderer.renderPng(req);
    expect(probe.launches).toHaveLength(1);
    const { args, options } = probe.launches[0];
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--disable-setuid-sandbox');
    expect(options.handleSIGINT).toBe(false);
    expect(options.handleSIGTERM).toBe(false);
    expect(options.handleSIGHUP).toBe(false);
    // 不随 puppeteer 配置里的默认浏览器（PUPPETEER_BROWSER、.puppeteerrc）：启动 Firefox 时调用方给的 Chromium 参数它不认
    expect(options.browser).toBe('chrome');
  }, 30_000);
});

describe('宿主不经停机退出（真浏览器）', () => {
  it('宿主持有的连接与管道全部关掉，浏览器随之退出', async () => {
    const { renderer } = makeRenderer(false);
    await renderer.renderPng(req);
    const chrome = probe.browsers[0].process();
    if (!chrome) throw new Error('取不到浏览器进程');
    const exited = once(chrome, 'exit').then(() => 'exited');
    await probe.browsers[0].disconnect();
    for (const stream of chrome.stdio) stream?.destroy();
    const stillRunning = new Promise(r => setTimeout(r, 10_000)).then(() => 'still running');
    expect(await Promise.race([exited, stillRunning])).toBe('exited');
  }, 30_000);
});

describe('沙箱', () => {
  it('sandbox 为真：启动失败就抛 RenderUnavailableError，不加 --no-sandbox 再启动；下次渲染照样带沙箱启动', async () => {
    probe.failSandboxed = true;
    const { renderer, warn } = makeRenderer(true);
    await expect(renderer.renderPng(req)).rejects.toThrow(
      new RenderUnavailableError(
        '离线渲染不可用：Chromium 带沙箱启动失败（Failed to launch the browser process! No usable sandbox!（模拟））',
      ),
    );
    await expect(renderer.renderPng(req)).rejects.toBeInstanceOf(RenderUnavailableError);
    expect(
      probe.launches.map(l => [l.args.includes('--no-sandbox'), l.args.includes('--disable-setuid-sandbox')]),
    ).toEqual([
      [false, false],
      [false, false],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('sandbox 为假也启动失败时抛 RenderUnavailableError，只启动一次', async () => {
    const broken = new OfflineRenderer({
      sandbox: false,
      executablePath: '/nonexistent/works-chrome',
      idleShutdownSec: 0,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    renderers.push(broken);
    await expect(broken.renderPng(req)).rejects.toBeInstanceOf(RenderUnavailableError);
    expect(probe.launches.map(l => l.args.includes('--no-sandbox'))).toEqual([true]);
  });
});

describe('带沙箱真实启动（真浏览器）', () => {
  // 本机不套外层沙箱时是渲染成功；套在外层 Seatbelt 里（如 agent 的沙箱 shell）时带沙箱启动不是立刻失败，
  // 而是等到 puppeteer 的启动时限（30 秒）后抛 RenderUnavailableError，所以用例时限放到 60 秒
  it('渲染成功或抛 RenderUnavailableError，二者之一，并写明是哪一种', async () => {
    const { renderer } = makeRenderer(true);
    const result = await renderer.renderPng(req).then(
      png => ({ ok: true as const, png }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    if (result.ok) {
      console.info('[util-chromium] 带沙箱真实启动：渲染成功（本环境 Chrome 沙箱可用）');
      expect(Buffer.from(result.png).subarray(1, 4).toString('ascii')).toBe('PNG');
    } else {
      console.info(`[util-chromium] 带沙箱真实启动：抛 RenderUnavailableError（${String(result.err)}）`);
      expect(result.err).toBeInstanceOf(RenderUnavailableError);
    }
  }, 60_000);
});
