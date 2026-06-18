// ============================================================
// @aalis/plugin-process-api — 子进程接口
//
// 把所有 child_process / os.tmpdir 用法集中到一个能力插件后面，
// 使其他业务插件无需直接 import node:child_process / node:os / node:fs。
//
// 由 @aalis/plugin-process-local 提供默认本地实现。
// ============================================================

import type { Readable, Writable } from 'node:stream';
import type { Context } from '@aalis/core';
import { registerCapabilityProbe } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** 超时（毫秒）；到时杀子进程 */
  timeout?: number;
  /** 标准输入要写入的内容 */
  input?: string | Uint8Array;
  /**
   * 将子进程与父进程解耦（使其可独立于父进程生存）。
   * 需要与 stdio:'ignore' 一起使用，且调用方需手动调 handle.unref()。
   */
  detached?: boolean;
  /**
   * stdio 重定向策略；默认 'pipe'（stdin/stdout/stderr 均为 pipe）。
   * 'ignore' 可与 detached 携手实现 fire-and-forget（例如启动浏览器）。
   */
  stdio?: 'pipe' | 'ignore' | 'inherit';
  /**
   * wait() 累计缓冲（stdout+stderr 合计）字节上限；超出即截断并杀子进程，
   * 防失控/恶意输出在 Buffer.concat 前无上限累积撑爆宿主内存。缺省由实现给安全默认（如 10MB）。
   */
  maxBuffer?: number;
}

export interface ExecResult {
  /** 退出码；信号杀死时为 null */
  code: number | null;
  /** 终止信号 */
  signal: NodeJS.Signals | null;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 输出超过 maxBuffer 被截断并提前杀进程（区别于 timeout 的 SIGKILL） */
  truncated?: boolean;
}

export interface SpawnHandle {
  pid: number | undefined;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  /** 等待子进程结束 */
  wait(): Promise<ExecResult>;
  /** 杀子进程 */
  kill(signal?: NodeJS.Signals): boolean;
  /**
   * detached 模式下调用以允许父进程独立退出（不等待子进程）。非 detached 下为 no-op。
   */
  unref(): void;
}

/** 一次性获得的本地临时目录句柄；调用 cleanup() 释放 */
export interface TempDirHandle {
  /** 本地绝对路径，可直接传给子进程 */
  path: string;
  /** 对应 storage URI（tmp:/...） */
  uri: string;
  /** 清理：递归删除目录 */
  cleanup(): Promise<void>;
}

export interface ProcessService {
  /**
   * 同 child_process.spawn 但只接 (cmd, args, opts)，不接 shell 字符串。
   */
  spawn(cmd: string, args: readonly string[], opts?: SpawnOptions): SpawnHandle;
  /**
   * 同 child_process.execFile 但只接 (cmd, args, opts)，返回 stdout/stderr/code。
   * 非零退出会 reject（携带 ExecResult）。
   */
  execFile(cmd: string, args: readonly string[], opts?: SpawnOptions): Promise<ExecResult>;
  /**
   * 创建本地临时目录（前缀 `aalis-<prefix>-`），位于 storage 的 tmp:/ 根下。
   * 调用方拿到本地绝对路径，子进程读写后调 cleanup() 删除。
   */
  makeTempDir(prefix: string): Promise<TempDirHandle>;
  /**
   * 读取 OS 任意本地路径的文件（绕过 storage root 沙箱）。
   *
   * 仅限于手上拿到“外部推来的本地路径”场景（如 OneBot daemon 推送的附件路径、
   * 用户选择的外部文件拖拽等），不是 storage 的替代品。
   * storage 负责“在声明的 root 内读写”（受沙箱约束），
   * 本接口负责“OS 直通读外部路径”（调用方自行保证安全性）。
   * path 可以是本地绝对路径或 file:// URI。
   */
  readExternalFile(path: string): Promise<Uint8Array>;
}

export type ProcessCapability = 'spawn' | 'exec' | 'temp-dir' | 'external-fs';

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    process: ProcessCapability;
  }
  interface ServiceTypeMap {
    process: ProcessService;
  }
}

registerCapabilityProbe('process', 'spawn', inst =>
  typeof (inst as { spawn?: unknown }).spawn === 'function'
    ? true
    : 'ProcessService.spawn() is required for capability "spawn"',
);
registerCapabilityProbe('process', 'exec', inst =>
  typeof (inst as { execFile?: unknown }).execFile === 'function'
    ? true
    : 'ProcessService.execFile() is required for capability "exec"',
);
registerCapabilityProbe('process', 'temp-dir', inst =>
  typeof (inst as { makeTempDir?: unknown }).makeTempDir === 'function'
    ? true
    : 'ProcessService.makeTempDir() is required for capability "temp-dir"',
);
registerCapabilityProbe('process', 'external-fs', inst =>
  typeof (inst as { readExternalFile?: unknown }).readExternalFile === 'function'
    ? true
    : 'ProcessService.readExternalFile() is required for capability "external-fs"',
);

/**
 * 返回一个无服务实例时抛错、单实例时直接转发的 ProcessService 网关。
 */
export function createProcessGateway(ctx: Context): ProcessService {
  const pick = (): ProcessService => {
    const inst = ctx.getService<ProcessService>('process');
    if (!inst) {
      throw new Error('未找到 process 服务（请启用 @aalis/plugin-process-local 或其他 process 提供方）');
    }
    return inst;
  };
  return {
    spawn: (cmd, args, opts) => pick().spawn(cmd, args, opts),
    execFile: (cmd, args, opts) => pick().execFile(cmd, args, opts),
    makeTempDir: prefix => pick().makeTempDir(prefix),
    readExternalFile: path => pick().readExternalFile(path),
  };
}

// 给本地实现使用的辅助：基于 storage 的 makeTempDir 默认骨架
export async function makeTempDirViaStorage(storage: StorageService, prefix: string): Promise<TempDirHandle> {
  if (!storage.resolveLocalPath) {
    throw new Error('当前 storage 不支持 resolveLocalPath，无法创建本地临时目录');
  }
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'tmp';
  const rand = Math.random().toString(36).slice(2, 10);
  const rel = `${safePrefix}-${Date.now()}-${rand}`;
  const uri = `tmp:/${rel}`;
  // 通过写一个占位文件保证目录存在（storage.writeFile 自动 mkdir）
  await storage.writeFile(`${uri}/.keep`, '');
  await storage.delete(`${uri}/.keep`).catch(() => {});
  const path = await storage.resolveLocalPath(uri, 'write');
  return {
    path,
    uri,
    cleanup: async () => {
      await storage.delete(uri).catch(() => {});
    },
  };
}
