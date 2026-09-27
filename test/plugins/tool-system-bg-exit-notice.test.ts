import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult, ProcessService, SpawnOptions } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool, ToolCallContext } from '../../packages/api-tools/src/index.js';
import type { Events, LifecycleCap } from '../../packages/core/src/index.js';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';
import { registerShellTools } from '../../packages/plugin-tool-system/src/tools/shell.js';
import { type IncomingMessage, selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// 后台命令结束通知：exec_background 起的进程自行结束时，向起它的会话注入一条宿主通知、触发一轮回复。
//   - 通知只放宿主取得的事实（进程 id、结局、用时），命令与输出一律不进通知，输出经 process_read 以 tool 角色进来；
//   - 身份跟链源头：platform、actor 与 callerUserId 取起进程那次调用；由结束通知开的回合里起的进程不再通知；
//   - process_kill 不确认、只收终止，走中止契约整组收掉，只能停自己起的（owner 除外），被它终止的不通知；
//   - 删除会话即终止其后台进程；插件停用、停机时不通知。
// 起真实进程的用例只在 POSIX 跑；其余用替身进程，任何平台都跑。
// ════════════════════════════════════════════════════════════

const posix = process.platform !== 'win32';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 对 pid（负数为进程组）发 0 号信号只探测不打：存在返回 undefined，否则返回错误码（不存在为 ESRCH） */
const probe = (target: number): string | undefined => {
  try {
    process.kill(target, 0);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
};

const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
};

/** 让已排队的微任务与一轮宏任务跑完（替身进程落定后的回调） */
const flush = () => sleep(10);

type Handler = RegisteredTool['handler'];
type Registered = Omit<RegisteredTool, 'pluginName'>;

const SESSION = 'zz-slice1-bg-session';
const OTHER = 'zz-slice1-bg-other';
const GROUP = 'onebot:10000:group:20001';
const OWNER_QQ = '10001';

/** agent 回合的调用上下文（owner 的 WebUI 会话） */
const webuiTurn: ToolCallContext = { sessionId: SESSION, platform: 'webui', userId: 'console', inbound: {} };

let dir: string;
let pids: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zz-slice1-bg-'));
  pids = [];
});

afterEach(() => {
  for (const pid of pids.splice(0)) {
    if (probe(-pid) !== undefined) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 真实 LocalProcessService 外包一层，记下起过的 pid（afterEach 收掉变异下停不掉的组） */
function recordingProcess(): ProcessService {
  const inner = new LocalProcessService({} as unknown as StorageService);
  return {
    spawn: (cmd, args, opts) => {
      const handle = inner.spawn(cmd, args, opts);
      if (handle.pid !== undefined && handle.pid > 1) pids.push(handle.pid);
      return handle;
    },
    execFile: (cmd, args, opts) => inner.execFile(cmd, args, opts),
    makeTempDir: prefix => inner.makeTempDir(prefix),
    readExternalFile: (path, maxBytes) => inner.readExternalFile(path, maxBytes),
  };
}

interface FakeRun {
  opts: SpawnOptions;
  settle(result?: Partial<ExecResult>): void;
  fail(err: Error): void;
}

/** 替身进程：wait() 由用例手动落定；中止信号到达时按 SIGTERM 落定（除非 hang）；pid 为 undefined 时 wait 立即被拒 */
function fakeProcess(opts: { pid?: number | null; hang?: boolean } = {}) {
  const runs: FakeRun[] = [];
  const pid = opts.pid === null ? undefined : (opts.pid ?? 4242);
  const proc: ProcessService = {
    spawn: (_cmd, _args, spawnOpts = {}) => {
      spawnOpts.signal?.throwIfAborted();
      let resolve!: (r: ExecResult) => void;
      let reject!: (e: unknown) => void;
      const done = new Promise<ExecResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const run: FakeRun = {
        opts: spawnOpts,
        settle: r => resolve({ code: 0, signal: null, stdout: '', stderr: '', ...r }),
        fail: err => reject(err),
      };
      runs.push(run);
      if (pid === undefined) run.fail(Object.assign(new Error('spawn /bin/sh ENOENT'), { code: 'ENOENT' }));
      else if (!opts.hang) {
        spawnOpts.signal?.addEventListener('abort', () => run.settle({ code: null, signal: 'SIGTERM' }), {
          once: true,
        });
      }
      return { pid, stdin: null, stdout: null, stderr: null, wait: () => done, kill: () => true, unref() {} };
    },
    execFile: async () => {
      throw new Error('不该调 execFile');
    },
    makeTempDir: async () => {
      throw new Error('不该建临时目录');
    },
    readExternalFile: async () => {
      throw new Error('不该读外部文件');
    },
  };
  return { proc, runs };
}

/** 事件替身：记下 emit 的 inbound:message，能手动发 session:deleted、app:stopping */
function stubEvents() {
  const notices: IncomingMessage[] = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const events = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter(h => h !== handler),
        );
      };
    },
    async emit(event: string, ...args: unknown[]) {
      if (event === 'inbound:message') notices.push(args[0] as IncomingMessage);
      for (const handler of listeners.get(event) ?? []) await handler(...args);
    },
  };
  return {
    events: events as unknown as Events,
    notices,
    fire: (event: string, ...args: unknown[]) => events.emit(event, ...args),
  };
}

interface Setup {
  handlers: Record<string, Handler>;
  registered: Record<string, Registered>;
  notices: IncomingMessage[];
  fire: (event: string, ...args: unknown[]) => Promise<void>;
  lifecycle: AbortController;
}

/** 注册 shell 工具组；直接调 handler，不经 authority */
function register(
  proc: ProcessService,
  opts: { isOwner?: (id: { platform: string; userId: string }) => boolean } = {},
): Setup {
  const handlers: Record<string, Handler> = {};
  const registered: Record<string, Registered> = {};
  const tools = stubBoundTools({
    onRegister: t => {
      handlers[t.definition.function.name] = t.handler;
      registered[t.definition.function.name] = t;
    },
  });
  const { events, notices, fire } = stubEvents();
  const lifecycle = new AbortController();
  registerShellTools(tools, {
    logger: silentLogger(),
    lifecycle: { signal: lifecycle.signal, onDispose: () => () => {} } as unknown as LifecycleCap,
    events,
    isOwner: opts.isOwner ?? (() => false),
    cwdUri: 'workspace:/',
    proc,
    storage: { resolveLocalPath: async () => dir } as unknown as StorageService,
    defaultTimeout: 30000,
    maxTimeout: 300000,
    maxOutputSize: 65536,
  });
  return { handlers, registered, notices, fire, lifecycle };
}

async function call(handler: Handler, args: Record<string, unknown>, ctx: ToolCallContext = webuiTurn) {
  const out = await handler(args, ctx);
  return JSON.parse(typeof out === 'string' ? out : out.content) as Record<string, unknown>;
}

/** 起一个替身进程，返回进程 id 与它的落定句柄 */
async function startFake(s: Setup, runs: FakeRun[], ctx: ToolCallContext = webuiTurn) {
  const started = await call(s.handlers.exec_background, { command: 'zz-slice1-placeholder' }, ctx);
  return { id: started.processId as string, run: runs[runs.length - 1], started };
}

describe('结束通知的内容（POSIX，真实进程）', () => {
  it.skipIf(!posix)('安全：自行退出后恰好注入一条宿主通知，只带宿主取得的事实，命令与输出不进通知', async () => {
    const s = register(recordingProcess());
    const command = 'echo zz-out; echo zz-err >&2; exit 3';
    const started = await call(s.handlers.exec_background, { command });
    expect(started.message).toContain('会通知你');
    expect(await waitFor(() => s.notices.length > 0, 3000), '3 秒内应注入通知').toBe(true);
    await sleep(200);
    expect(s.notices).toHaveLength(1);
    const [notice] = s.notices;
    const id = started.processId as string;
    expect(notice.sessionId).toBe(SESSION);
    expect(notice.platform).toBe('webui');
    expect(notice.source).toBe(`exec-bg:${id}`);
    expect(notice.actor).toEqual({ platform: 'webui', userId: 'console' });
    expect(notice.hostNotice).toEqual({ kind: 'exec-background', id, callerUserId: 'console' });
    for (const key of ['userId', 'nickname', 'sessionType', 'triggerType'] as const) {
      expect(notice[key], key).toBeUndefined();
    }
    expect(notice.content).toContain(id);
    expect(notice.content).toContain('退出码 3');
    expect(notice.content).toContain('process_read');
    for (const leaked of ['zz-out', 'zz-err', 'echo', command]) {
      expect(JSON.stringify(notice), leaked).not.toContain(leaked);
    }
    // 输出经 process_read 取得，结果带命令
    const read = await call(s.handlers.process_read, { processId: id });
    expect(read).toMatchObject({ processId: id, command, running: false, exitCode: 3 });
    expect(read.stdout).toContain('zz-out');
    expect(read.stderr).toContain('zz-err');
  });

  it.skipIf(!posix)('被信号结束：写信号名，不写退出码', async () => {
    const s = register(recordingProcess());
    const started = await call(s.handlers.exec_background, { command: 'kill -TERM $$' });
    expect(await waitFor(() => s.notices.length > 0, 3000)).toBe(true);
    expect(s.notices[0].content).toContain(`${started.processId} 被信号 SIGTERM 结束`);
    expect(s.notices[0].content).not.toContain('退出码');
  });

  it.skipIf(!posix)('同一会话两个进程先后退出：两条通知，source 与 id 各不相同', async () => {
    const s = register(recordingProcess());
    const a = await call(s.handlers.exec_background, { command: 'exit 0' });
    const b = await call(s.handlers.exec_background, { command: 'sleep 0.3; exit 1' });
    expect(await waitFor(() => s.notices.length >= 2, 3000)).toBe(true);
    expect(s.notices.map(n => n.source)).toEqual([`exec-bg:${a.processId}`, `exec-bg:${b.processId}`]);
    expect(s.notices.map(n => n.hostNotice?.id)).toEqual([a.processId, b.processId]);
  });
});

describe('结束通知的内容（替身进程）', () => {
  it('wait 出错落定：写「出错结束」，错误文本不进通知，在 process_read 的 stderr 里', async () => {
    const { proc, runs } = fakeProcess();
    const s = register(proc);
    const { id, run } = await startFake(s, runs);
    run.fail(new Error('zz-slice1-wait-error'));
    await flush();
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0].content).toContain(`${id} 出错结束`);
    expect(JSON.stringify(s.notices[0])).not.toContain('zz-slice1-wait-error');
    const read = await call(s.handlers.process_read, { processId: id });
    expect(read.stderr).toContain('zz-slice1-wait-error');
  });

  it('创建失败（没有 pid）：直接回启动失败，不登记、不通知', async () => {
    const { proc } = fakeProcess({ pid: null });
    const s = register(proc);
    // 登记表是模块级的，前面用例的进程还在里面：用一个只属于本用例的会话
    const ctx: ToolCallContext = { ...webuiTurn, sessionId: 'zz-slice1-bg-spawn-fail' };
    const res = await call(s.handlers.exec_background, { command: 'zz-slice1-placeholder' }, ctx);
    expect(String(res.error)).toContain('启动失败');
    expect(res.processId).toBeUndefined();
    const list = await call(s.handlers.process_list, {}, ctx);
    expect(list.total).toBe(0);
    await flush();
    expect(s.notices).toEqual([]);
  });

  it('进程 id 带启动标识；重新加载模块后标识不同', async () => {
    const { proc, runs } = fakeProcess();
    const { id } = await startFake(register(proc), runs);
    expect(id).toMatch(/^proc_[0-9a-f]{6}_\d+$/);
    vi.resetModules();
    const again = await import('../../packages/plugin-tool-system/src/tools/shell.js');
    let other: Handler | undefined;
    again.registerShellTools(
      stubBoundTools({
        onRegister: t => {
          if (t.definition.function.name === 'exec_background') other = t.handler;
        },
      }),
      {
        logger: silentLogger(),
        lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} } as unknown as LifecycleCap,
        events: stubEvents().events,
        isOwner: () => false,
        cwdUri: 'workspace:/',
        proc,
        storage: { resolveLocalPath: async () => dir } as unknown as StorageService,
        defaultTimeout: 30000,
        maxTimeout: 300000,
        maxOutputSize: 65536,
      },
    );
    const second = (await call(other as Handler, { command: 'zz-slice1-placeholder' })).processId as string;
    expect(second.split('_')[1]).not.toBe(id.split('_')[1]);
  });
});

describe('结束通知的身份：权限跟链源头', () => {
  const cases: Array<{
    name: string;
    ctx: ToolCallContext;
    platform: string;
    actor: { platform: string; userId: string };
    callerUserId?: string;
  }> = [
    {
      name: 'owner 的 WebUI 回合（无 actor）',
      ctx: webuiTurn,
      platform: 'webui',
      actor: { platform: 'webui', userId: 'console' },
      callerUserId: 'console',
    },
    {
      name: '子任务回合（actor 为创建者，userId 为 parent:<id>）',
      ctx: {
        sessionId: SESSION,
        platform: 'webui',
        userId: `parent:${OTHER}`,
        actor: { platform: 'webui', userId: 'console' },
        inbound: {},
      },
      platform: 'webui',
      actor: { platform: 'webui', userId: 'console' },
      callerUserId: `parent:${OTHER}`,
    },
    {
      name: '定时任务回合（actor 为创建者，无 userId）',
      ctx: {
        sessionId: SESSION,
        platform: 'webui',
        actor: { platform: 'webui', userId: 'console' },
        inbound: { source: 'scheduler' },
      },
      platform: 'webui',
      actor: { platform: 'webui', userId: 'console' },
    },
    {
      name: '匿名回合（没有 actor 也没有 userId）',
      ctx: { sessionId: GROUP, platform: 'onebot', inbound: {} },
      platform: 'onebot',
      actor: selfInitiatedActor('onebot'),
    },
    {
      name: '自发回合（actor 为无主体，userId 为最后发言的群友）',
      ctx: {
        sessionId: GROUP,
        platform: 'onebot',
        userId: '30001',
        actor: selfInitiatedActor('onebot'),
        inbound: {},
      },
      platform: 'onebot',
      actor: { platform: 'onebot', userId: '' },
      callerUserId: '30001',
    },
    {
      name: 'WebUI 往群房间插话（sessionId 为群，platform 为 webui）',
      ctx: { sessionId: GROUP, platform: 'webui', userId: 'console', inbound: {} },
      platform: 'webui',
      actor: { platform: 'webui', userId: 'console' },
      callerUserId: 'console',
    },
  ];

  for (const c of cases) {
    it(`安全：${c.name}`, async () => {
      const { proc, runs } = fakeProcess();
      const s = register(proc);
      const { id, run } = await startFake(s, runs, c.ctx);
      run.settle({ code: 0 });
      await flush();
      expect(s.notices).toHaveLength(1);
      const [notice] = s.notices;
      expect(notice.sessionId).toBe(c.ctx.sessionId);
      expect(notice.platform).toBe(c.platform);
      expect(notice.actor).toEqual(c.actor);
      expect(notice.hostNotice).toEqual({
        kind: 'exec-background',
        id,
        ...(c.callerUserId !== undefined ? { callerUserId: c.callerUserId } : {}),
      });
      expect(notice.userId).toBeUndefined();
    });
  }
});

describe('不发通知的情形', () => {
  it('安全：由结束通知开的回合里起的进程不再通知，工具结果写明', async () => {
    const { proc, runs } = fakeProcess();
    const s = register(proc);
    const { run, started } = await startFake(s, runs, { ...webuiTurn, inbound: { source: 'exec-bg:proc_000000_1' } });
    expect(started.message).toContain('不再通知');
    run.settle({ code: 1 });
    await flush();
    expect(s.notices).toEqual([]);
  });

  it('安全：不在 agent 回合里的调用（mcp-server 形态，没有 inbound）不通知，工具结果不承诺通知', async () => {
    const { proc, runs } = fakeProcess();
    const s = register(proc);
    const { run, started } = await startFake(s, runs, {
      sessionId: 'mcp-server',
      userId: 'mcp-client',
      platform: 'mcp',
    });
    expect(started.message).not.toContain('通知');
    run.settle({ code: 0 });
    await flush();
    expect(s.notices).toEqual([]);
  });

  it('安全：插件停用（lifecycle 中止）时不通知', async () => {
    const { proc, runs } = fakeProcess({ hang: true });
    const s = register(proc);
    const { run } = await startFake(s, runs);
    s.lifecycle.abort();
    run.settle({ code: null, signal: 'SIGTERM' });
    await flush();
    expect(s.notices).toEqual([]);
  });

  it('安全：停机（app:stopping 之后进程被收掉）时不通知', async () => {
    const { proc, runs } = fakeProcess();
    const s = register(proc);
    const { run } = await startFake(s, runs);
    await s.fire('app:stopping');
    run.settle({ code: null, signal: 'SIGKILL' });
    await flush();
    expect(s.notices).toEqual([]);
  });

  it('安全：会话删除时进程随之终止、不通知，桶清空；别的会话照常', async () => {
    const { proc, runs } = fakeProcess();
    const s = register(proc);
    const mine = await startFake(s, runs);
    const other = await startFake(s, runs, { ...webuiTurn, sessionId: OTHER });
    await s.fire('session:deleted', SESSION);
    await flush();
    expect(mine.run.opts.signal?.aborted, '被删会话的进程应被中止').toBe(true);
    expect(other.run.opts.signal?.aborted).toBe(false);
    expect(s.notices).toEqual([]);
    expect((await call(s.handlers.process_list, {})).total).toBe(0);
    other.run.settle({ code: 0 });
    await flush();
    expect(s.notices.map(n => n.sessionId)).toEqual([OTHER]);
  });
});

describe('中止契约：停用与删除会话收掉整组（POSIX，真实进程）', () => {
  it.skipIf(!posix)('安全：插件停用时进程组 3 秒内消失，不通知', async () => {
    const s = register(recordingProcess());
    const started = await call(s.handlers.exec_background, { command: 'sleep 30' });
    const pid = started.pid as number;
    expect(probe(pid)).toBeUndefined();
    s.lifecycle.abort();
    expect(await waitFor(() => probe(-pid) === 'ESRCH', 3000), '进程组应被收掉').toBe(true);
    await sleep(300);
    expect(s.notices).toEqual([]);
  });

  it.skipIf(!posix)('安全：会话删除时进程组 3 秒内消失，不通知', async () => {
    const s = register(recordingProcess());
    const started = await call(s.handlers.exec_background, { command: 'sleep 30' });
    const pid = started.pid as number;
    await s.fire('session:deleted', SESSION);
    expect(await waitFor(() => probe(-pid) === 'ESRCH', 3000), '进程组应被收掉').toBe(true);
    await sleep(300);
    expect(s.notices).toEqual([]);
  });
});

describe('process_kill', () => {
  it('安全：不要确认，仍为 restricted，参数只有 processId', () => {
    const { proc } = fakeProcess();
    const s = register(proc);
    const kill = s.registered.process_kill;
    expect(kill.confirm).toBeUndefined();
    expect(kill.visibility).toBe('restricted');
    const params = kill.definition.function.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(params.properties)).toEqual(['processId']);
  });

  it.skipIf(!posix)('安全：收掉 sleep 30，报已停止，进程组已不存在，之后不通知', async () => {
    const s = register(recordingProcess());
    const started = await call(s.handlers.exec_background, { command: 'sleep 30' });
    const pid = started.pid as number;
    const killed = await call(s.handlers.process_kill, { processId: started.processId });
    expect(killed.error).toBeUndefined();
    expect(killed.stopped).toBe(true);
    expect(probe(-pid)).toBe('ESRCH');
    await sleep(1000);
    expect(s.notices).toEqual([]);
  });

  it.skipIf(!posix)('安全：忽略 SIGTERM 的进程组，宽限后强制结束，3000ms 内报已停止', async () => {
    const s = register(recordingProcess());
    const started = await call(s.handlers.exec_background, {
      command: "trap '' TERM; while :; do sleep 0.1; done",
    });
    const pid = started.pid as number;
    await sleep(200);
    const t0 = Date.now();
    const killed = await call(s.handlers.process_kill, { processId: started.processId });
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(killed.stopped).toBe(true);
    // macOS 上刚被 SIGKILL、还没被回收的成员仍在组里时，0 号信号报 EPERM：与上面两条一样轮询等到 ESRCH
    expect(await waitFor(() => probe(-pid) === 'ESRCH', 3000), '进程组应被收掉').toBe(true);
  });

  it('安全：终止后仍未落定：如实报仍在运行，通知目标放回，之后自行结束照常通知', async () => {
    const { proc, runs } = fakeProcess({ hang: true });
    const s = register(proc);
    const { id, run } = await startFake(s, runs);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = call(s.handlers.process_kill, { processId: id });
      await vi.advanceTimersByTimeAsync(3500);
      const killed = await pending;
      expect(killed.stopped).toBeUndefined();
      expect(killed.running).toBe(true);
      expect(String(killed.message)).toContain('仍在运行');
    } finally {
      vi.useRealTimers();
    }
    run.settle({ code: null, signal: 'SIGKILL' });
    await flush();
    expect(s.notices.map(n => n.hostNotice?.id)).toEqual([id]);
  });

  it('安全：只能停自己起的，owner 除外', async () => {
    const { proc, runs } = fakeProcess();
    const owner = { platform: 'onebot', userId: OWNER_QQ };
    const s = register(proc, { isOwner: id => id.platform === owner.platform && id.userId === owner.userId });
    const turn = (userId: string): ToolCallContext => ({ sessionId: GROUP, platform: 'onebot', userId, inbound: {} });
    const a = await startFake(s, runs, turn('30001'));
    const refused = await call(s.handlers.process_kill, { processId: a.id }, turn('30002'));
    expect(String(refused.error)).toContain('只能终止自己起的');
    expect(a.run.opts.signal?.aborted).toBe(false);
    const byOwner = await call(s.handlers.process_kill, { processId: a.id }, turn(OWNER_QQ));
    expect(byOwner.stopped).toBe(true);
    const b = await startFake(s, runs, turn('30001'));
    const bySelf = await call(s.handlers.process_kill, { processId: b.id }, turn('30001'));
    expect(bySelf.stopped).toBe(true);
    await flush();
    expect(s.notices).toEqual([]);
  });
});
