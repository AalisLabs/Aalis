import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 是否带 Chromium 沙箱由配置 sandbox 决定：
// - 不配（默认 false）：带 --no-sandbox --disable-setuid-sandbox 启动。
// - 配 true：不带这两项启动；无法启动就报启动失败，报错写明可以在配置里关掉沙箱，不加 --no-sandbox 再启动，
//   下次调用照样带沙箱启动（不记住失败）。
// puppeteer 换成替身（按插件自己的依赖路径 mock），不启动真浏览器；不起网络闸（blockPrivate=false）。
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
  return { launch };
});
vi.mock('../../packages/plugin-tool-browser/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', () => ({
  default: { launch: fake.launch },
  launch: fake.launch,
}));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  fake.launch.mockClear();
});

async function navigate(config: Record<string, unknown> = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
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

  it('不配时启动失败：报错不提沙箱', async () => {
    const call = await navigate();
    fake.launch.mockRejectedValueOnce(new Error('zz-launch 失败'));
    const failed = await call();
    expect(failed.error).toContain('浏览器启动失败: zz-launch 失败');
    expect(failed.error).not.toContain('沙箱');
  });
});
