import { describe, expect, it, vi } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { killAll, LocalProcessService } from '../../packages/plugin-process-local/src/index.js';

// ════════════════════════════════════════════════════════════
// 看门进程启动失败时，用户的子进程照常交出句柄。启动看门进程的 spawn 有两种失败：描述符耗尽（EMFILE、ENFILE）时 Node
// 返回一个没有 stdin 的子进程、异步发 'error'；EBADF 等其他错误码同步抛出。这时用户的子进程已启动、已登记，
// spawn() 再抛错的话调用方拿不到句柄，组号永留登记表。只替换启动看门进程的那次 spawn，用户的子进程照常真实启动。
// ════════════════════════════════════════════════════════════

const watchdog = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'no-stdin' | 'throw', lines: [] as string[] }));
vi.mock('node:child_process', async importOriginal => {
  const cp = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    ...cp,
    spawn: (cmd: string, args: string[], opts: import('node:child_process').SpawnOptions) => {
      if (args[2] !== 'aalis-process-watchdog') return cp.spawn(cmd, args, opts);
      if (watchdog.mode === 'throw') throw Object.assign(new Error('spawn EBADF'), { code: 'EBADF' });
      const child = Object.assign(new EventEmitter(), { stdin: null as unknown, unref() {} });
      if (watchdog.mode === 'no-stdin') {
        process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })));
        return child;
      }
      const stdin = Object.assign(new PassThrough(), { unref() {} });
      stdin.on('data', data => watchdog.lines.push(...String(data).trim().split('\n')));
      child.stdin = stdin;
      return child;
    },
  };
});

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('process-local 看门进程启动失败', () => {
  it.each([
    ['描述符耗尽，返回没有 stdin 的子进程', 'no-stdin'],
    ['同步抛错', 'throw'],
  ] as const)('%s：spawn() 照常交出句柄，子进程退出后撤登记', async (_, mode) => {
    watchdog.mode = mode;
    const svc = new LocalProcessService({} as unknown as StorageService);
    const handle = svc.spawn('sh', ['-c', 'echo hi']);
    expect(handle.pid).toBeTypeOf('number');
    expect(await handle.wait()).toMatchObject({ code: 0, stdout: 'hi\n' });
    const kill = vi.spyOn(process, 'kill');
    try {
      await killAll();
      expect(kill.mock.calls.filter(([target]) => target === -handle.pid!)).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it('启动失败之后，下一次登记再启动看门进程', async () => {
    watchdog.mode = 'no-stdin';
    const svc = new LocalProcessService({} as unknown as StorageService);
    const first = svc.spawn('sh', ['-c', 'exit 0']);
    await first.wait();
    watchdog.mode = 'ok';
    const second = svc.spawn('sh', ['-c', 'exit 0']);
    await second.wait();
    expect(watchdog.lines).toContain(`+${second.pid}`);
  });
});
