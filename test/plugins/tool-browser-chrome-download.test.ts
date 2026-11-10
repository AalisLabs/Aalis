import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 自带的 Chrome 没装、又没配 executablePath：启动浏览器之前经 process 服务跑 puppeteer 包里的命令行下载它。
// 跑的脚本就是 puppeteer 的 package.json 里 bin 指的那个文件。
// puppeteer 换成替身（按 util-chromium 的依赖路径 mock），不启动真浏览器；process 服务换成替身，不真下载。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

const fake = vi.hoisted(() => {
  const launch = vi.fn(async () => {
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
vi.mock('../../packages/util-chromium/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', () => ({
  default: { launch: fake.launch, executablePath: () => '/zz-missing-chrome' },
  launch: fake.launch,
}));

const PUPPETEER = join(dirname(fileURLToPath(import.meta.url)), '../../packages/util-chromium/node_modules/puppeteer');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  fake.launch.mockClear();
});

describe('自动下载自带的 Chrome', () => {
  it('没装又没配路径：跑的是 puppeteer 包里 bin 指的命令行，下载完照常启动浏览器', async () => {
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
    const execFile = vi.fn(async (_cmd: string, _args: readonly string[]) => ({ stdout: '', stderr: '', code: 0 }));
    host.provide.use(processService, { execFile } as never);
    await app.plugins.register(browserPlugin, { blockPrivate: false });
    await app.plugins.idle();

    const result = JSON.parse(
      (await handlers.browser_navigate({ url: 'http://example.zz-test/' }, toolContext({ sessionId: 's' }))) as string,
    ) as { error?: string };

    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFile.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['browsers', 'install', 'chrome']);
    const { bin } = JSON.parse(readFileSync(join(PUPPETEER, 'package.json'), 'utf-8')) as { bin: string };
    // 两边都取真实路径：包在 node_modules 里是指向存储目录的链接。脚本不存在时 realpathSync 抛错
    expect(realpathSync(args[0])).toBe(realpathSync(join(PUPPETEER, bin)));
    expect(result.error).toBeUndefined();
    expect(fake.launch).toHaveBeenCalledTimes(1);
  });
});
