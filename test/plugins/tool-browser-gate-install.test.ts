import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';

// ════════════════════════════════════════════════════════════
// 浏览器级请求闸装不上时（取 CDP 会话或 Fetch.enable 失败），这一代浏览器不能交出去：
// 先关掉、再报闸的错误；下次调用重新启动，而不是拿着一个没有闸的实例继续开页面。
// 「请确保已安装 Chrome」的提示只跟在浏览器本身启动失败后面，闸的错误与 Chrome 装没装无关。
// puppeteer 换成替身（根目录不直接依赖 puppeteer，按插件自己的依赖路径 mock），不启动真浏览器。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

const fake = vi.hoisted(() => {
  const newPage = vi.fn();
  const close = vi.fn(async () => {});
  const launch = vi.fn(async () => ({
    connected: true,
    on: () => {},
    close,
    newPage,
    target: () => ({
      createCDPSession: async () => ({
        on: () => {},
        send: async (method: string) => {
          if (method === 'Fetch.enable') throw new Error('zz-Fetch.enable 失败');
        },
      }),
    }),
  }));
  return { launch, close, newPage };
});
vi.mock('../../packages/plugin-tool-browser/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', () => ({
  default: { launch: fake.launch },
  launch: fake.launch,
}));

let app: App;
const handlers: Record<string, Handler> = {};

beforeAll(async () => {
  app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide });
  host.provide(tools, {
    register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(webuiServer, { registerPage: () => () => {}, registerAction: () => () => {} } as never);
  // executablePath 非空：跳过「Chrome 未安装就自动下载」那一步
  await app.plugins.register(browserPlugin, { blockPrivate: true, executablePath: '/zz-fake-chrome' });
  await app.plugins.idle();
});

afterAll(async () => {
  await app.stop();
});

async function navigate(): Promise<{ error?: string }> {
  return JSON.parse(
    (await handlers.browser_navigate({ url: 'http://example.zz-test/' }, { sessionId: 's' })) as string,
  );
}

describe('请求闸装不上', () => {
  it('关掉这一代浏览器并报闸的错误，不附安装 Chrome 的提示，不开页面；下次调用重新启动', async () => {
    const first = await navigate();
    expect(first.error).toContain('zz-Fetch.enable 失败');
    expect(first.error).not.toContain('请确保已安装 Chrome');
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.newPage).not.toHaveBeenCalled();

    const second = await navigate();
    expect(second.error).toContain('zz-Fetch.enable 失败');
    expect(fake.launch).toHaveBeenCalledTimes(2);
    expect(fake.newPage).not.toHaveBeenCalled();
  });
});

describe('浏览器本身启动失败', () => {
  it('报启动失败并附安装 Chrome 的提示', async () => {
    fake.launch.mockRejectedValueOnce(new Error('zz-launch 失败'));
    const out = await navigate();
    expect(out.error).toContain('zz-launch 失败');
    expect(out.error).toContain('请确保已安装 Chrome');
  });
});
