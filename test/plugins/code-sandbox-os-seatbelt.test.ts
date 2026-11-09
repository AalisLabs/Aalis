import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSeatbeltArgs } from '../../packages/plugin-code-sandbox-os/src/sandbox.js';

// ════════════════════════════════════════════════════════════
// macOS 沙箱（Seatbelt）的规则用真实的 sandbox-exec 跑，命令经 buildSeatbeltArgs 包装，与 code_runner 同一条路径；只在 macOS 上测。
// - 信号只能发给同一沙箱里的进程：给沙箱外同一用户的进程（包括 Aalis 自己）发信号被拒，杀自己启动的子进程照常。
// - POSIX 信号量按建它的进程放行：同一沙箱里建的照常用（Python 的 multiprocessing 父子进程共用 Queue），
//   沙箱外仍在运行的进程建的按名字打不开。
// - POSIX 共享内存不放行：沙箱外的进程建的按名字打不开，读不到、也改不了里面的内容。
// ════════════════════════════════════════════════════════════

const darwin = process.platform === 'darwin';
const python3 = darwin && spawnSync('python3', ['-c', 'pass'], { timeout: 10_000 }).status === 0;

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

describe.skipIf(!python3)('Seatbelt 沙箱的 POSIX 信号量', () => {
  it('Python 的 multiprocessing：父进程建的 Queue，子进程照常往里放', () => {
    // Queue 里的锁是 POSIX 信号量：父进程建，子进程按名字打开
    const script = [
      'import multiprocessing as mp',
      "if __name__ == '__main__':",
      '    q = mp.Queue()',
      "    p = mp.Process(target=q.put, args=('child',)); p.start(); print(q.get(timeout=5)); p.join(); print(p.exitcode)",
    ].join('\n');
    const r = sandboxed('python3', ['-I', '-c', script]);
    expect(r.stdout.trim().split('\n'), r.stderr).toEqual(['child', '0']);
  });

  it('沙箱外仍在运行的进程建的信号量，沙箱里按名字打不开', async () => {
    // 沙箱外的进程用 _multiprocessing 的底层接口建一个具名信号量，标准输入关闭时删掉它再退出
    const name = `/zz-sem-${process.pid}`;
    const holder = spawn(
      'python3',
      [
        '-I',
        '-c',
        `import _multiprocessing as m, sys; s = m.SemLock(1, 1, 1, '${name}', False); print('ready', flush=True); sys.stdin.read(); m.sem_unlink('${name}')`,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    outsiders.push(holder);
    const exited = once(holder, 'exit');
    await once(holder.stdout, 'data');
    const r = sandboxed('python3', [
      '-I',
      '-c',
      `import _multiprocessing as m; m.SemLock._rebuild(0, 1, 1, '${name}')`,
    ]);
    expect(r.stderr).toContain('PermissionError');
    holder.stdin.end();
    expect(await exited).toEqual([0, null]);
  });
});

describe.skipIf(!python3)('Seatbelt 沙箱的 POSIX 共享内存', () => {
  it('沙箱外的进程建的共享内存，沙箱里按名字打不开，里面的内容不变', async () => {
    // 沙箱外的进程建一块具名共享内存、写进 holder；标准输入关闭时读出内容、删掉名字再退出
    const name = `/zz-shm-${process.pid}`;
    const holder = spawn(
      'python3',
      [
        '-I',
        '-c',
        [
          'import _posixshmem, mmap, os, sys',
          `fd = _posixshmem.shm_open('${name}', os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600); os.ftruncate(fd, 16)`,
          "m = mmap.mmap(fd, 16); m[:6] = b'holder'; print('ready', flush=True)",
          `sys.stdin.read(); print(bytes(m[:6]).decode(), flush=True); _posixshmem.shm_unlink('${name}')`,
        ].join('\n'),
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    outsiders.push(holder);
    let out = '';
    holder.stdout.setEncoding('utf-8').on('data', chunk => {
      out += chunk;
    });
    const closed = once(holder, 'close');
    await once(holder.stdout, 'data');
    const r = sandboxed('python3', [
      '-I',
      '-c',
      `import _posixshmem, mmap, os; mmap.mmap(_posixshmem.shm_open('${name}', os.O_RDWR, 0), 16)[:6] = b'inside'`,
    ]);
    // 先让持有者读出内容、删掉名字再断言：断言失败也不留下这块共享内存
    holder.stdin.end();
    expect(await closed).toEqual([0, null]);
    expect(r.stderr).toContain('PermissionError');
    expect(out).toBe('ready\nholder\n');
  });
});
