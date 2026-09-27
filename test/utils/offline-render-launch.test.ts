import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OfflineRenderer,
  type RenderRequest,
  RenderUnavailableError,
} from '../../packages/util-offline-render/src/index.js';

// ════════════════════════════════════════════════════════════
// 启动与沙箱策略（真 Chromium）：
// - 起浏览器不带 --no-sandbox；关掉 puppeteer 的 SIGINT/SIGTERM/SIGHUP 处理（它默认在 SIGINT 时先杀浏览器、
//   再 process.exit(130)，截断宿主的优雅停机），浏览器由调用方的生命周期关。
// - required：带沙箱起不来就抛 RenderUnavailableError，从不带 --no-sandbox 启动。
// - preferred：带沙箱起不来时加 --no-sandbox 再起一次，同一实例只记一次 warn。
// 「沙箱起不来」由外包的 launch 模拟：参数里没有 --no-sandbox 就抛错。
// ════════════════════════════════════════════════════════════

const probe = vi.hoisted(() => ({
  /** 为真时，参数里没有 --no-sandbox 的启动一律失败 */
  failSandboxed: false,
  launches: [] as Array<{ args: string[]; options: Record<string, unknown> }>,
}));

vi.mock(
  '../../packages/util-offline-render/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js',
  async importOriginal => {
    type Launch = (options?: { args?: string[] } & Record<string, unknown>) => Promise<unknown>;
    const actual = await importOriginal<{ launch: Launch; default: Record<string, unknown> }>();
    const launch: Launch = async (options = {}) => {
      const args = options.args ?? [];
      probe.launches.push({ args: [...args], options: { ...options } });
      if (probe.failSandboxed && !args.includes('--no-sandbox')) {
        throw new Error('Failed to launch the browser process! No usable sandbox!（模拟）');
      }
      // 测试保底：被测代码没给代理（变异时）就直连，不走本机的系统代理
      return actual.launch({
        ...options,
        args: args.some(a => a.startsWith('--proxy-server=')) ? args : [...args, '--no-proxy-server'],
      });
    };
    return { ...actual, default: { ...actual.default, launch }, launch };
  },
);

const ENTRY = 'https://render.invalid/';
const req: RenderRequest = {
  entry: ENTRY,
  resources: new Map([
    [ENTRY, { body: new TextEncoder().encode('<p>hello</p>'), contentType: 'text/html; charset=utf-8' }],
  ]),
  viewport: { width: 64, height: 32 },
  clip: { kind: 'viewport' },
};

function makeRenderer(sandbox: 'required' | 'preferred', idleShutdownSec = 0) {
  const warn = vi.fn();
  const renderer = new OfflineRenderer({
    sandbox,
    idleShutdownSec,
    logger: { debug: () => {}, info: () => {}, warn },
  });
  renderers.push(renderer);
  return { renderer, warn };
}

const renderers: OfflineRenderer[] = [];

afterEach(async () => {
  for (const r of renderers.splice(0)) await r.dispose();
  probe.failSandboxed = false;
  probe.launches.length = 0;
});

describe('启动参数（真浏览器）', () => {
  it('不带 --no-sandbox 启动；SIGINT/SIGTERM/SIGHUP 不交给 puppeteer 处理', async () => {
    const { renderer } = makeRenderer('preferred');
    await renderer.renderPng(req);
    expect(probe.launches).toHaveLength(1);
    const { args, options } = probe.launches[0];
    expect(args).not.toContain('--no-sandbox');
    expect(args).not.toContain('--disable-setuid-sandbox');
    expect(options.handleSIGINT).toBe(false);
    expect(options.handleSIGTERM).toBe(false);
    expect(options.handleSIGHUP).toBe(false);
  }, 30_000);
});

describe('沙箱策略', () => {
  it('required：带沙箱起不来就抛 RenderUnavailableError，从不带 --no-sandbox 启动', async () => {
    probe.failSandboxed = true;
    const { renderer, warn } = makeRenderer('required');
    await expect(renderer.renderPng(req)).rejects.toBeInstanceOf(RenderUnavailableError);
    await expect(renderer.renderPng(req)).rejects.toBeInstanceOf(RenderUnavailableError);
    expect(probe.launches.length).toBeGreaterThanOrEqual(2);
    for (const l of probe.launches) expect(l.args).not.toContain('--no-sandbox');
    expect(warn).not.toHaveBeenCalled();
  });

  it('preferred：带沙箱起不来就加 --no-sandbox 再起，渲染成功；换代再起时不再重复告警', async () => {
    probe.failSandboxed = true;
    // 空闲 0.2 秒即关停，下一次渲染起新一代
    const { renderer, warn } = makeRenderer('preferred', 0.2);
    await renderer.renderPng(req);
    expect(probe.launches.map(l => l.args.includes('--no-sandbox'))).toEqual([false, true]);
    expect(probe.launches[1].args).toContain('--disable-setuid-sandbox');
    await new Promise(r => setTimeout(r, 600));
    await renderer.renderPng(req);
    expect(probe.launches.filter(l => l.args.includes('--no-sandbox')).length).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('preferred：不带沙箱也起不来时抛 RenderUnavailableError', async () => {
    const broken = new OfflineRenderer({
      sandbox: 'preferred',
      executablePath: '/nonexistent/works-chrome',
      idleShutdownSec: 0,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    renderers.push(broken);
    await expect(broken.renderPng(req)).rejects.toBeInstanceOf(RenderUnavailableError);
    expect(probe.launches.map(l => l.args.includes('--no-sandbox'))).toEqual([false, true]);
  });
});

describe('required 真实启动（真浏览器）', () => {
  // 本机不套外层沙箱时是渲染成功；套在外层 Seatbelt 里（如 agent 的沙箱 shell）时带沙箱启动不是立刻失败，
  // 而是等到 puppeteer 的启动时限（30 秒）后抛 RenderUnavailableError，所以用例时限放到 60 秒
  it('渲染成功或抛 RenderUnavailableError，二者之一，并写明是哪一种', async () => {
    const { renderer } = makeRenderer('required');
    const result = await renderer.renderPng(req).then(
      png => ({ ok: true as const, png }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    if (result.ok) {
      console.info('[offline-render] required 真实启动：渲染成功（本环境 Chrome 沙箱可用）');
      expect(Buffer.from(result.png).subarray(1, 4).toString('ascii')).toBe('PNG');
    } else {
      console.info(`[offline-render] required 真实启动：抛 RenderUnavailableError（${String(result.err)}）`);
      expect(result.err).toBeInstanceOf(RenderUnavailableError);
    }
  }, 60_000);
});
