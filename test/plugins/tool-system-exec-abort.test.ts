import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessService } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import type { LifecycleCap } from '../../packages/core/src/index.js';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';
import { registerShellTools } from '../../packages/plugin-tool-system/src/tools/shell.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// exec 接住回合中止：停止键停掉正在跑的命令，回合随即结束。
//   - exec 把 callCtx.signal 交给 process 服务（按进程组停干净，见 process-local-abort.test.ts）；
//   - 被信号结束的才报「命令已随回合中止」；中止前已正常退出的按实际退出回报、注明回合已中止，
//     免得下一轮把已经生效的命令再跑一遍；
//   - exec_background 的后台进程不随回合中止（owner 改判时反转对应用例）。
// 起真实进程的用例只在 POSIX 跑。
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

/** 轮询条件，ms 内成立返回 true */
const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
};

/** ms 内落定则返回结果，否则抛错：变异下 handler 要等命令跑完，不让用例拖到 sleep 结束 */
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

let dir: string;
/** 经包装的 ProcessService 起过的进程 pid（= 进程组号），afterEach 收掉变异验证时停不掉的组 */
let pids: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zz-slice1-exec-'));
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

/** 注册 shell 工具组，返回按名字取的 handler；storage 替身把任何 cwd 解析到临时目录，直接调 handler、不经 authority */
function register(proc: ProcessService): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const tools = stubBoundTools({
    onRegister: t => {
      handlers[t.definition.function.name] = t.handler;
    },
  });
  registerShellTools(tools, {
    logger: silentLogger(),
    lifecycle: { onDispose: () => () => {} } as unknown as LifecycleCap,
    cwdUri: 'workspace:/',
    proc,
    storage: { resolveLocalPath: async () => dir } as unknown as StorageService,
    defaultTimeout: 30000,
    maxTimeout: 300000,
    maxOutputSize: 65536,
  });
  return handlers;
}

/** 真实 LocalProcessService 外包一层，记下起过的 pid */
function recordingProcess(): ProcessService {
  const inner = new LocalProcessService({} as unknown as StorageService);
  return {
    spawn: (cmd, args, opts) => {
      const handle = inner.spawn(cmd, args, opts);
      // 只记真实子进程的 pid：afterEach 按负 pid 收组，0、1 会打到自己的进程组或全部进程
      if (handle.pid !== undefined && handle.pid > 1) pids.push(handle.pid);
      return handle;
    },
    execFile: (cmd, args, opts) => inner.execFile(cmd, args, opts),
    makeTempDir: prefix => inner.makeTempDir(prefix),
    readExternalFile: (path, maxBytes) => inner.readExternalFile(path, maxBytes),
  };
}

async function call(handler: Handler, args: Record<string, unknown>, signal?: AbortSignal) {
  const out = await handler(args, { sessionId: SESSION, signal });
  return JSON.parse(typeof out === 'string' ? out : out.content) as Record<string, unknown>;
}

describe('exec 接住回合中止（POSIX，真实进程）', () => {
  it.skipIf(!posix)('安全：命令运行中回合中止，3 秒内返回 aborted，命令的进程已不存在', async () => {
    const { exec } = register(recordingProcess());
    const ac = new AbortController();
    const pending = call(exec, { command: 'sleep 120' }, ac.signal);
    await sleep(200);
    expect(pids).toHaveLength(1);
    expect(probe(pids[0])).toBeUndefined(); // 防空跑：命令确实在跑
    ac.abort();
    const res = await within(pending, 3000);
    expect(res).toMatchObject({ aborted: true, message: '命令已随回合中止' });
    expect(res.timedOut).toBeUndefined();
    expect(probe(pids[0])).toBe('ESRCH');
    expect(probe(-pids[0])).toBe('ESRCH');
  });

  it.skipIf(!posix)('回归：带信号未中止时正常返回退出码与输出', async () => {
    const { exec } = register(recordingProcess());
    const ac = new AbortController();
    const res = await within(call(exec, { command: 'echo zz-slice1-placeholder' }, ac.signal), 3000);
    expect(res).toEqual({ exitCode: 0, stdout: 'zz-slice1-placeholder\n', stderr: '' });
  });

  it.skipIf(!posix)('调用前回合已中止：返回 aborted，没有起进程', async () => {
    const { exec } = register(recordingProcess());
    const marker = join(dir, 'zz-slice1-marker');
    const ac = new AbortController();
    ac.abort();
    const res = await within(call(exec, { command: `touch '${marker}'` }, ac.signal), 3000);
    expect(res).toMatchObject({ aborted: true });
    expect(pids).toEqual([]);
    await sleep(300);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(!posix)('exec_background 起的进程不随回合中止，process_kill 能收掉', async () => {
    const { exec_background, process_kill } = register(recordingProcess());
    const ac = new AbortController();
    const started = await call(exec_background, { command: 'sleep 30' }, ac.signal);
    const pid = started.pid as number;
    expect(pids).toEqual([pid]);
    ac.abort();
    await sleep(500);
    expect(probe(pid)).toBeUndefined(); // 回合中止后仍在跑
    const killed = await call(process_kill, { processId: started.processId });
    expect(killed.error).toBeUndefined();
    expect(await waitFor(() => probe(-pid) === 'ESRCH', 3000)).toBe(true);
  });
});

describe('exec 接住回合中止（替身进程）', () => {
  it('安全：命令已正常退出、wait 落定前回合中止：按实际退出回报并注明回合已中止，不报 aborted', async () => {
    const ac = new AbortController();
    const fake: ProcessService = {
      spawn: () => ({
        pid: undefined,
        stdin: null,
        stdout: null,
        stderr: null,
        wait: async () => {
          ac.abort(); // 退出之后、落定之前（如孙进程占着管道的收尾窗口）中止到达
          return { code: 0, signal: null, stdout: 'zz-slice1-done\n', stderr: '' };
        },
        kill: () => false,
        unref: () => {},
      }),
      execFile: async () => {
        throw new Error('exec 不该调 execFile');
      },
      makeTempDir: async () => {
        throw new Error('exec 不该建临时目录');
      },
      readExternalFile: async () => {
        throw new Error('exec 不该读外部文件');
      },
    };
    const { exec } = register(fake);
    const res = await call(exec, { command: 'git push' }, ac.signal);
    expect(res.aborted).toBeUndefined();
    expect(res).toMatchObject({ exitCode: 0, stdout: 'zz-slice1-done\n', note: '回合已中止' });
  });
});
