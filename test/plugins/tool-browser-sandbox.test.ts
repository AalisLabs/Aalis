import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 是否带 Chromium 沙箱由配置 sandbox 决定：
// - 不配（默认 false）：带 --no-sandbox --disable-setuid-sandbox 启动。
// - 配 true：不带这两项启动；无法启动就报启动失败，报错写明可以在配置里关掉沙箱，不加 --no-sandbox 再启动，
//   下次调用照样带沙箱启动（不记住失败）。
// puppeteer 换成替身（按 util-chromium 的依赖路径 mock），不启动真浏览器，缓存根是这个文件自己的临时目录；不启动网络闸（blockPrivate=false）。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

const fake = vi.hoisted(() => {
  const launch = vi.fn(async (_options: { args: string[] }) => {
    const page = {
      setDefaultTimeout: () => {},
      goto: async () => {},
      url: () => 'http://example.zz-test/',
      title: async () => 'zz',
      evaluate: async () => 'zz-body',
      close: async () => {},
    };
    return {
      connected: true,
      on: () => {},
      close: async () => {},
      createBrowserContext: async () => ({ newPage: async () => page }),
    };
  });
  /** puppeteer 的缓存根：下载之前先在里面建临时目录 */
  const cache = { dir: '' };
  return { launch, cache };
});
vi.mock('../../packages/util-chromium/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', () => ({
  // 自带的 Chrome 没装：不配 executablePath 时先走自动下载
  default: {
    launch: fake.launch,
    executablePath: () => '/zz-missing-chrome',
    defaultBrowser: 'chrome',
    get configuration() {
      return { cacheDirectory: fake.cache.dir };
    },
  },
  launch: fake.launch,
}));

beforeAll(async () => {
  fake.cache.dir = await mkdtemp(join(tmpdir(), 'zz-chrome-cache-'));
});
afterAll(async () => {
  await rm(fake.cache.dir, { recursive: true, force: true });
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  fake.launch.mockClear();
});

async function navigate(config: Record<string, unknown> = {}) {
  const app = new App({ logLevel: 'error' });
  provideEvents(app);
  apps.push(app);
  const host = app.bind({ provide });
  const handlers: Record<string, Handler> = {};
  host.provide.use(tools, {
    register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  // executablePath 非空：跳过「Chrome 未安装就自动下载」那一步
  await app.plugins.register(browserPlugin, { blockPrivate: false, executablePath: '/zz-fake-chrome', ...config });
  await app.plugins.idle();
  return async (): Promise<{ error?: string }> =>
    JSON.parse(
      (await handlers.browser_navigate({ url: 'http://example.zz-test/' }, toolContext({ sessionId: 's' }))) as string,
    );
}

/** 每次启动的参数里有没有 --no-sandbox 与 --disable-setuid-sandbox */
const noSandboxFlags = () =>
  fake.launch.mock.calls.map(([options]) => [
    options.args.includes('--no-sandbox'),
    options.args.includes('--disable-setuid-sandbox'),
  ]);

describe('Chromium 沙箱', () => {
  it('不配：带 --no-sandbox --disable-setuid-sandbox 启动', async () => {
    const call = await navigate();
    expect((await call()).error).toBeUndefined();
    expect(noSandboxFlags()).toEqual([[true, true]]);
  });

  it('配 true：不带这两项启动', async () => {
    const call = await navigate({ sandbox: true });
    expect((await call()).error).toBeUndefined();
    expect(noSandboxFlags()).toEqual([[false, false]]);
  });

  it('配 true 启动失败：报启动失败并写明可在配置里关掉沙箱，不回落；下次调用照样带沙箱启动', async () => {
    const call = await navigate({ sandbox: true });
    fake.launch.mockRejectedValueOnce(new Error('No usable sandbox!（模拟）'));
    const failed = await call();
    expect(failed.error).toContain('浏览器启动失败: No usable sandbox!（模拟）');
    expect(failed.error).toContain('可在浏览器工具的配置里关掉「Chromium 沙箱」（sandbox）');
    expect(noSandboxFlags()).toEqual([[false, false]]);

    expect((await call()).error).toBeUndefined();
    expect(noSandboxFlags()).toEqual([
      [false, false],
      [false, false],
    ]);
  });

  it('配 true、启动之前就失败（自带的 Chrome 没装、下载不成）：报错不提沙箱', async () => {
    const call = await navigate({ sandbox: true, executablePath: '' });
    const failed = await call();
    // 下载要经 process 服务跑命令行，这里没有提供
    expect(failed.error).toContain('浏览器启动失败: 服务 "process" 不可用');
    expect(failed.error).not.toContain('沙箱');
    expect(fake.launch).not.toHaveBeenCalled();
  });

  it('不配时启动失败：报错不提沙箱', async () => {
    const call = await navigate();
    fake.launch.mockRejectedValueOnce(new Error('zz-launch 失败'));
    const failed = await call();
    expect(failed.error).toContain('浏览器启动失败: zz-launch 失败');
    expect(failed.error).not.toContain('沙箱');
  });
});
