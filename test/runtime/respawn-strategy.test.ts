import type { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProcessRespawnStrategy,
  createServiceRestartStrategy,
  type RestartRollback,
  SERVICE_RESTART_EXIT_CODE,
} from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// 进程重启策略的两条判据，此前只有源码文本测试（按文本切分支查 disarm），行为零覆盖：
// - 等 ready 超时按成功处理：不发 ready 的旧 runtime 必须仍能重启，不得因超时触发回滚；
// - 回滚的依赖重装必须看退出码：非 0 与信号终止（null）都不得宣告「已回滚」并拉起旧版进程。
// 子进程由 spawn 替身按脚本队列逐个出队（下一拍触发），process.exit 抛哨兵中止执行——
// 只 mock 不抛的话，执行会越过 exit 继续跑进回滚分支。
// ════════════════════════════════════════════════════════════

const spawned = vi.hoisted(() => ({
  calls: 0,
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
      const child = Object.assign(new EventEmitter(), { disconnect() {}, unref() {} });
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
    // 凭据不带 postRestore：带了的话，把超时误判成夭折的变异会拉起一个永不退出的重装进程，拖到用例超时才挂
    await expect(restart({ reason: 't', restore: [{ path: file, content: 'OLD' }] })).rejects.toMatchObject({
      code: 0,
    });
    expect(spawned.calls).toBe(1);
    // 新进程在启动时的 cwd 里起：命令行里相对的 --home 才解析到同一个家目录，不随重启时的 cwd 漂移
    expect(spawned.cwds).toEqual(['/launch-dir']);
    // 实例锁的交接令牌交给新进程：它凭这个接手旧实例的锁
    expect(spawned.handoffs).toEqual(['token']);
    expect(readFileSync(file, 'utf-8')).toBe('NEW');
  });

  it.each([1, null])('回滚重装退出码为 %s：报依赖重装失败并 exit(1)，不拉起旧版进程', async code => {
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
    // 只看 exit(1) 分不出来：重装被当成成功时拉起旧版那条路也是 exit(1)，区别在多出的第三次 spawn
    expect(spawned.calls).toBe(2);
    expect(readFileSync(file, 'utf-8')).toBe('OLD');
    expect(errors.join('\n')).toContain('依赖重装失败');
  });

  it('回滚成功后拉起的旧版进程同样拿到交接令牌与原有环境，在启动时的 cwd 里起', async () => {
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
});

describe('createServiceRestartStrategy', () => {
  it('停掉 App 后以服务重启的退出码结束，不自己拉起新进程；带回滚凭据时说明不会自动回滚', async () => {
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
    expect(errors.join('\n')).toContain('不会自动回滚（marketplace-update:@aalis/x）');
  });
});
