import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ExecResult, processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, LogHub, provide } from '../../packages/core/src/index.js';
import toolSystem from '../../packages/plugin-tool-system/src/index.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// storage、process 是 tool-system 的 optional 依赖：不参与激活先后，本插件激活时它们在不在只看时机。之后才上线的，
// shell、文件、cwd、cd 与 http_download 也要用得上；提供者换一家也不撤工具（撤工具会中止这条登记上在跑的调用）。替身服务，
// 不启动进程、不碰磁盘；安全取数换成就地回响应体，不联网。
// ════════════════════════════════════════════════════════════

vi.mock(import('../../packages/util-network-guard/src/index.js'), async importOriginal => ({
  ...(await importOriginal()),
  safeFetch: async () => new Response('zz-body', { headers: { 'content-type': 'text/plain' } }),
}));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 根名为 workspace 的替身 storage：listRoots、本地路径与 stat 够 shell、file_info、cwd 用 */
const fakeStorage = (label: string) => ({
  listRoots: () => [
    { name: 'workspace', label, kind: 'workspace', readable: true, writable: true, deletable: true, browsable: true },
  ],
  resolveLocalPath: async (uri: string) => `/zz-host/${uri.replace(':/', '/')}`,
  stat: async (uri: string) => ({ path: uri, isDirectory: false, size: 3, ext: '.txt' }),
});

/** 替身 process：spawn 的命令即刻以 stdout 为 out 的结果结束 */
const fakeProcess = (out: string) => ({
  spawn: () => ({
    pid: 1,
    stdin: null,
    stdout: null,
    stderr: null,
    wait: async () => ({ code: 0, signal: null, stdout: out, stderr: '' }) satisfies ExecResult,
  }),
});

const parse = (out: Awaited<ReturnType<RegisteredTool['handler']>>) =>
  JSON.parse(typeof out === 'string' ? out : out.content) as Record<string, unknown>;

/** 只装 tool-system（storage、process 都不在）；call 直接调登记下来的工具，withdrawn 记下被撤的工具名 */
async function boot() {
  const app = new App({ name: 'T', logLevel: 'error', logHub: new LogHub() });
  apps.push(app);
  const host = app.bind({ provide });
  const registered = new Map<string, Omit<RegisteredTool, 'pluginName'>>();
  const withdrawn: string[] = [];
  host.provide.use(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      const name = tool.definition.function.name;
      registered.set(name, tool);
      return () => withdrawn.push(name);
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugins.register(toolSystem);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(toolSystem.name)?.state).toBe('active');
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = registered.get(name);
    if (!tool) throw new Error(`${name} 没有登记`);
    return parse(await tool.handler(args, toolContext({ sessionId: 's' })));
  };
  return { host, call, withdrawn };
}

describe('tool-system：storage、process 晚于本插件上线', () => {
  it('shell、文件、cwd 调到之后上线的那一家；换一家照常调到新的，一条工具也不撤', async () => {
    const { host, call, withdrawn } = await boot();
    // 调用那一刻它们不在：用到它们的工具报服务不可用
    await expect(call('exec', { command: 'echo' })).rejects.toThrow('服务 "storage" 不可用');
    expect(await call('file_info', { path: 'workspace:/a.txt' })).toMatchObject({
      error: expect.stringContaining('服务 "storage" 不可用'),
    });

    const offStorage = host.provide.use(storage, fakeStorage('一号') as never);
    const offProcess = host.provide.use(processService, fakeProcess('first') as never);
    expect(await call('exec', { command: 'echo' })).toMatchObject({ exitCode: 0, stdout: 'first' });
    expect(await call('file_info', { path: 'workspace:/a.txt' })).toMatchObject({ uri: 'workspace:/a.txt', size: 3 });
    expect(await call('cwd', {})).toMatchObject({ availableRoots: [{ name: 'workspace', label: '一号' }] });

    // 换一家：新的先上，旧的再撤
    host.provide.use(storage, fakeStorage('二号') as never);
    host.provide.use(processService, fakeProcess('second') as never);
    offStorage();
    offProcess();
    expect(await call('exec', { command: 'echo' })).toMatchObject({ stdout: 'second' });
    expect(await call('cwd', {})).toMatchObject({ availableRoots: [{ label: '二号' }] });
    expect(withdrawn).toEqual([]);
  });

  it('http_download 与 cd 用之后上线的 storage：不在时下载报需要 storage、cd 没有根可校验，上线后下载写进它、cd 按它的根校验', async () => {
    const { host, call } = await boot();
    const download = { url: 'https://example.invalid/a.txt', savePath: 'a.txt' };
    expect(await call('http_download', download)).toEqual({ error: 'HTTP 下载需要 storage 服务' });
    expect(await call('cd', { target: 'nope:/x' })).toMatchObject({ cwd: 'nope:/x' });

    const written = new Map<string, string>();
    host.provide.use(storage, {
      ...fakeStorage('一号'),
      writeFile: async (uri: string, data: Buffer) => void written.set(uri, data.toString('utf-8')),
    } as never);
    expect(await call('http_download', download)).toMatchObject({ path: 'workspace:/a.txt', size: 7 });
    expect(written).toEqual(new Map([['workspace:/a.txt', 'zz-body']]));
    expect(await call('cd', { target: 'nope:/x' })).toEqual({
      error: expect.stringContaining('目标根 "nope" 不存在。已注册根: workspace'),
    });
    expect(await call('cd', { target: 'workspace:/sub' })).toMatchObject({ cwd: 'workspace:/sub' });
  });
});
