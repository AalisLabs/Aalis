// ============================================================
// @aalis/plugin-code-sandbox-api — 代码沙箱契约
//
// 「在 OS 隔离下执行不可信代码」是 code_runner 独有的诉求，不属于通用 `process` 子进程契约
// （package-manager / scheduler 等跑子进程都不需要），故独立成自己的服务，避免污染共享面。
//
// 实现由 @aalis/plugin-code-sandbox-os（macOS sandbox-exec / Linux bubblewrap）提供；
// 未来可有 -docker / -wasm / -e2b 等不同机制的实现，经同一 `code-sandbox` 服务按优先级/偏好替换。
// ============================================================

import type { Context } from '@aalis/core';
import type { ExecResult } from '@aalis/plugin-process-api';

/**
 * 子进程沙箱策略。由调用方（code_runner）按运行时已解析的工作目录/临时目录构造，
 * 实现用 OS 机制强制执行。
 *
 * v1 语义：读放开（解释器需系统库）、**写限定** fsWrite、**网络粗粒度开关**（无法按域名过滤）。
 * 即防「写出工作区 / 联网外泄 / 篡改系统」，不防「读取本机其它文件」（要防读取需更强的 WASM/microVM 实现）。
 */
export interface SandboxPolicy {
  /** 可读绝对目录白名单（信息性；v1 后端读放开，预留给更严格的读限定实现） */
  fsRead: string[];
  /** 可写绝对目录白名单（如 workspace + 临时目录）；此外一律只读/拒写 */
  fsWrite: string[];
  /** 子进程网络：'deny'=断网（推荐默认）；'allow'=放开（粗粒度，无法按域名过滤） */
  network: 'deny' | 'allow';
}

/** 一次沙箱执行请求 */
export interface SandboxRunRequest {
  /** 要执行的命令（解释器路径/名，如 python3 / node） */
  cmd: string;
  /** 命令参数（含脚本路径） */
  args: string[];
  /** 工作目录（本地绝对路径） */
  cwd?: string;
  /** 传给子进程的环境变量白名单；沙箱内仅这些键可见，其余宿主 env 一律清除（防 secrets 泄漏） */
  env?: Record<string, string | undefined>;
  /** 超时（毫秒） */
  timeout?: number;
  /** 隔离策略 */
  policy: SandboxPolicy;
}

/**
 * 代码沙箱服务 —— 在 OS 隔离下运行不可信代码。
 *
 * code_runner 用法：取本服务 → 若 `available` 为假则 **fail-closed**（拒绝执行、给出可操作提示），
 * 不要退回无隔离裸跑；为真则调 `run()`。
 */
export interface CodeSandboxService {
  /** 本机是否有可用沙箱后端（无 → 调用方 fail-closed） */
  readonly available: boolean;
  /** 当前后端标识（诊断/展示用，如 'bwrap' / 'seatbelt' / 'none'） */
  readonly backend: string;
  /**
   * 在沙箱内运行命令并等待结束。返回 {@link ExecResult}；
   * 与 ProcessService.execFile 一致——非零退出会 reject（错误对象挂 `.result`）。
   */
  run(req: SandboxRunRequest): Promise<ExecResult>;
}

declare module '@aalis/core' {
  interface ServiceTypeMap {
    'code-sandbox': CodeSandboxService;
  }
}

/** 取 code-sandbox 服务（未就绪/未安装实现时为 undefined）。 */
export function useCodeSandbox(ctx: Context): CodeSandboxService | undefined {
  return ctx.getService<CodeSandboxService>('code-sandbox');
}
