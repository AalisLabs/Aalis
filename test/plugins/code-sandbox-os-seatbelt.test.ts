import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSeatbeltArgs } from '../../packages/plugin-code-sandbox-os/src/sandbox.js';

// ════════════════════════════════════════════════════════════
// macOS 沙箱（Seatbelt）的规则用真实的 sandbox-exec 跑，命令经 buildSeatbeltArgs 包装，与 code_runner 同一条路径；只在 macOS 上测。
// - 信号只能发给同一沙箱里的进程：给沙箱外同一用户的进程（包括 Aalis 自己）发信号被拒，杀自己启动的子进程照常。
// ════════════════════════════════════════════════════════════

const darwin = process.platform === 'darwin';

/** 在沙箱里同步跑一条命令：断网、不给写目录，环境只留 PATH */
function sandboxed(cmd: string, args: string[]) {
  const wrapped = buildSeatbeltArgs({ fsRead: [], fsWrite: [], network: 'deny' }, cmd, args, { PATH: '/usr/bin:/bin' });
  return spawnSync(wrapped.cmd, wrapped.args, { encoding: 'utf-8' });
}

const outsiders: ChildProcess[] = [];
afterEach(() => {
  for (const child of outsiders.splice(0)) child.kill('SIGKILL');
});

describe.skipIf(!darwin)('Seatbelt 沙箱的信号范围', () => {
  it('给沙箱外的进程发 SIGTERM 被拒，那个进程不受影响', async () => {
    const outsider = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    outsiders.push(outsider);
    const exited = once(outsider, 'exit');
    const r = sandboxed('/bin/kill', ['-TERM', String(outsider.pid)]);
    expect(r.status, '沙箱里的 kill 应被拒').not.toBe(0);
    expect(r.stderr).toContain('Operation not permitted');
    // 由这里补一个 SIGKILL 收掉：它是被这个 SIGKILL 结束的，沙箱里发的 SIGTERM 没落到它身上
    outsider.kill('SIGKILL');
    expect(await exited).toEqual([null, 'SIGKILL']);
  });

  it('杀自己启动的子进程照常', () => {
    const r = sandboxed('/bin/sh', ['-c', 'sleep 30 & child=$!; kill -TERM "$child"; wait "$child"; echo "status=$?"']);
    // 被 SIGTERM 结束的子进程，wait 回报 128+15
    expect(r.stdout.trim()).toBe('status=143');
  });
});
