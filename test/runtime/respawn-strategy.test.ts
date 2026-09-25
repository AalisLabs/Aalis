import type { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProcessRespawnStrategy, type RestartRollback } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// 进程重启策略的两条判据，此前只有源码文本测试（按文本切分支查 disarm），行为零覆盖：
// - 等 ready 超时按成功处理：不发 ready 的旧 runtime 必须仍能重启，不得因超时触发回滚；
// - 回滚的依赖重装必须看退出码：非 0 与信号终止（null）都不得宣告「已回滚」并拉起旧版进程。
// 子进程由 spawn 替身按脚本队列逐个出队（下一拍触发），process.exit 抛哨兵中止执行——
// 只 mock 不抛的话，执行会越过 exit 继续跑进回滚分支。
// ════════════════════════════════════════════════════════════

const spawned = vi.hoisted(() => ({ calls: 0, scripts: [] as Array<(child: EventEmitter) => void> }));
vi.mock('node:child_process', async importOriginal => {
  const cp = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...cp,
    spawn: () => {
      spawned.calls++;
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
  const strategy = createProcessRespawnStrategy({ readyTimeoutMs: 10 });
  return (async () => strategy.restart({ stop: async () => {}, rollback }))();
}

describe('createProcessRespawnStrategy', () => {
  it('子进程不发 ready 也不退出：超时按成功处理，exit(0)，不回滚', async () => {
    // 凭据不带 postRestore：带了的话，把超时误判成夭折的变异会拉起一个永不退出的重装进程，拖到用例超时才挂
    await expect(restart({ reason: 't', restore: [{ path: file, content: 'OLD' }] })).rejects.toMatchObject({
      code: 0,
    });
    expect(spawned.calls).toBe(1);
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
});
