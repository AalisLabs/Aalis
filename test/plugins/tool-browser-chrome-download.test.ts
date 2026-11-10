import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ExecResult, processService, type SpawnOptions } from '../../packages/api-process/src/index.js';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { App, LogHub, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 自带的 Chrome 没装、又没配 executablePath：启动浏览器之前经 process 服务跑 puppeteer 包里的命令行下载它。
// - 跑的脚本就是 puppeteer 的 package.json 里 bin 指的那个文件。
// - 输出不写进宿主的终端（按缺省的管道收），全文进调试日志；失败的报错带上 stderr 的结尾：命令行失败时先打一整屏用法，
//   报错在最后。
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

/**
 * process 服务替身：子进程按 wait 落定。与 process-local 一样，execFile 是 spawn 加 wait、非零退出时带着结果抛错，
 * 所以不论插件用哪个，spawn 都记下了命令与选项
 */
function fakeProcess(wait: (opts?: SpawnOptions) => Promise<ExecResult>) {
  const spawn = vi.fn((_cmd: string, _args: readonly string[], opts?: SpawnOptions) => ({ wait: () => wait(opts) }));
  const execFile = async (cmd: string, args: readonly string[], opts?: SpawnOptions) => {
    const result = await spawn(cmd, args, opts).wait();
    if (result.code === 0) return result;
    throw Object.assign(new Error(`execFile ${cmd} 退出码 ${result.code}: ${result.stderr.slice(0, 200)}`), { result });
  };
  return { spawn, service: { spawn, execFile } };
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
    const proc = fakeProcess(async () => ({ stdout: '', stderr: '', code: 0, signal: null }));
    const { navigate } = await start(proc.service);

    const result = await navigate();

    expect(proc.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = proc.spawn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['browsers', 'install', 'chrome']);
    const { bin } = JSON.parse(readFileSync(join(PUPPETEER, 'package.json'), 'utf-8')) as { bin: string };
    // 两边都取真实路径：包在 node_modules 里是指向存储目录的链接。脚本不存在时 realpathSync 抛错
    expect(realpathSync(args[0])).toBe(realpathSync(join(PUPPETEER, bin)));
    expect(result.error).toBeUndefined();
    expect(fake.launch).toHaveBeenCalledTimes(1);
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
