// ============================================================
// @aalis/plugin-process-local — process-api 的本地实现
// ============================================================

import { spawn as nodeSpawn } from 'node:child_process';
import type { Context, PluginModule } from '@aalis/core';
import type { ExecResult, ProcessService, SpawnHandle, SpawnOptions, TempDirHandle } from '@aalis/plugin-process-api';
import { makeTempDirViaStorage } from '@aalis/plugin-process-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';

export const name = '@aalis/plugin-process-local';
export const provides = ['process'];

class LocalProcessService implements ProcessService {
  constructor(private readonly storage: StorageService) {}

  spawn(cmd: string, args: readonly string[], opts: SpawnOptions = {}): SpawnHandle {
    const child = nodeSpawn(cmd, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (opts.input != null) {
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
      wait: () =>
        new Promise<ExecResult>((resolve, reject) => {
          const chunksOut: Buffer[] = [];
          const chunksErr: Buffer[] = [];
          child.stdout?.on('data', d => chunksOut.push(Buffer.from(d)));
          child.stderr?.on('data', d => chunksErr.push(Buffer.from(d)));
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
