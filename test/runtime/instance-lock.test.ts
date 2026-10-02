import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireInstanceLock,
  type LockHolder,
  nodeProcessProbe,
  type ProcessProbe,
} from '../../packages/runtime/src/instance-lock.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime — 实例锁
//
// 同一家目录只许一个实例：锁是 run/instance.<n>.lock，代号最大的是现行锁，取锁 = link 出下一个代号，
// link 之后更低代号里还有活的持有者就让出。判活只用与墙上时钟无关的标识：开机标识、pid 命名空间、
// pid 与进程启动标识。respawn 凭令牌接手；释放只删内容仍是自己那份的锁。进程状态用替身给出。
// ════════════════════════════════════════════════════════════

const BOOT = 'boot-a';
const SELF = 100;

/** alive：pid → 启动标识（undefined 表示查不了启动标识） */
function probe(alive: Record<number, string | undefined> = {}, over: Partial<ProcessProbe> = {}): ProcessProbe {
  return {
    pid: SELF,
    now: () => Date.now(),
    bootId: () => BOOT,
    pidNs: () => undefined,
    exists: pid => pid in alive,
    startId: pid => alive[pid],
    ...over,
  };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const holder = (over: Partial<LockHolder> = {}): LockHolder => ({
  pid: 200,
  startId: 'start-200',
  bootId: BOOT,
  handoffHash: sha256('other'),
  ...over,
});

describe('acquireInstanceLock', () => {
  let run: string;
  beforeEach(() => {
    run = mkdtempSync(join(tmpdir(), 'aalis-lock-'));
  });
  afterEach(() => {
    chmodSync(run, 0o700);
    rmSync(run, { recursive: true, force: true });
  });
  const writeLock = (n: number, h: LockHolder | string) =>
    writeFileSync(join(run, `instance.${n}.lock`), typeof h === 'string' ? h : JSON.stringify(h));
  const files = () => readdirSync(run).sort();

  it('没有锁时取第 1 代：内容完整、0600，不留临时文件；release 删掉它，重复调用无害', () => {
    const r = acquireInstanceLock(run, { probe: probe({ [SELF]: 'start-self' }) });
    if (!r.ok) throw new Error('应取到锁');
    expect(files()).toEqual(['instance.1.lock']);
    expect(JSON.parse(readFileSync(r.lock.file, 'utf-8'))).toEqual({
      pid: SELF,
      startId: 'start-self',
      bootId: BOOT,
      handoffHash: sha256(r.lock.handoffToken),
    });
    expect(statSync(r.lock.file).mode & 0o777).toBe(0o600);
    r.lock.release();
    r.lock.release();
    expect(files()).toEqual([]);
  });

  it('持有者活着（pid 在、启动标识相同）：报占用并给出持有者，不动现有文件', () => {
    writeLock(3, holder());
    const r = acquireInstanceLock(run, { probe: probe({ 200: 'start-200' }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.holder.pid).toBe(200);
    expect(r.file).toBe(join(run, 'instance.3.lock'));
    expect(files()).toEqual(['instance.3.lock']);
  });

  it.each([
    ['查不了启动标识（Windows、没有 ps）时只看 pid', holder(), { 200: undefined }, {}],
    ['锁里没记启动标识时只看 pid', holder({ startId: undefined }), { 200: 'whatever' }, {}],
    ['本机查不了开机标识时不比开机标识', holder(), { 200: 'start-200' }, { bootId: () => undefined }],
    [
      '同一次开机里另一个 pid 命名空间（另一个容器，或容器被强杀后重启）的锁判不了，按占用处理',
      holder({ pidNs: 'pid:[1]' }),
      {},
      { pidNs: () => 'pid:[2]' },
    ],
  ])('%s', (_label, h, alive, over) => {
    writeLock(1, h);
    expect(acquireInstanceLock(run, { probe: probe(alive, over) }).ok).toBe(false);
  });

  it.each([
    ['pid 已不在', holder(), {}],
    ['开机标识不同（机器重启过，pid 可能被无关进程占用）', holder({ bootId: 'boot-old' }), { 200: 'start-200' }],
    ['pid 在但启动标识不同（pid 被复用）', holder(), { 200: 'start-other' }],
    [
      '锁里记的是本进程的 pid，且查不了启动标识（上一个用这个 pid 的进程留下的）',
      holder({ pid: SELF }),
      { [SELF]: undefined },
    ],
  ])('残留：%s → 取下一代并删掉旧的', (_label, h, alive) => {
    writeLock(4, h);
    const r = acquireInstanceLock(run, { probe: probe(alive) });
    expect(r.ok).toBe(true);
    expect(files()).toEqual(['instance.5.lock']);
  });

  it('开机标识不同时不看 pid 命名空间：主机重启后，容器里留下的锁按残留接手', () => {
    writeLock(4, holder({ bootId: 'boot-old', pidNs: 'pid:[1]' }));
    const r = acquireInstanceLock(run, { probe: probe({ 200: 'start-200' }, { pidNs: () => 'pid:[2]' }) });
    expect(r.ok).toBe(true);
    expect(files()).toEqual(['instance.5.lock']);
  });

  it('锁文件内容坏了按残留处理', () => {
    writeLock(2, '{"pid":');
    expect(acquireInstanceLock(run, { probe: probe() }).ok).toBe(true);
    expect(files()).toEqual(['instance.3.lock']);
  });

  // 下面两条靠权限位制造读不了、写不进：root 不受权限位限制，Windows 的 chmod 只切换只读属性
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '锁文件读不了（权限）不猜它是残留：报错，不建新锁',
    () => {
      writeLock(2, holder());
      chmodSync(join(run, 'instance.2.lock'), 0o000);
      expect(() => acquireInstanceLock(run, { probe: probe() })).toThrow(/读不了锁文件/);
      chmodSync(join(run, 'instance.2.lock'), 0o600);
      expect(files()).toEqual(['instance.2.lock']);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('run 目录写不进去时报错，说明原因', () => {
    chmodSync(run, 0o500);
    expect(() => acquireInstanceLock(run, { probe: probe() })).toThrow(`写不进 ${run}`);
  });

  it('现行锁是残留、更低代号里却有活着的持有者（代号曾从 1 重新编号）：让出刚建的这一代，报那个持有者', () => {
    writeLock(1, holder({ pid: 300, startId: 'start-300' }));
    writeLock(6, holder());
    const r = acquireInstanceLock(run, { probe: probe({ 300: 'start-300' }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.holder.pid).toBe(300);
    expect(files()).toEqual(['instance.1.lock', 'instance.6.lock']);
  });

  it('更低代号的锁文件名带前导零（instance.05.lock）：按目录里的原文件名读，活着的持有者照样让出', () => {
    writeFileSync(join(run, 'instance.05.lock'), JSON.stringify(holder({ pid: 300, startId: 'start-300' })));
    writeLock(7, '{"pid":');
    const r = acquireInstanceLock(run, { probe: probe({ 300: 'start-300' }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.holder.pid).toBe(300);
    expect(r.file).toBe(join(run, 'instance.05.lock'));
    expect(files()).toEqual(['instance.05.lock', 'instance.7.lock']);
  });

  it('更低代号都是残留时一并删掉', () => {
    writeLock(1, holder({ pid: 201 }));
    writeLock(7, holder());
    writeLock(3, holder({ pid: 203 }));
    expect(acquireInstanceLock(run, { probe: probe() }).ok).toBe(true);
    expect(files()).toEqual(['instance.8.lock']);
  });

  it('respawn 交接：令牌的哈希对得上就接手活着的持有者；对不上照样报占用', () => {
    writeLock(2, holder({ handoffHash: sha256('tok') }));
    const alive = { 200: 'start-200' };
    expect(acquireInstanceLock(run, { probe: probe(alive), handoffToken: 'wrong' }).ok).toBe(false);
    const r = acquireInstanceLock(run, { probe: probe(alive), handoffToken: 'tok' });
    expect(r.ok).toBe(true);
    expect(files()).toEqual(['instance.3.lock']);
  });

  it('释放只删内容仍是自己那份的锁：同名的锁已被别的实例占用时不碰它', () => {
    const r = acquireInstanceLock(run, { probe: probe() });
    if (!r.ok) throw new Error('应取到锁');
    // 交接后被清掉、run/ 清空，别的实例重新取到同一个代号
    const other = JSON.stringify(holder({ pid: 400 }));
    writeFileSync(r.lock.file, other);
    r.lock.release();
    expect(readFileSync(join(run, 'instance.1.lock'), 'utf-8')).toBe(other);
  });

  it('清掉取锁中途留下的旧临时文件，刚建的（别的进程正在取锁）留着', () => {
    const old = join(run, '.instance.300.deadbeef.tmp');
    writeFileSync(old, '{}');
    const past = (Date.now() - 120_000) / 1000;
    utimesSync(old, past, past);
    writeFileSync(join(run, '.instance.301.cafebabe.tmp'), '{}');
    expect(acquireInstanceLock(run, { probe: probe() }).ok).toBe(true);
    expect(files()).toEqual(['.instance.301.cafebabe.tmp', 'instance.1.lock']);
  });

  it('run 目录不存在时建出来', () => {
    const nested = join(run, 'run');
    expect(acquireInstanceLock(nested, { probe: probe() }).ok).toBe(true);
    expect(existsSync(join(nested, 'instance.1.lock'))).toBe(true);
  });
});

// 这几种文件名曾让取锁同步死循环（测试超时打断不了），所以在子进程里限时跑。用 `node --import tsx`
// 不经 .bin/tsx 的包装进程，超时杀得干净，不留空转的孙进程
describe('锁文件名拼不回原名、是悬空的符号链接、或代号过大（真实子进程）', () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const contender = join(repoRoot, 'test', 'fixtures', 'lock-contender.ts');
  let dir: string;
  let run: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aalis-lock-name-'));
    run = join(dir, 'run');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 发令与收场文件先建好：参赛进程取一次锁、报 OK 或 BUSY，取到的随即放掉 */
  const acquireOnce = () => {
    writeFileSync(join(dir, 'go'), '');
    writeFileSync(join(dir, 'done'), '');
    return spawnSync(process.execPath, ['--import', 'tsx', contender, run, join(dir, 'go'), join(dir, 'done')], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 20_000,
    });
  };

  it('代号带前导零（instance.05.lock）：按目录里的原文件名读，活着的持有者照样挡住', () => {
    // 本测试进程是活着的持有者：pid 在，开机与进程启动标识都是真的
    const startId = nodeProcessProbe.startId(process.pid);
    const bootId = nodeProcessProbe.bootId();
    mkdirSync(run);
    writeFileSync(
      join(run, 'instance.05.lock'),
      JSON.stringify({
        pid: process.pid,
        ...(startId ? { startId } : {}),
        ...(bootId ? { bootId } : {}),
        handoffHash: sha256('other'),
      }),
    );
    const r = acquireOnce();
    expect(r.signal, r.stderr).toBeNull();
    expect(r.stdout).toBe('READY\nBUSY\n');
    expect(readdirSync(run)).toEqual(['instance.05.lock']);
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    '悬空的符号链接按坏锁处理：接手并清掉它',
    () => {
      mkdirSync(run);
      symlinkSync(join(dir, 'missing'), join(run, 'instance.3.lock'));
      const r = acquireOnce();
      expect(r.signal, r.stderr).toBeNull();
      expect(r.stdout).toBe('READY\nOK\n');
      // 取到的第 4 代随即放掉，悬空的第 3 代在取锁时已被清掉
      expect(readdirSync(run)).toEqual([]);
    },
    30_000,
  );

  it('代号到了 2^53（加一不再变大）：报错点名锁文件，不空转、不动它', () => {
    mkdirSync(run);
    const huge = join(run, 'instance.9007199254740992.lock');
    writeFileSync(huge, '{"pid":');
    const r = acquireOnce();
    expect(r.signal, r.stderr).toBeNull();
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('READY\n');
    expect(r.stderr).toContain(`锁文件 ${huge} 的代号太大`);
    expect(readdirSync(run)).toEqual(['instance.9007199254740992.lock']);
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')('本机的进程探测', () => {
  it('本进程的启动标识查得到、两次一样；开机标识（Linux、macOS）查得到、两次一样', () => {
    const first = nodeProcessProbe.startId(process.pid);
    expect(first).toEqual(expect.any(String));
    expect(nodeProcessProbe.startId(process.pid)).toBe(first);
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const boot = nodeProcessProbe.bootId();
      expect(boot).toEqual(expect.any(String));
      expect(nodeProcessProbe.bootId()).toBe(boot);
    }
  });

  it('不在的 pid 判为不存在', () => {
    expect(nodeProcessProbe.exists(2 ** 22 + 12345)).toBe(false);
    expect(nodeProcessProbe.exists(process.pid)).toBe(true);
  });
});
