import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult, SpawnHandle, SpawnOptions } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { ABORT_KILL_GRACE_MS, LocalProcessService } from '../../packages/plugin-process-local/src/index.js';

// ════════════════════════════════════════════════════════════
// SpawnOptions.signal：中止在 process-local 一处实现，按进程组停干净。
//   - POSIX：对整组先 SIGTERM，宽限后组里还有成员就整组 SIGKILL；wait() 照常落定、execFile 按非零退出 reject；
//   - 已中止时 spawn 同步抛出 signal.reason，不创建子进程；
//   - 子进程退出或创建失败后不留监听，之后再中止不对任何进程（可能已被复用的进程组）发信号；
//   - Windows 没有进程组与优雅终止：趁根进程还活着立即 taskkill 整棵树，不起升级定时器。
// 起真实进程的用例只在 POSIX 跑；Windows 分支用替身子进程在任何平台跑，未在 Windows 真机实测。
// ════════════════════════════════════════════════════════════

const posix = process.platform !== 'win32';

// spawn/wait 不用 storage（仅 makeTempDir 用）；测试传空桩。
const proc = new LocalProcessService({} as unknown as StorageService);

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

/** ms 内落定则返回结果，否则抛错：变异下 wait() 永不落定，不让用例拖到 sleep 30 结束 */
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

interface Run {
  handle: SpawnHandle;
  pid: number;
  done: Promise<ExecResult>;
  settled: boolean;
}

const runs: Run[] = [];

/** 起进程并立刻挂上 wait()，记下是否落定，供 afterEach 收掉变异验证时停不掉的进程组 */
function start(cmd: string, args: string[], opts: SpawnOptions): Run {
  const handle = proc.spawn(cmd, args, opts);
  if (handle.pid === undefined) throw new Error(`${cmd} 没起来`);
  const run: Run = { handle, pid: handle.pid, done: handle.wait(), settled: false };
  run.done.then(
    () => {
      run.settled = true;
    },
    () => {
      run.settled = true;
    },
  );
  runs.push(run);
  return run;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const run of runs.splice(0)) if (!run.settled) run.handle.kill('SIGKILL');
});

describe('process-local 中止信号（POSIX，真实进程）', () => {
  it.skipIf(!posix)('中止后按进程组 SIGTERM：wait 3 秒内落定、signal 为 SIGTERM，进程已不存在', async () => {
    const ac = new AbortController();
    const run = start('/bin/sh', ['-c', 'sleep 30'], { signal: ac.signal });
    await sleep(100);
    ac.abort();
    const res = await within(run.done, 3000);
    expect(res.signal).toBe('SIGTERM');
    expect(probe(run.pid)).toBe('ESRCH');
  });

  it.skipIf(!posix)('孙进程同死：中止后 3 秒内整个进程组不存在，孙进程收到的是 SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zz-slice1-abort-'));
    try {
      // 孙进程（后台子 shell）收到 SIGTERM 就写标记：只打直接子进程的话，孙进程要等宽限后的 SIGKILL，
      // 同样在 3 秒内消失，只看组空分不出来
      const marker = join(dir, 'zz-slice1-term');
      const ac = new AbortController();
      const run = start('sh', ['-c', '(trap \'touch "$0"; exit 0\' TERM; sleep 30 & wait) & sleep 30', marker], {
        signal: ac.signal,
      });
      await sleep(150);
      expect(probe(-run.pid)).toBeUndefined(); // 防空跑：进程组确实起来了
      ac.abort();
      expect(await waitFor(() => probe(-run.pid) === 'ESRCH', 3000)).toBe(true);
      await within(run.done, 3000);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix)('忽略 SIGTERM 的进程组：宽限后整组 SIGKILL，wait 从中止到落定小于 4 秒', async () => {
    const ac = new AbortController();
    const run = start('sh', ['-c', 'trap "" TERM; sleep 30'], { signal: ac.signal });
    await sleep(150);
    const abortedAt = Date.now();
    const settledAt = run.done.then(() => Date.now());
    ac.abort();
    await sleep(500);
    expect(probe(-run.pid)).toBeUndefined(); // SIGTERM 被忽略，组还在
    expect(await waitFor(() => probe(-run.pid) === 'ESRCH', ABORT_KILL_GRACE_MS + 2000 - 500)).toBe(true);
    // 中止宽限加 close 收尾宽限须明显小于 core 默认停机宽限 5000ms，否则随 lifecycle.signal 中止的停用仍会超时
    expect((await within(settledAt, 4000)) - abortedAt).toBeLessThan(4000);
  });

  it.skipIf(!posix)('已中止时 spawn 同步抛出 signal.reason，命令没有执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zz-slice1-abort-'));
    try {
      const marker = join(dir, 'zz-slice1-marker');
      const ac = new AbortController();
      ac.abort();
      let thrown: unknown;
      try {
        start('touch', [marker], { signal: ac.signal });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBe(ac.signal.reason);
      expect((thrown as Error).name).toBe('AbortError');
      await sleep(300);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix)('进程正常退出后再中止：不对它的进程组发信号', async () => {
    const ac = new AbortController();
    const run = start('true', [], { signal: ac.signal });
    const res = await within(run.done, 3000);
    expect(res.code).toBe(0);
    const kill = vi.spyOn(process, 'kill');
    ac.abort();
    await sleep(50);
    // 按目标过滤：前面用例的升级定时器到点时会探测它们自己的进程组
    expect(kill.mock.calls.filter(([target]) => target === -run.pid || target === run.pid)).toEqual([]);
  });

  it.skipIf(!posix)('execFile 带 signal：中止后按非零退出 reject，result.signal 为 SIGTERM', async () => {
    const ac = new AbortController();
    const pending = proc.execFile('sh', ['-c', 'sleep 30'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const err = (await within(
      pending.then(
        () => undefined,
        (e: unknown) => e,
      ),
      3000,
    )) as (Error & { result?: ExecResult }) | undefined;
    expect(err).toBeInstanceOf(Error);
    expect(err?.result?.signal).toBe('SIGTERM');
  });

  it.skipIf(!posix)('命令不存在：error 落定后 signal 上不留 abort 监听，之后中止不报错', async () => {
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, 'addEventListener');
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    const handle = proc.spawn('zz-slice1-no-such-cmd', [], { signal: ac.signal });
    await expect(handle.wait()).rejects.toMatchObject({ code: 'ENOENT' });
    const count = (calls: unknown[][]): number => calls.filter(([type]) => type === 'abort').length;
    expect(count(add.mock.calls) - count(remove.mock.calls)).toBe(0);
    expect(() => ac.abort()).not.toThrow();
  });
});

describe('process-local 中止信号（Windows 分支，替身子进程）', () => {
  it('中止时趁根进程还活着立即 taskkill 整棵树：不先发 SIGTERM，不起升级定时器', async () => {
    const pid = 4242;
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdin: null,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true),
      unref() {},
    });
    // 本机不是 Windows：任何对真实 pid 的信号都可能打到无关进程，一律拦下
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      spawn: (cmd: string, args: string[]) => {
        spawned.push({ cmd, args });
        return cmd === 'taskkill' ? Object.assign(new EventEmitter(), { unref() {} }) : child;
      },
    }));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    let mod: typeof import('../../packages/plugin-process-local/src/index.js');
    try {
      // 平台判断在模块求值时取定，导入完即可还原
      mod = await import('../../packages/plugin-process-local/src/index.js');
    } finally {
      Object.defineProperty(process, 'platform', platform);
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
    vi.useFakeTimers();
    try {
      const svc = new mod.LocalProcessService({} as unknown as StorageService);
      const ac = new AbortController();
      const handle = svc.spawn('cmd', ['/c', 'ping -n 30 127.0.0.1'], { signal: ac.signal });
      const waiting = handle.wait();
      ac.abort();
      const taskkills = (): string[][] => spawned.filter(s => s.cmd === 'taskkill').map(s => s.args);
      // 替身子进程此时还没发 'exit'：taskkill 发生在根进程退出之前
      expect(taskkills()).toEqual([['/PID', String(pid), '/T', '/F']]);
      expect(child.kill).not.toHaveBeenCalled();
      child.emit('exit', 1, null);
      vi.advanceTimersByTime(mod.ABORT_KILL_GRACE_MS + 1000);
      expect(taskkills()).toHaveLength(1);
      child.emit('close', 1, null);
      await expect(waiting).resolves.toMatchObject({ code: 1, signal: null });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
