// ============================================================
// @aalis/plugin-process-local — process-api 的本地实现
// ============================================================

import { spawn as nodeSpawn } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import type { Context, PluginModule } from '@aalis/core';
import type { ExecResult, ProcessService, SpawnHandle, SpawnOptions, TempDirHandle } from '@aalis/plugin-process-api';
import { makeTempDirViaStorage } from '@aalis/plugin-process-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';

export const name = '@aalis/plugin-process-local';
export const provides = ['process'];

/** wait() 默认累计缓冲上限（stdout+stderr 合计）：10MB，足够正常输出，又防失控输出 OOM。 */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export class LocalProcessService implements ProcessService {
  constructor(private readonly storage: StorageService) {}

  spawn(cmd: string, args: readonly string[], opts: SpawnOptions = {}): SpawnHandle {
    const stdioMode = opts.stdio ?? 'pipe';
    const child = nodeSpawn(cmd, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: stdioMode === 'pipe' ? ['pipe', 'pipe', 'pipe'] : stdioMode,
      detached: opts.detached === true,
    });
    if (opts.input != null && stdioMode === 'pipe') {
      try {
        child.stdin?.end(opts.input);
      } catch {
        /* ignore */
      }
    }
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, opts.timeout);
    }
    const handle: SpawnHandle = {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: signal => child.kill(signal),
      unref: () => {
        try {
          child.unref();
        } catch {
          /* ignore */
        }
      },
      wait: () =>
        new Promise<ExecResult>((resolve, reject) => {
          // 累计缓冲上限（stdout+stderr 合计）：边读边计数，超限即截断 + 杀进程，
          // 防失控/恶意输出无上限累积撑爆内存（评审 S1）。
          const maxBuffer = opts.maxBuffer && opts.maxBuffer > 0 ? opts.maxBuffer : DEFAULT_MAX_BUFFER;
          const chunksOut: Buffer[] = [];
          const chunksErr: Buffer[] = [];
          let total = 0;
          let truncated = false;
          const collect = (arr: Buffer[], d: unknown): void => {
            if (truncated) return;
            const b = Buffer.from(d as Uint8Array);
            const room = maxBuffer - total;
            if (b.length >= room) {
              if (room > 0) arr.push(b.subarray(0, room));
              total = maxBuffer;
              truncated = true;
              try {
                child.kill('SIGKILL');
              } catch {
                /* ignore */
              }
              return;
            }
            arr.push(b);
            total += b.length;
          };
          child.stdout?.on('data', d => collect(chunksOut, d));
          child.stderr?.on('data', d => collect(chunksErr, d));
          child.on('error', err => {
            if (timer) clearTimeout(timer);
            reject(err);
          });
          child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            resolve({
              code,
              signal,
              stdout: Buffer.concat(chunksOut).toString('utf-8'),
              stderr: Buffer.concat(chunksErr).toString('utf-8'),
              ...(truncated ? { truncated: true } : {}),
            });
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

  async readExternalFile(path: string): Promise<Uint8Array> {
    const realPath = path.startsWith('file://') ? path.slice('file://'.length) : path;
    return fsReadFile(realPath);
  }
}

export async function apply(ctx: Context): Promise<void> {
  const logger = ctx.logger.child('process-local');
  const storage = createStorageGateway(ctx);
  const service = new LocalProcessService(storage);
  ctx.provide('process', service);
  logger.info('process-local 就绪');
}

const plugin: PluginModule = { name, apply };
export default plugin;
