// ============================================================
// @aalis/plugin-process-local — process-api 的本地实现
// ============================================================

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import type { ExecResult, ProcessService, SpawnHandle, SpawnOptions, TempDirHandle } from '@aalis/api-process';
import { makeTempDirViaStorage, processService } from '@aalis/api-process';
import type { StorageService } from '@aalis/api-storage';
import { createStorageGateway, storage } from '@aalis/api-storage';
import { definePlugin, events, logger, optional, provide } from '@aalis/core';

/** wait() 默认累计缓冲上限（stdout+stderr 合计）：10MB，足够正常输出，又防失控输出 OOM。 */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * wait() 在子进程 'exit' 之后等 'close' 的宽限（毫秒）。
 * 孙进程继承同一对 pipe，只要它还活着 'close' 就永远不来（`sh -c 'sleep 20 & echo hi'`
 * 实测要等满 20 秒，`npm run dev &` 则永不返回）。宽限到点即用已收集的输出返回。
 */
const CLOSE_GRACE_MS = 200;

const isWindows = process.platform === 'win32';

/**
 * 对子进程所在的**整个进程组**发信号（POSIX）。子进程 spawn 时 detached，自身即进程组组长，
 * 负 pid 才能打到它 fork 出的孙进程——只打子进程（`/bin/sh`）杀不掉 `sh -c 'cmd &'` 的后台任务。
 * 组已不存在（ESRCH）/无权限时回落到只打子进程本身。
 */
function killGroup(child: ChildProcess, signal?: NodeJS.Signals): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

/**
 * 强制收尾（超时 / 宿主停机）。POSIX 打整个进程组 SIGKILL；
 * Windows 无进程组与负 pid 语义，改用 `taskkill /T /F` 杀整棵进程树。
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    const fallback = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    try {
      const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', fallback); // spawn 失败（ENOENT 等）是异步 'error'，无监听器会崩宿主
      killer.unref();
    } catch {
      fallback();
    }
    return;
  }
  killGroup(child, 'SIGKILL');
}

/** 进程组是否还有成员：负 pid 发 0 号信号只探测不打（组已空则 ESRCH）。 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class LocalProcessService implements ProcessService {
  /**
   * 存活进程组登记表（键 = 直接子进程 pid = pgid）。detached 后终端 Ctrl+C 不再直达子进程，改由 killAll
   * 在停机时统一收尸；`cmd &` 留下的孙进程在直接子进程退出后仍占着这个组，所以按组而非按子进程登记。
   */
  private readonly groups = new Map<number, ChildProcess>();

  constructor(private readonly storage: StorageService) {}

  /** 宿主停机时把仍有成员的进程组整组杀掉，维持「Aalis 退出，工具子进程一起退出」。 */
  killAll(): void {
    for (const child of this.groups.values()) killTree(child);
    this.groups.clear();
  }

  spawn(cmd: string, args: readonly string[], opts: SpawnOptions = {}): SpawnHandle {
    const stdioMode = opts.stdio ?? 'pipe';
    const child = nodeSpawn(cmd, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: stdioMode === 'pipe' ? ['pipe', 'pipe', 'pipe'] : stdioMode,
      // POSIX 一律 detached：让子进程自成进程组组长，超时/停机才能对整组发信号（见 killGroup）。
      // opts.detached 的 fire-and-forget 语义仍由调用方的 stdio:'ignore' + unref() 兑现。
      detached: isWindows ? opts.detached === true : true,
    });
    // 调用方显式 detached 的（fire-and-forget，如拉起浏览器）不登记：它本就该独立于宿主生存
    if (child.pid !== undefined && opts.detached !== true) {
      const pid = child.pid;
      this.groups.set(pid, child);
      // 直接子进程退了不等于组空：孙进程还在就留到停机收尸。pgid 被占用期间该 pid 不会被复用，
      // 负 pid 只会指向我们自己建的这个组。
      child.on('exit', () => {
        if (isWindows || !groupAlive(pid)) this.groups.delete(pid);
      });
    }
    if (opts.input != null && stdioMode === 'pipe') {
      // stdin 写入的 EPIPE 等是异步 'error' 事件；无监听器会 uncaughtException 崩整个宿主进程。
      child.stdin?.on('error', () => {});
      try {
        child.stdin?.end(opts.input);
      } catch {
        /* ignore */
      }
    }
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => killTree(child), opts.timeout);
    }
    // 契约不要求调用方 wait()：子进程自己退了也要清掉定时器，免得到点对可能已被复用的组发 SIGKILL
    child.on('exit', () => {
      if (timer) clearTimeout(timer);
    });
    const handle: SpawnHandle = {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      // POSIX 打整个进程组（孙进程同死）；Windows 无此语义，维持只打子进程本身。
      kill: signal => (isWindows ? child.kill(signal) : killGroup(child, signal)),
      unref: () => {
        try {
          child.unref();
        } catch {
          /* ignore */
        }
      },
      wait: () =>
        new Promise<ExecResult>((resolve, reject) => {
          // 累计缓冲上限（stdout+stderr 合计）：边读边计数，超限即停止累积（丢弃后续、标 truncated），
          // 防失控/恶意输出无上限累积撑爆内存。不杀进程——终止交给 timeout / 调用方：后台进程
          // （dev server / --watch 等）本就该长跑，杀掉会误伤，且超 buffer 也不应被误报成 SIGKILL/timedOut。
          const maxBuffer = opts.maxBuffer && opts.maxBuffer > 0 ? opts.maxBuffer : DEFAULT_MAX_BUFFER;
          const chunksOut: Buffer[] = [];
          const chunksErr: Buffer[] = [];
          let total = 0;
          let truncated = false;
          let settled = false;
          const collect = (arr: Buffer[], d: unknown): void => {
            if (truncated || settled) return; // settled：宽限已过，管道保持打开但之后的输出丢弃
            const b = Buffer.from(d as Uint8Array);
            const room = maxBuffer - total;
            if (b.length >= room) {
              if (room > 0) arr.push(b.subarray(0, room));
              total = maxBuffer;
              truncated = true;
              return; // 停止累积即可：后续 chunk 经顶部 if(truncated) 丢弃但仍被消费(不阻塞)；不杀进程
            }
            arr.push(b);
            total += b.length;
          };
          child.stdout?.on('data', d => collect(chunksOut, d));
          child.stderr?.on('data', d => collect(chunksErr, d));
          let graceTimer: NodeJS.Timeout | undefined;
          const clearTimers = (): void => {
            if (timer) clearTimeout(timer);
            if (graceTimer) clearTimeout(graceTimer);
          };
          const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            resolve({
              code,
              signal,
              stdout: Buffer.concat(chunksOut).toString('utf-8'),
              stderr: Buffer.concat(chunksErr).toString('utf-8'),
              ...(truncated ? { truncated: true } : {}),
            });
          };
          child.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimers();
            reject(err);
          });
          // 正常情况 'close'（pipe 全关）先于宽限到点，输出完整。
          child.on('close', (code, signal) => finish(code, signal));
          child.on('exit', (code, signal) => {
            if (settled) return;
            // 子进程已死但 'close' 未到 = 孙进程扣着 pipe 不放。给一个短宽限收尾，到点仍不来就用已收集的输出返回。
            // 不销毁读端：销毁会让 `npm run dev &` 这类后台进程在下次写日志时吃 EPIPE 死掉；
            // 管道保持打开、之后的输出经 collect 丢弃，该进程组留待停机收尸。
            graceTimer = setTimeout(() => finish(code, signal), CLOSE_GRACE_MS);
          });
        }),
    };
    return handle;
  }

  async execFile(cmd: string, args: readonly string[], opts: SpawnOptions = {}): Promise<ExecResult> {
    const handle = this.spawn(cmd, args, opts);
    const res = await handle.wait();
    if (res.code !== 0) {
      const err = new Error(
        `execFile ${cmd} 退出码 ${res.code ?? 'null'}${res.signal ? ` (signal ${res.signal})` : ''}: ${res.stderr.slice(0, 200)}`,
      ) as Error & { result?: ExecResult };
      err.result = res;
      throw err;
    }
    return res;
  }

  async makeTempDir(prefix: string): Promise<TempDirHandle> {
    return makeTempDirViaStorage(this.storage, prefix);
  }

  async readExternalFile(path: string, maxBytes?: number): Promise<Uint8Array> {
    const realPath = path.startsWith('file://') ? path.slice('file://'.length) : path;
    // 先看大小再读：调用方（如 onebot 附件缓存）拿到的路径来自外部 daemon，
    // 整份读进堆之后再判限额等于白吃一次峰值内存，大文件足以把进程压垮。
    if (maxBytes !== undefined && Number.isFinite(maxBytes)) {
      const st = await fsStat(realPath);
      if (st.size > maxBytes) {
        throw new Error(`外部文件超过上限: ${st.size} > ${maxBytes}`);
      }
    }
    return fsReadFile(realPath);
  }
}

export default definePlugin({
  name: '@aalis/plugin-process-local',
  provides: [processService],
  // storage 只被 makeTempDir 用到，缺席时其余方法照常可用：声明为可选，不拦激活。
  uses: { provide, events, logger, storage: optional(storage) },
  apply(caps) {
    const service = new LocalProcessService(createStorageGateway(caps.storage));
    caps.provide(processService, service);
    // detached 让子进程脱离宿主进程组，终端 Ctrl+C 不再直达它们——停机时在此补杀。
    // 挂 app:stopping 而非插件 dispose：本插件被 bounce 时，别的插件正在跑的子进程（ffmpeg 等）不该陪葬。
    caps.events.on('app:stopping', () => service.killAll());
    caps.logger.info('process-local 就绪');
  },
});
