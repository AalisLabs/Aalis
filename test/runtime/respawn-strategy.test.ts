import type { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestartRollback } from '../../packages/api-host-restart/src/index.js';
import {
  createProcessRespawnStrategy,
  createServiceRestartStrategy,
  READY_MESSAGE,
  SERVICE_RESTART_EXIT_CODE,
} from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// 进程重启策略的判据：
// - 新进程报就绪即放手退出，退出前不碰终端（它已归新进程）；
// - 等 ready 超时按成功处理：不发 ready 的旧 runtime 必须仍能重启，不得因超时触发回滚；
// - 回滚的依赖重装必须看退出码：非 0 与信号终止（null）都不得宣告「已回滚」并重新启动旧版进程。
// 子进程由 spawn 替身按脚本队列逐个出队（下一拍触发），process.exit 抛哨兵中止执行——
// 只 mock 不抛的话，执行会越过 exit 继续跑进回滚分支。
// ════════════════════════════════════════════════════════════

const spawned = vi.hoisted(() => ({
  calls: 0,
  kills: 0,
  pid: undefined as number | undefined,
  cwds: [] as Array<string | undefined>,
  handoffs: [] as Array<string | undefined>,
  paths: [] as Array<string | undefined>,
  scripts: [] as Array<(child: EventEmitter) => void>,
}));
vi.mock('node:child_process', async importOriginal => {
  const cp = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...cp,
    spawn: (_cmd: string, _args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => {
      spawned.calls++;
      spawned.cwds.push(opts?.cwd);
      spawned.handoffs.push(opts?.env?.AALIS_LOCK_HANDOFF);
      spawned.paths.push(opts?.env?.PATH);
      const child = Object.assign(new EventEmitter(), {
        pid: spawned.pid,
        disconnect() {},
        unref() {},
        kill() {
          spawned.kills++;
        },
      });
      const script = spawned.scripts.shift();
      if (script) setImmediate(() => script(child));
      return child;
    },
  };
});

class Exit extends Error {
  constructor(readonly code: string | number | null | undefined) {
    super(`process.exit(${code})`);
  }
}

let dir: string;
let file: string;
let errors: string[];

beforeEach(() => {
  spawned.calls = 0;
  spawned.kills = 0;
  spawned.pid = undefined;
  spawned.cwds = [];
  spawned.handoffs = [];
  spawned.paths = [];
  spawned.scripts = [];
  dir = mkdtempSync(join(tmpdir(), 'aalis-respawn-'));
  file = join(dir, 'package.json');
  writeFileSync(file, 'NEW');
  errors = [];
  vi.spyOn(process, 'exit').mockImplementation(code => {
    throw new Exit(code);
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function restart(rollback: RestartRollback): Promise<void> {
  const strategy = createProcessRespawnStrategy({
    appDir: '/nonexistent-app',
    cwd: '/launch-dir',
    env: { AALIS_LOCK_HANDOFF: 'token' },
    readyTimeoutMs: 10,
  });
  return (async () => strategy.restart({ stop: async () => {}, rollback }))();
}

describe('createProcessRespawnStrategy', () => {
  it('子进程不发 ready 也不退出：超时按成功处理，exit(0)，不回滚', async () => {
    // 凭据不带 postRestore：带了的话，把超时误判成夭折的变异会启动一个永不退出的重装子进程，拖到用例超时才失败
    await expect(restart({ reason: 't', restore: [{ path: file, content: 'OLD' }] })).rejects.toMatchObject({
      code: 0,
    });
    expect(spawned.calls).toBe(1);
    // 新进程在启动时的 cwd 里运行：命令行里相对的 --data 才解析到同一个数据目录，不随重启时的 cwd 漂移
    expect(spawned.cwds).toEqual(['/launch-dir']);
    // 实例锁的交接令牌交给新进程：它凭这个接手旧实例的锁
    expect(spawned.handoffs).toEqual(['token']);
    expect(readFileSync(file, 'utf-8')).toBe('NEW');
  });

  // 新进程的终端界面在报就绪之前已进备用屏：父进程放手退出时再往终端写复原序列，会把它踢出备用屏
  it('新进程报就绪：放手 exit(0)，退出前不往终端写东西，也不留退出时才跑的钩子', async () => {
    spawned.scripts.push(child => child.emit('message', { type: READY_MESSAGE }));
    const exitHooks = process.listeners('exit').length;
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    await expect(restart({ reason: 't', restore: [] })).rejects.toMatchObject({ code: 0 });
    expect(spawned.calls).toBe(1);
    expect(writes).toEqual([]);
    expect(process.listeners('exit')).toHaveLength(exitHooks);
  });

  it.each([1, null])('回滚重装退出码为 %s：报依赖重装失败并 exit(1)，不再启动旧版进程', async code => {
    spawned.scripts.push(
      child => child.emit('exit', 1), // 新进程在 ready 前夭折
      child => child.emit('exit', code), // postRestore 重装
    );
    await expect(
      restart({
        reason: 't',
        restore: [{ path: file, content: 'OLD' }],
        postRestore: { cmd: 'npm', args: ['i'], cwd: '/' },
      }),
    ).rejects.toMatchObject({ code: 1 });
    // 只看 exit(1) 分不出来：重装被当成成功时启动旧版进程那条路也是 exit(1)，区别在多出的第三次 spawn
    expect(spawned.calls).toBe(2);
    expect(readFileSync(file, 'utf-8')).toBe('OLD');
    expect(errors.join('\n')).toContain('reinstalling dependencies failed');
  });

  it('回滚成功后重新启动的旧版进程同样拿到交接令牌与原有环境，在启动时的 cwd 里运行', async () => {
    spawned.scripts.push(
      child => child.emit('exit', 1), // 新进程在 ready 前夭折
      child => child.emit('exit', 0), // postRestore 重装成功
    );
    await expect(
      restart({
        reason: 't',
        restore: [{ path: file, content: 'OLD' }],
        postRestore: { cmd: 'npm', args: ['i'], cwd: '/' },
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(spawned.calls).toBe(3);
    // 第二次是重装命令，不是 Aalis 实例，不带令牌
    expect(spawned.handoffs).toEqual(['token', undefined, 'token']);
    expect(spawned.paths[2]).toBe(process.env.PATH);
    expect(spawned.cwds[2]).toBe('/launch-dir');
  });

  it('停机途中宿主因终止信号发起了停机：停完不再启动新进程，也不自行退出', async () => {
    const terminating = new AbortController();
    const strategy = createProcessRespawnStrategy({
      appDir: '/nonexistent-app',
      cwd: '/launch-dir',
      readyTimeoutMs: 10,
      signal: terminating.signal,
    });
    await strategy.restart({ stop: async () => terminating.abort() });
    expect(spawned.calls).toBe(0);
  });

  // 替身进程缺省没有 pid，让它停下走的是 child.kill() 那一支（见下一条）；这里给它一个，看按进程组发的那一支
  it.skipIf(process.platform === 'win32')(
    '新进程有 pid 时让它停下：向它的进程组发 SIGTERM（开发模式下组里还有包装层），不只发给它自己',
    async () => {
      const signals: unknown[][] = [];
      vi.spyOn(process, 'kill').mockImplementation((...args: unknown[]) => {
        signals.push(args);
        return true;
      });
      spawned.pid = 4242;
      const terminating = new AbortController();
      const strategy = createProcessRespawnStrategy({
        appDir: '/nonexistent-app',
        cwd: '/launch-dir',
        readyTimeoutMs: 5000,
        signal: terminating.signal,
      });
      spawned.scripts.push(() => terminating.abort());
      await strategy.restart({ stop: async () => {} });
      expect(signals).toEqual([[-4242, 'SIGTERM']]);
      expect(spawned.kills).toBe(0);
    },
  );

  it('新进程在就绪前退出之后才来终止信号（回滚重装途中）：不再向已退出的新进程发信号', async () => {
    const terminating = new AbortController();
    const strategy = createProcessRespawnStrategy({
      appDir: '/nonexistent-app',
      cwd: '/launch-dir',
      readyTimeoutMs: 5000,
      signal: terminating.signal,
    });
    spawned.scripts.push(
      child => child.emit('exit', 1), // 新进程在 ready 前夭折
      child => {
        terminating.abort(); // 重装途中终止信号到
        child.emit('exit', 0);
      },
    );
    const restarting = (async () =>
      strategy.restart({
        stop: async () => {},
        rollback: {
          reason: 't',
          restore: [{ path: file, content: 'OLD' }],
          postRestore: { cmd: 'npm', args: ['i'], cwd: '/' },
        },
      }))();
    await expect(restarting).rejects.toMatchObject({ code: 1 });
    expect(spawned.kills).toBe(0);
  });

  it('新进程已启动、还没报就绪时宿主因终止信号发起了停机：让新进程停下，不等它就绪、不回滚、不自行退出；带回滚凭据时说明一句', async () => {
    const terminating = new AbortController();
    const strategy = createProcessRespawnStrategy({
      appDir: '/nonexistent-app',
      cwd: '/launch-dir',
      readyTimeoutMs: 5000,
      signal: terminating.signal,
    });
    // 新进程启动后一直不报就绪；下一拍终止信号到
    spawned.scripts.push(() => terminating.abort());
    await strategy.restart({
      stop: async () => {},
      rollback: { reason: 'marketplace-update:@aalis/x', restore: [{ path: file, content: 'OLD' }] },
    });
    expect(spawned.calls).toBe(1);
    expect(spawned.kills).toBe(1);
    expect(readFileSync(file, 'utf-8')).toBe('NEW');
    expect(errors.join('\n')).toContain('not rolled back automatically (marketplace-update:@aalis/x)');
  });

  it('重启还在进行时再调一次：忽略并说明一句，只停一次、只启动一个新进程', async () => {
    const strategy = createProcessRespawnStrategy({
      appDir: '/nonexistent-app',
      cwd: '/launch-dir',
      readyTimeoutMs: 10,
    });
    let stops = 0;
    const opts = { stop: async () => void stops++ };
    const first = Promise.resolve(strategy.restart(opts));
    await strategy.restart(opts);
    await expect(first).rejects.toMatchObject({ code: 0 });
    expect(stops).toBe(1);
    expect(spawned.calls).toBe(1);
    expect(errors.filter(line => line.includes('already in progress'))).toHaveLength(1);
  });
});

describe('createServiceRestartStrategy', () => {
  it('停掉 App 后以服务重启的退出码结束，不自行启动新进程；带回滚凭据时说明不会自动回滚', async () => {
    let stopped = false;
    const strategy = createServiceRestartStrategy();
    await expect(
      strategy.restart({
        stop: async () => {
          stopped = true;
        },
        rollback: { reason: 'marketplace-update:@aalis/x', restore: [] } satisfies RestartRollback,
      }),
    ).rejects.toMatchObject({ code: SERVICE_RESTART_EXIT_CODE });
    expect(SERVICE_RESTART_EXIT_CODE).toBe(75);
    expect(stopped).toBe(true);
    expect(spawned.calls).toBe(0);
    expect(errors.join('\n')).toContain('not rolled back automatically (marketplace-update:@aalis/x)');
  });

  it('重启还在进行时再调一次：忽略并说明一句，只停一次', async () => {
    const strategy = createServiceRestartStrategy();
    let stops = 0;
    const opts = { stop: async () => void stops++ };
    const first = Promise.resolve(strategy.restart(opts));
    await strategy.restart(opts);
    await expect(first).rejects.toMatchObject({ code: SERVICE_RESTART_EXIT_CODE });
    expect(stops).toBe(1);
    expect(errors.filter(line => line.includes('already in progress'))).toHaveLength(1);
  });

  it('退出前等宿主的收尾落定（文件日志写完），再以服务重启的退出码结束', async () => {
    const order: string[] = [];
    const strategy = createServiceRestartStrategy({
      beforeExit: async () => {
        await new Promise<void>(r => setImmediate(r));
        order.push('收尾');
      },
    });
    await expect(strategy.restart({ stop: async () => void order.push('停机') })).rejects.toMatchObject({
      code: SERVICE_RESTART_EXIT_CODE,
    });
    expect(order).toEqual(['停机', '收尾']);
  });

  it.each([
    ['停机途中', 'stop'],
    ['等退出前的收尾期间', 'beforeExit'],
  ] as const)('%s宿主因终止信号发起了停机：不以服务重启的退出码抢先退出', async (_label, at) => {
    const terminating = new AbortController();
    const strategy = createServiceRestartStrategy({
      signal: terminating.signal,
      beforeExit: async () => {
        if (at === 'beforeExit') terminating.abort();
      },
    });
    await strategy.restart({
      stop: async () => {
        if (at === 'stop') terminating.abort();
      },
    });
  });

  it('退出前的收尾被拒：记一条后照样以服务重启的退出码结束', async () => {
    const strategy = createServiceRestartStrategy({
      beforeExit: async () => {
        throw new Error('flush failed');
      },
    });
    await expect(strategy.restart({ stop: async () => {} })).rejects.toMatchObject({ code: SERVICE_RESTART_EXIT_CODE });
    expect(errors.join('\n')).toContain('flush failed');
  });
});
