import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecResult, processService, type SpawnOptions } from '../../packages/api-process/src/index.js';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { App, LogHub, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import { fakeChromeCli } from '../fixtures/puppeteer-cli.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 自带的 Chrome 没装、又没配 executablePath：启动浏览器之前经 process 服务跑 puppeteer 包里的命令行下载它。
// - 跑的脚本就是 puppeteer 的 package.json 里 bin 指的那个文件。
// - 下载或解压途中被打断时，puppeteer 的缓存里不留不完整的安装，下次调用照常重新装好。
// - 下载接插件这次激活的中止信号：停用时由 process 服务停掉它，不等满 5 分钟的下载时限；在途的调用与启动期间停用一样报
//   「浏览器工具已停用」，不当成启动失败。
// - 输出不写进宿主的终端（按缺省的管道收），全文进调试日志；失败的报错带上 stderr 的结尾：命令行失败时先打一整屏用法，
//   报错在最后。
// puppeteer 换成替身（按 util-chromium 的依赖路径 mock），不启动真浏览器，缓存根是每条用例自己的临时目录；process 服务换成
// 替身，命令行按 puppeteer 的安装流程在缓存里摆放文件（见 fixtures/puppeteer-cli），不真下载。
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
  /** 缓存根与自带 Chrome 的可执行文件路径，每条用例前设好 */
  const cache = { dir: '', exe: '' };
  return { launch, cache };
});
vi.mock('../../packages/util-chromium/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', () => ({
  default: {
    launch: fake.launch,
    executablePath: () => fake.cache.exe,
    get configuration() {
      return { cacheDirectory: fake.cache.dir };
    },
  },
  launch: fake.launch,
}));

const PUPPETEER = join(dirname(fileURLToPath(import.meta.url)), '../../packages/util-chromium/node_modules/puppeteer');

const apps: App[] = [];
beforeEach(async () => {
  fake.cache.dir = await mkdtemp(join(tmpdir(), 'zz-chrome-cache-'));
  fake.cache.exe = join(fake.cache.dir, 'chrome', 'mac_arm-1.2.3', 'chrome-mac', 'zz-chrome');
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  fake.launch.mockClear();
  await rm(fake.cache.dir, { recursive: true, force: true });
});

/** 按 puppeteer 的安装流程在缓存里摆放文件的命令行替身，自带 Chrome 装好后正好在 fake.cache.exe */
const chromeCli = () =>
  fakeChromeCli({ cacheDir: fake.cache.dir, platform: 'mac_arm', buildId: '1.2.3', exe: 'chrome-mac/zz-chrome' });

/** process 服务替身：spawn 记下命令与选项，子进程按 wait 落定 */
function fakeProcess(wait: (args: readonly string[], opts?: SpawnOptions) => Promise<ExecResult>) {
  const spawn = vi.fn((_cmd: string, args: readonly string[], opts?: SpawnOptions) => ({
    wait: () => wait(args, opts),
  }));
  return { spawn, service: { spawn } };
}

/** 启动浏览器工具，process 服务换成给的替身；debugs、errors 收调试与错误日志 */
async function start(proc: object, disposeTimeoutMs?: number) {
  const hub = new LogHub();
  const debugs: string[] = [];
  const errors: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'debug') debugs.push(entry.message);
    if (entry.level === 'error') errors.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'debug', logHub: hub, disposeTimeoutMs });
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
  host.provide.use(processService, proc as never);
  await app.plugins.register(browserPlugin, { blockPrivate: false });
  await app.plugins.idle();
  const navigate = async () =>
    JSON.parse(
      (await handlers.browser_navigate({ url: 'http://example.zz-test/' }, toolContext({ sessionId: 's' }))) as string,
    ) as { error?: string };
  return { app, debugs, errors, navigate };
}

describe('自动下载自带的 Chrome', () => {
  it('没装又没配路径：跑的是 puppeteer 包里 bin 指的命令行，下载完照常启动浏览器', async () => {
    const cli = chromeCli();
    const proc = fakeProcess((args, opts) => cli.run(args, opts?.env));
    const { navigate } = await start(proc.service);

    const result = await navigate();

    expect(proc.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = proc.spawn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['browsers', 'install', 'chrome', '--format', '{{path}}']);
    // 时限交给 process 服务：到时停掉命令行，过期临时目录的判定以它为界
    expect(proc.spawn.mock.calls[0][2]?.timeout).toBe(300_000);
    const { bin } = JSON.parse(readFileSync(join(PUPPETEER, 'package.json'), 'utf-8')) as { bin: string };
    // 两边都取真实路径：包在 node_modules 里是指向存储目录的链接。脚本不存在时 realpathSync 抛错
    expect(realpathSync(args[0])).toBe(realpathSync(join(PUPPETEER, bin)));
    expect(result.error).toBeUndefined();
    expect(existsSync(fake.cache.exe)).toBe(true);
    expect(fake.launch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['下载', 'interrupt-download'],
    ['解压（可执行文件已解出、别的还缺）', 'interrupt-extract'],
  ] as const)('%s途中被打断：缓存里不留不完整的安装，下次调用照常重新装好', async (_label, outcome) => {
    const cli = chromeCli();
    cli.outcomes.push(outcome);
    const proc = fakeProcess((args, opts) => cli.run(args, opts?.env));
    const { navigate } = await start(proc.service);

    expect((await navigate()).error).toBeDefined();
    expect(await readdir(fake.cache.dir)).toEqual([]);

    expect((await navigate()).error).toBeUndefined();
    expect(existsSync(join(cli.installDir, 'zz-resources.pak'))).toBe(true);
    expect(fake.launch).toHaveBeenCalledTimes(1);
  });

  it('下载途中停用：交给下载的中止信号随之断开，停用不等下载完成，调用报「浏览器工具已停用」', async () => {
    // 替身：一直不回，中止时按终止信号落定（与 process 服务停掉进程组后一样）
    const proc = fakeProcess(
      (_args, opts) =>
        new Promise(resolve => {
          const stopped = { stdout: '', stderr: '', code: null, signal: 'SIGTERM' as const };
          opts?.signal?.addEventListener('abort', () => resolve(stopped), { once: true });
        }),
    );
    const { app, errors, navigate } = await start(proc.service, 500);
    const pending = navigate();
    await vi.waitFor(() => expect(proc.spawn).toHaveBeenCalledTimes(1));
    await app.plugins.disable(browserPlugin.name);
    expect(proc.spawn.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(app.plugins.getStatus().find(entry => entry.instanceId === browserPlugin.name)?.lingering).toBeUndefined();
    expect((await pending).error).toBe('浏览器工具已停用');
    expect(errors).toEqual([]);
    expect(fake.launch).not.toHaveBeenCalled();
  });

  it('输出按管道收、不写进宿主的终端，全文进调试日志；下载失败时报错带上 stderr 的结尾', async () => {
    const stderr = `zz-用法开头\n${'zz-用法 '.repeat(800)}\nError: zz-下载失败的原因\n    at zz-调用栈`;
    const proc = fakeProcess(async () => ({ stdout: '', stderr, code: 1, signal: null }));
    const { debugs, navigate } = await start(proc.service);

    const result = await navigate();

    expect(proc.spawn.mock.calls[0][2]?.stdio ?? 'pipe').toBe('pipe');
    expect(result.error).toContain('Error: zz-下载失败的原因');
    expect(result.error).not.toContain('zz-用法开头');
    expect(debugs.some(message => message.includes('zz-用法开头') && message.includes('zz-下载失败的原因'))).toBe(true);
    expect(fake.launch).not.toHaveBeenCalled();
  });
});
