import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeProcessProbe } from '../../packages/runtime/src/instance-lock.js';

// ════════════════════════════════════════════════════════════
// 实例锁的真实竞争：几个进程同时取同一个 run 目录的锁，每轮恰好一个拿到。
// 「删旧锁再建新锁」或不排他的写法在这里会让两个进程都拿到；按代号 link 的写法不会。
// 判活走真实的 pid、开机标识与进程启动标识。
// ════════════════════════════════════════════════════════════

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const contender = join(repoRoot, 'test', 'fixtures', 'lock-contender.ts');
const CONTENDERS = 4;

const children: ChildProcess[] = [];

/** 起 CONTENDERS 个参赛者，等都报 READY 后发令；都报了结果再收场。返回排序后的结果 */
async function race(runDir: string, dir: string): Promise<string[]> {
  const goFile = join(dir, 'go');
  const doneFile = join(dir, 'done');
  const results: Array<Promise<string>> = [];
  const ready: Array<Promise<void>> = [];
  for (let i = 0; i < CONTENDERS; i++) {
    const child = spawn(
      tsxBin,
      ['--tsconfig', join(repoRoot, 'tsconfig.test.json'), contender, runDir, goFile, doneFile],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    children.push(child);
    let out = '';
    let err = '';
    child.stderr?.on('data', d => {
      err += String(d);
    });
    const exited = new Promise<void>(r => child.on('close', () => r()));
    // 起不来或中途退出的参赛者不让测试干等：READY 前退出即失败，带上它的 stderr
    ready.push(
      new Promise((res, rej) => {
        child.stdout?.on('data', d => {
          out += String(d);
          if (out.includes('READY')) res();
        });
        void exited.then(() => rej(new Error(`参赛者在 READY 前退出：${err}`)));
      }),
    );
    results.push(
      new Promise((res, rej) => {
        child.stdout?.on('data', () => {
          const line = out.replace('READY\n', '').trim();
          if (line) res(line);
        });
        void exited.then(() => rej(new Error(`参赛者没报结果就退出：${err}`)));
      }),
    );
  }
  await Promise.all(ready);
  writeFileSync(goFile, '');
  const outcome = await Promise.all(results);
  writeFileSync(doneFile, '');
  return outcome.sort();
}

// 收场时按进程组 kill(-pid)，只在 POSIX 上可用
describe.skipIf(process.platform === 'win32')('实例锁：多个进程同时取锁', () => {
  const dirs: string[] = [];
  afterEach(() => {
    // 失败时也不留孤儿：按进程组杀掉（tsx 包装层另起了真正跑脚本的 node 子进程）
    for (const child of children.splice(0)) {
      try {
        if (child.pid && child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('空的 run 目录，连跑三轮：每轮恰好一个拿到', async () => {
    for (let round = 0; round < 3; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'aalis-lock-race-'));
      dirs.push(dir);
      expect(await race(join(dir, 'run'), dir), `第 ${round + 1} 轮`).toEqual(['BUSY', 'BUSY', 'BUSY', 'OK']);
    }
  }, 90_000);

  it('有残留锁（持有者已退出）时同时接管：仍然恰好一个拿到，残留的旧锁被清掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-lock-race-'));
    dirs.push(dir);
    const run = join(dir, 'run');
    mkdirSync(run);
    // 一个已经退出的进程的 pid
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf-8',
    });
    const bootId = nodeProcessProbe.bootId();
    writeFileSync(
      join(run, 'instance.1.lock'),
      JSON.stringify({ pid: Number(dead.stdout), ...(bootId ? { bootId } : {}), handoffHash: 'x' }),
    );
    expect(await race(run, dir)).toEqual(['BUSY', 'BUSY', 'BUSY', 'OK']);
    // 胜者取锁时就把残留的旧锁清掉了
    expect(readdirSync(run)).not.toContain('instance.1.lock');
  }, 60_000);
});
