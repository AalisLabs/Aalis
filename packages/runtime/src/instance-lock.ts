import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// ============================================================
// 实例锁：同一家目录只许一个实例
// ============================================================
//
// 没有锁时，手动在终端再起一份会与服务并存，每条消息回两遍。锁是 `run/instance.<n>.lock`，代号 n 最大的那份是现行锁：
// - 取锁时先把完整内容写进临时文件，再 link 成下一个代号。link 在目标已存在时原子失败，同一代号只有一个进程拿得到；
//   内容在建出时就是完整的，读不到半截。所以家目录所在的文件系统要支持硬链接。
// - 不删、不改名活着的锁。link 成功后再看一遍更低的代号：还有活着的持有者（读到的「残留」其实已经被人接手，
//   或者代号在 run/ 清空后从 1 重新编号），就让出刚建的这一代、报占用。代号最低的活持有者胜出。
//   确认没有之后，删掉更低代号的旧文件。
// - 释放时只删内容仍是自己那份的锁文件：同名的锁可能已经是别的实例的。
// - 锁内容建出后不再改写。前台 respawn 的交接靠取锁时生成的令牌：锁里只记它的哈希，令牌经环境变量交给新进程，
//   新进程看到锁里的哈希与令牌对得上，就照常 link 出下一个代号接手。不核对父进程 pid：开发模式经 tsx 包装进程
//   起新实例，新实例的父进程是 tsx，不是旧实例；令牌只在交给新进程的环境变量里，拿得到它就是被交接的那个。
//
// 判活只用与墙上时钟无关的标识（时钟被 NTP 步进、夏令时回拨都不影响）：
// - 本次开机的标识不同（重启过）判残留；
// - pid 命名空间不同（另一个容器）判不了，按占用处理；
// - pid 不在判残留；pid 在时比对进程启动标识，不同判残留（pid 被复用）；
// - 查不了启动标识（Windows、没有 ps 的精简镜像）时只看 pid。

const LOCK_PATTERN = /^instance\.(\d+)\.lock$/;
const TEMP_PATTERN = /^\.instance\.\d+\.[0-9a-f]+\.tmp$/;
/** 临时文件正常只活几毫秒；超过这个时长的是取锁中途退出留下的 */
const TEMP_STALE_MS = 60_000;

/** 锁文件内容 */
export interface LockHolder {
  pid: number;
  /** 进程启动标识，见 {@link ProcessProbe.startId}；查不了时没有 */
  startId?: string;
  /** 本次开机的标识；查不了时没有 */
  bootId?: string;
  /** pid 命名空间（Linux）；查不了时没有 */
  pidNs?: string;
  /** 交接令牌的 sha256 */
  handoffHash: string;
}

/** 查询本机进程的那几样东西，测试里换成替身 */
export interface ProcessProbe {
  /** 本进程的 pid */
  pid: number;
  now(): number;
  /** 本次开机的标识：Linux 的 boot_id、macOS 的 kern.bootsessionuuid；别的平台没有 */
  bootId(): string | undefined;
  /** 本进程的 pid 命名空间（Linux）；别的平台没有 */
  pidNs(): string | undefined;
  /** pid 是否存在 */
  exists(pid: number): boolean;
  /**
   * 进程启动标识，只用来比相等：Linux 是 `/proc/<pid>/stat` 的 starttime（开机以来的时钟滴答，与墙上时钟无关），
   * 其它 POSIX 是 UTC 下 `ps -o lstart=` 的原文（进程创建时记下的时刻，之后不随时钟步进变）。查不了时为 undefined。
   */
  startId(pid: number): string | undefined;
}

function run(cmd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf-8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export const nodeProcessProbe: ProcessProbe = {
  pid: process.pid,
  now: () => Date.now(),
  bootId() {
    if (process.platform === 'linux') {
      try {
        return readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim() || undefined;
      } catch {
        return undefined;
      }
    }
    return process.platform === 'darwin' ? run('sysctl', ['-n', 'kern.bootsessionuuid']) : undefined;
  },
  pidNs() {
    if (process.platform !== 'linux') return undefined;
    try {
      return readlinkSync('/proc/self/ns/pid');
    } catch {
      return undefined;
    }
  },
  exists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM：进程在，只是不归本用户
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  startId(pid) {
    if (process.platform === 'win32') return undefined;
    if (process.platform === 'linux') {
      try {
        // comm 可能含空格与括号：从最后一个 ')' 之后切，下一项是第 3 字段 state，starttime 是第 22 字段
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      } catch {
        return undefined;
      }
    }
    return run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  },
};

/** 取锁时遇到的环境问题（锁文件读不了、文件系统不支持硬链接等）：宿主据此一行报错退出 */
export class InstanceLockError extends Error {
  override name = 'InstanceLockError';
}

export interface InstanceLock {
  /** 本进程持有的锁文件 */
  readonly file: string;
  /** 交接令牌：respawn 时经环境变量交给新进程 */
  readonly handoffToken: string;
  /** 删掉本进程的锁文件：只在它仍是本进程那份时删（交接后可能已被清掉，同名的也可能是别的实例的）；可重复调用 */
  release(): void;
}

type AcquireResult = { ok: true; lock: InstanceLock } | { ok: false; holder: LockHolder; file: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 读锁：文件已不在为 'gone'；内容坏了为 'corrupt'（按残留处理）；别的读错误不猜，抛给宿主 */
function readHolder(file: string): LockHolder | 'gone' | 'corrupt' {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw new InstanceLockError(`读不了锁文件 ${file}：${(err as Error).message}`);
  }
  try {
    const v = JSON.parse(text) as Partial<LockHolder>;
    if (typeof v.pid === 'number' && typeof v.handoffHash === 'string') return v as LockHolder;
  } catch {
    /* 下面按坏内容处理 */
  }
  return 'corrupt';
}

function generations(runDir: string): number[] {
  const out: number[] = [];
  for (const name of readdirSync(runDir)) {
    const m = LOCK_PATTERN.exec(name);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

/** 持有者是否还在（见文件头的判活规则）；判不了的按在处理 */
function isHolderAlive(holder: LockHolder, probe: ProcessProbe): boolean {
  const ns = probe.pidNs();
  if (holder.pidNs !== undefined && ns !== undefined && holder.pidNs !== ns) return true;
  const boot = probe.bootId();
  if (holder.bootId !== undefined && boot !== undefined && holder.bootId !== boot) return false;
  // 锁里记的是本进程的 pid，而本进程还没取过锁：那是 pid 被复用前的上一个进程
  if (holder.pid === probe.pid) return false;
  if (!probe.exists(holder.pid)) return false;
  if (holder.startId === undefined) return true;
  const started = probe.startId(holder.pid);
  return started === undefined || started === holder.startId;
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/**
 * 取实例锁。`handoffToken` 是旧实例 respawn 时交过来的令牌：与锁里的哈希对得上的那份按已交接处理；
 * 否则按持有者死活决定取锁还是报占用。
 */
export function acquireInstanceLock(
  runDir: string,
  opts: { handoffToken?: string; probe?: ProcessProbe } = {},
): AcquireResult {
  const probe = opts.probe ?? nodeProcessProbe;
  mkdirSync(runDir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const mine: LockHolder = {
    pid: probe.pid,
    ...optional('startId', probe.startId(probe.pid)),
    ...optional('bootId', probe.bootId()),
    ...optional('pidNs', probe.pidNs()),
    handoffHash: sha256(token),
  };
  const handedOver = (h: LockHolder) => opts.handoffToken !== undefined && h.handoffHash === sha256(opts.handoffToken);
  /** 活着、又不是把锁交给本进程的那一个 */
  const blocks = (h: LockHolder | 'gone' | 'corrupt'): h is LockHolder =>
    typeof h === 'object' && !handedOver(h) && isHolderAlive(h, probe);
  const temp = join(runDir, `.instance.${probe.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    try {
      writeFileSync(temp, JSON.stringify(mine), { mode: 0o600 });
    } catch (err) {
      throw new InstanceLockError(`写不进 ${runDir}：${(err as Error).message}`);
    }
    for (;;) {
      const top = generations(runDir).at(-1);
      if (top !== undefined) {
        const file = join(runDir, `instance.${top}.lock`);
        const holder = readHolder(file);
        // 刚被释放：重读一遍
        if (holder === 'gone') continue;
        if (blocks(holder)) return { ok: false, holder, file };
      }
      const next = (top ?? 0) + 1;
      const file = join(runDir, `instance.${next}.lock`);
      try {
        linkSync(temp, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw new InstanceLockError(
          `建不出锁文件 ${file}（家目录所在的文件系统要支持硬链接）：${(err as Error).message}`,
        );
      }
      // 更低的代号里还有活着的持有者：让出刚建的这一代（读锁出错时同样先让出再抛）
      const blocker = lowerBlocker(runDir, next, blocks, file);
      if (blocker) return { ok: false, ...blocker };
      cleanup(runDir, next, probe);
      let released = false;
      return {
        ok: true,
        lock: {
          file,
          handoffToken: token,
          release() {
            if (released) return;
            released = true;
            try {
              const current = readHolder(file);
              if (typeof current === 'object' && current.handoffHash === mine.handoffHash) unlinkSync(file);
            } catch {
              /* 退出路径上不抛：读不了或已被清掉都不再处理 */
            }
          },
        },
      };
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* 删不掉的临时文件过一阵由取到锁的进程清掉 */
    }
  }
}

function lowerBlocker(
  runDir: string,
  next: number,
  blocks: (h: LockHolder | 'gone' | 'corrupt') => h is LockHolder,
  own: string,
): { holder: LockHolder; file: string } | undefined {
  try {
    for (const g of generations(runDir)) {
      if (g >= next) break;
      const file = join(runDir, `instance.${g}.lock`);
      const holder = readHolder(file);
      if (!blocks(holder)) continue;
      unlinkSync(own);
      return { holder, file };
    }
    return undefined;
  } catch (err) {
    try {
      unlinkSync(own);
    } catch {
      /* 已经不在 */
    }
    throw err;
  }
}

/** 删掉更低代号的锁（此时都已确认不是活着的持有者），以及取锁中途退出留下的旧临时文件 */
function cleanup(runDir: string, current: number, probe: ProcessProbe): void {
  for (const name of readdirSync(runDir)) {
    const lock = LOCK_PATTERN.exec(name);
    const path = join(runDir, name);
    let stale = lock !== null && Number(lock[1]) < current;
    if (!stale && TEMP_PATTERN.test(name)) {
      try {
        stale = probe.now() - statSync(path).mtimeMs > TEMP_STALE_MS;
      } catch {
        stale = false;
      }
    }
    if (!stale) continue;
    try {
      unlinkSync(path);
    } catch {
      /* 并发清理时可能已被删掉 */
    }
  }
}
