import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeSandboxService, SandboxRunRequest } from '../../packages/api-code-sandbox/src/index.js';
import type { ExecResult, ProcessService, SpawnHandle, SpawnOptions } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import type { Provide } from '../../packages/core/src/index.js';
import codeSandboxOs from '../../packages/plugin-code-sandbox-os/src/index.js';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';
import codeRunner from '../../packages/plugin-tool-code-runner/src/index.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 代码执行接住中止：run_python、run_javascript 在沙箱与无沙箱两条路径上都能被停止键停掉。
//   - handler 把 callCtx.signal 交给 runCode，无沙箱路径经 execFile、沙箱路径经 code-sandbox 的 run 交给 process 服务；
//   - 被信号结束的才报 aborted；中止前已正常退出的按实际退出回报、注明回合已中止（与 exec 同一口径）。
// 真实进程的断言看心跳文件而不是 pid：Linux bwrap 下记下的 pid 是外层启动器，解释器不在我们的进程组里，
// 只查 pid 已不存在测不出沙箱内的进程是否真的停了。起真实进程的用例只在 POSIX 跑。
// ════════════════════════════════════════════════════════════

const posix = process.platform !== 'win32';

/** 本机 python3 的绝对路径；没有就跳过 run_python 的真实进程用例 */
const pythonPath = ((): string | undefined => {
  if (!posix) return undefined;
  const r = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf-8', timeout: 10_000 });
  return r.status === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined;
})();

const HEARTBEAT = 'zz-slice1-heartbeat';
/** 每 100ms 往 cwd 下的心跳文件追加一行 */
const JS_HEARTBEAT = `import { appendFileSync } from 'node:fs';\nsetInterval(() => appendFileSync('${HEARTBEAT}', 'x\\n'), 100);\n`;
const PY_HEARTBEAT = `import time\nwhile True:\n    with open('${HEARTBEAT}', 'a') as f:\n        f.write('x\\n')\n    time.sleep(0.1)\n`;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 对 pid（负数为进程组）发 0 号信号只探测不打：存在返回 undefined，否则返回错误码 */
const probe = (target: number): string | undefined => {
  try {
    process.kill(target, 0);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
};

/** 轮询条件，ms 内成立返回 true */
const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
};

/** ms 内落定则返回结果，否则抛错：变异下 handler 要等脚本跑到超时，不让用例拖到那时 */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${ms}ms 内未落定`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Handler = RegisteredTool['handler'];

const SESSION = 'zz-slice1-session';

let root: string;
let workspace: string;
/** 经包装的 ProcessService 起过的进程 pid（= 进程组号），afterEach 收掉变异验证时停不掉的组 */
let pids: number[];

beforeEach(() => {
  // 取真实路径：macOS 的 tmpdir 在 /var 符号链接下，Seatbelt 按真实路径匹配可写目录
  root = realpathSync(mkdtempSync(join(tmpdir(), 'zz-slice1-code-')));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
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
  rmSync(root, { recursive: true, force: true });
});

const heartbeats = (): number => {
  const file = join(workspace, HEARTBEAT);
  return existsSync(file) ? readFileSync(file, 'utf-8').split('\n').length - 1 : 0;
};

/** workspace:/、tmp:/ 两个根映射到临时目录的本地 storage 替身，只实现 code-runner 与 makeTempDir 用到的方法 */
function localStorage(): StorageService {
  const toLocal = (uri: string): string => {
    const m = /^(workspace|tmp):\/(.*)$/.exec(uri);
    if (!m) throw new Error(`替身不认识的 URI: ${uri}`);
    return join(root, m[1], m[2]);
  };
  const rootInfo = (name: string) => ({
    name,
    kind: name,
    browsable: true,
    readable: true,
    writable: true,
    deletable: true,
  });
  return {
    listRoots: () => [rootInfo('workspace'), rootInfo('tmp')],
    resolveLocalPath: async (uri: string) => toLocal(uri),
    writeFile: async (uri: string, data: string | Buffer) => {
      const file = toLocal(uri);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    },
    delete: async (uri: string) => {
      rmSync(toLocal(uri), { recursive: true, force: true });
    },
  } as unknown as StorageService;
}

/** 真实 LocalProcessService，记下起过的 pid；execFile 经 this.spawn，同样被记下 */
class RecordingProcess extends LocalProcessService {
  override spawn(cmd: string, args: readonly string[], opts?: SpawnOptions): SpawnHandle {
    const handle = super.spawn(cmd, args, opts);
    // 只记真实子进程的 pid：afterEach 按负 pid 收组，0、1 会打到自己的进程组或全部进程
    if (handle.pid !== undefined && handle.pid > 1) pids.push(handle.pid);
    return handle;
  }
}

const view = <P>(instance: P) => [{ instance, contextId: 'zz-slice1', priority: 0 }];

/** 激活 code-runner，返回按名字取的 handler；不经 authority，直接调 handler */
async function applyRunner(opts: {
  mode: 'auto' | 'none';
  proc?: ProcessService;
  sandbox?: CodeSandboxService;
}): Promise<Record<string, Handler>> {
  const handlers: Record<string, Handler> = {};
  const storage = localStorage();
  await codeRunner.apply({
    tools: stubBoundTools({
      onRegister: t => {
        handlers[t.definition.function.name] = t.handler;
      },
    }),
    storage: ref(view(storage)),
    proc: ref(view(opts.proc ?? new RecordingProcess(storage))),
    codeSandbox: ref(opts.sandbox ? view(opts.sandbox) : []),
    logger: silentLogger(),
    config: {
      python: { enabled: true, interpreter: pythonPath ?? 'python3' },
      javascript: { enabled: true, interpreter: process.execPath },
      defaultTimeout: 30_000,
      maxTimeout: 60_000,
      maxOutputSize: 65_536,
      workingDirectory: 'workspace:/',
      sandbox: { mode: opts.mode, network: 'deny' },
    },
  });
  return handlers;
}

/** 激活真实 code-sandbox-os（后端按本机功能性探测），返回它提供的服务 */
async function applySandbox(proc: ProcessService): Promise<CodeSandboxService> {
  let provided: CodeSandboxService | undefined;
  const provide = ((_descriptor: unknown, implementation: CodeSandboxService) => {
    provided = implementation;
    return () => {};
  }) as unknown as Provide;
  await codeSandboxOs.apply({ processService: ref(view(proc)), logger: silentLogger(), provide });
  if (!provided) throw new Error('code-sandbox-os 没有提供服务');
  return provided;
}

async function call(handler: Handler, args: Record<string, unknown>, signal?: AbortSignal) {
  const out = await handler(args, { sessionId: SESSION, signal });
  return JSON.parse(typeof out === 'string' ? out : out.content) as Record<string, unknown>;
}

/**
 * 脚本写心跳时回合中止：3 秒内返回，之后再等 1 秒心跳文件不再增长。
 * `onlyAborted` 为 false 时（Linux bwrap：外层启动器可能自行处理 SIGTERM、以退出码结束）也接受 note 一支，心跳断言不放宽。
 */
async function expectStopsOnAbort(handler: Handler, code: string, onlyAborted = true): Promise<void> {
  const ac = new AbortController();
  const pending = call(handler, { code }, ac.signal);
  // 防空跑：脚本确实跑起来了、心跳在增长
  expect(await waitFor(() => heartbeats() >= 2, 10_000)).toBe(true);
  ac.abort();
  const res = await within(pending, 3000);
  if (onlyAborted || res.note === undefined) expect(res.aborted).toBe(true);
  else expect(res.note).toBe('回合已中止');
  expect(res.timedOut).toBeUndefined();
  const settled = heartbeats();
  await sleep(1000);
  expect(heartbeats()).toBe(settled);
}

describe('代码执行接住中止：无沙箱路径（POSIX，真实进程）', () => {
  it.skipIf(!posix)(
    '安全：run_javascript 运行中回合中止，3 秒内返回 aborted，心跳随即停止',
    { timeout: 30_000 },
    async () => {
      const { run_javascript } = await applyRunner({ mode: 'none' });
      await expectStopsOnAbort(run_javascript, JS_HEARTBEAT);
    },
  );

  it.skipIf(!posix || !pythonPath)(
    '安全：run_python 运行中回合中止，3 秒内返回 aborted，心跳随即停止',
    { timeout: 30_000 },
    async () => {
      const { run_python } = await applyRunner({ mode: 'none' });
      await expectStopsOnAbort(run_python, PY_HEARTBEAT);
    },
  );

  it.skipIf(!posix)('调用前回合已中止：返回 aborted，脚本没有运行', async () => {
    const { run_javascript } = await applyRunner({ mode: 'none' });
    const ac = new AbortController();
    ac.abort();
    const res = await within(call(run_javascript, { code: JS_HEARTBEAT }, ac.signal), 3000);
    expect(res).toMatchObject({ aborted: true, exitCode: -1 });
    expect(res.error).toBeUndefined();
    expect(pids).toEqual([]);
    await sleep(300);
    expect(heartbeats()).toBe(0);
  });
});

describe('代码执行接住中止：沙箱路径（真实 code-sandbox-os，POSIX）', () => {
  it.skipIf(!posix)('安全：run_javascript 运行中回合中止，3 秒内返回，心跳随即停止', { timeout: 30_000 }, async ctx => {
    const proc = new RecordingProcess(localStorage());
    const sandbox = await applySandbox(proc);
    if (!sandbox.available) ctx.skip(); // 本机没有沙箱后端
    const { run_javascript } = await applyRunner({ mode: 'auto', proc, sandbox });
    await expectStopsOnAbort(run_javascript, JS_HEARTBEAT, sandbox.backend !== 'bwrap');
  });

  it.skipIf(!posix || !pythonPath)(
    '安全：run_python 运行中回合中止，3 秒内返回，心跳随即停止',
    { timeout: 30_000 },
    async ctx => {
      const proc = new RecordingProcess(localStorage());
      const sandbox = await applySandbox(proc);
      if (!sandbox.available) ctx.skip();
      const { run_python } = await applyRunner({ mode: 'auto', proc, sandbox });
      await expectStopsOnAbort(run_python, PY_HEARTBEAT, sandbox.backend !== 'bwrap');
    },
  );
});

/** 替身沙箱：记下收到的请求，run 的行为由用例给 */
function fakeSandbox(run: (req: SandboxRunRequest) => Promise<ExecResult>): {
  service: CodeSandboxService;
  requests: SandboxRunRequest[];
} {
  const requests: SandboxRunRequest[] = [];
  return {
    requests,
    service: {
      available: true,
      backend: 'zz-slice1-fake',
      run: req => {
        requests.push(req);
        return run(req);
      },
    },
  };
}

describe('代码执行接住中止：替身沙箱', () => {
  it('安全：两个工具交给 code-sandbox 的 signal 就是调用方的 callCtx.signal', async () => {
    const fake = fakeSandbox(async () => ({ code: 0, signal: null, stdout: '', stderr: '' }));
    const { run_python, run_javascript } = await applyRunner({ mode: 'auto', sandbox: fake.service });
    const ac = new AbortController();
    await call(run_python, { code: 'print(1)' }, ac.signal);
    await call(run_javascript, { code: 'console.log(1)' }, ac.signal);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].signal).toBe(ac.signal);
    expect(fake.requests[1].signal).toBe(ac.signal);
  });

  it('脚本已正常退出、落定前回合中止：按实际退出回报并注明回合已中止，不报 aborted', async () => {
    const ac = new AbortController();
    const fake = fakeSandbox(async () => {
      ac.abort(); // 退出之后、落定之前中止到达
      return { code: 0, signal: null, stdout: 'zz-slice1-done\n', stderr: '' };
    });
    const { run_python } = await applyRunner({ mode: 'auto', sandbox: fake.service });
    const res = await call(run_python, { code: 'print(1)' }, ac.signal);
    expect(res.aborted).toBeUndefined();
    expect(res).toMatchObject({ exitCode: 0, stdout: 'zz-slice1-done\n', note: '回合已中止' });
  });

  it('中止后宽限到点被 SIGKILL 结束：报 aborted，不报 timedOut', async () => {
    const ac = new AbortController();
    const fake = fakeSandbox(async () => {
      ac.abort();
      const result: ExecResult = { code: null, signal: 'SIGKILL', stdout: '', stderr: '' };
      throw Object.assign(new Error('execFile 退出码 null (signal SIGKILL)'), { result });
    });
    const { run_javascript } = await applyRunner({ mode: 'auto', sandbox: fake.service });
    const res = await call(run_javascript, { code: 'for (;;) {}' }, ac.signal);
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBeUndefined();
  });
});
