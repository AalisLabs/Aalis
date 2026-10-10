// ============================================================
// @aalis/plugin-code-sandbox-os — code-sandbox 的 OS 原生实现
//
// Linux bubblewrap / macOS sandbox-exec。把不可信代码包成沙箱启动器命令后，
// **经现有 `process` 服务** spawn（不碰 process-api / process-local 的实现，
// 也不直接 import node:child_process / node:fs——OS 探测靠经 process 服务功能性试跑）。
// ============================================================

import { type CodeSandboxService, codeSandbox, type SandboxRunRequest } from '@aalis/api-code-sandbox';
import { doctor } from '@aalis/api-doctor';
import { type ExecResult, type ProcessService, processService } from '@aalis/api-process';
import { definePlugin, lifecycle, logger, optional, provide } from '@aalis/core';
import { type SandboxBackend, wrapForSandbox } from './sandbox.js';

/**
 * 各平台的最小沙箱命令：跑通即有该后端，跑不通时按 fix 修。Linux 与正式运行（sandbox.ts 的 buildBwrapArgs）一样挂 /dev 与 /proc：
 * 只放开 seccomp、挂不了 /proc 的容器里，不挂的探测会报 bwrap 可用，之后每次运行都失败
 */
const PROBES: Partial<Record<NodeJS.Platform, { backend: SandboxBackend; cmd: string; args: string[]; fix: string }>> =
  {
    darwin: {
      backend: 'seatbelt',
      cmd: 'sandbox-exec',
      args: ['-p', '(version 1) (allow default)', 'true'],
      fix: 'sandbox-exec 是 macOS 自带的，确认 /usr/bin/sandbox-exec 能执行后重载本插件',
    },
    linux: {
      backend: 'bwrap',
      cmd: 'bwrap',
      args: ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', 'true'],
      fix: '装上 bubblewrap（bwrap），并开启非特权用户命名空间（unprivileged user namespaces）；在容器里运行时还要能挂 /proc。改好后重载本插件',
    },
  };

/** 没有后端时的结论：code_runner 的 auto 模式在没有沙箱时拒绝执行（fail-closed） */
const NONE = '没有可用的 OS 沙箱，code_runner 的 auto 模式会拒绝执行代码';

/**
 * 功能性探测：经 process 服务真正跑一次最小沙箱命令，退出码为 0 才算有后端。
 * 比「命令是否存在」更强——一次覆盖 存在性 + Linux unprivileged userns 是否真能用。
 * 没有后端时 problem 写怎么修与原因（日志与诊断共用）。
 * 停用、停机时随 signal 中止并抛出（不落成「无后端」），启动器挂住也不拖满停机宽限。
 */
async function probeBackend(
  proc: ProcessService,
  signal: AbortSignal,
): Promise<{ backend: SandboxBackend; problem?: string }> {
  const platform = process.platform;
  const probe = PROBES[platform];
  if (!probe) {
    return {
      backend: 'none',
      problem: `这个平台（${platform}）没有 OS 沙箱后端：要用沙箱就在 macOS、Linux 或 WSL 上运行 Aalis`,
    };
  }
  let result: ExecResult | undefined;
  let error: unknown;
  try {
    result = await proc.spawn(probe.cmd, probe.args, { stdio: 'ignore', timeout: 5000, signal }).wait();
  } catch (err) {
    error = err;
  }
  // 被中止（spawn 同步抛出、wait 被拒或随中止落定）一律抛出，apply 随之落定
  signal.throwIfAborted();
  if (result?.code === 0) return { backend: probe.backend };
  // 启动器不存在 / 不可用（如 Linux 未安装 bwrap、或 unprivileged user namespaces 被禁）/ 超时 → 无后端
  const reason = result
    ? result.code === null
      ? `被信号 ${result.signal} 终止（含 5 秒超时）`
      : `退出码 ${result.code}`
    : error instanceof Error
      ? error.message
      : String(error);
  return { backend: 'none', problem: `${probe.fix}。探测 ${probe.cmd} 失败：${reason}` };
}

class OsCodeSandboxService implements CodeSandboxService {
  constructor(
    private readonly proc: ProcessService,
    private readonly _backend: SandboxBackend,
  ) {}

  get available(): boolean {
    return this._backend !== 'none';
  }

  get backend(): string {
    return this._backend;
  }

  async run(req: SandboxRunRequest): Promise<ExecResult> {
    if (this._backend === 'none') {
      throw new Error('code-sandbox: 无可用后端，run() 不应被调用（调用方应先检查 available）');
    }
    const wrapped = wrapForSandbox(this._backend, req.policy, req.cmd, req.args, req.cwd, req.env ?? {});
    // 经 process 服务 spawn 包好的启动器命令；env 已由 wrapper 的 --clearenv / env -i 注入白名单，
    // 故此处不再传 env（外层启动器进程继承宿主 env 无妨，wrapper 已为内层不可信子进程清空）。
    return this.proc.execFile(wrapped.cmd, wrapped.args, { cwd: req.cwd, timeout: req.timeout, signal: req.signal });
  }
}

export default definePlugin({
  name: '@aalis/plugin-code-sandbox-os',
  displayName: '代码沙箱（OS）',
  subsystem: 'tools',
  provides: [codeSandbox],
  uses: { processService, doctor: optional(doctor), logger, lifecycle, provide },
  async apply(caps) {
    const log = caps.logger.use.child('code-sandbox-os');
    // 业务句柄每次调用转发给当前选中的提供者，process 提供者换人后无需重启本插件
    const proc = caps.processService.use;
    const { backend, problem } = await probeBackend(proc, caps.lifecycle.use.signal);
    if (problem) log.warn(`${NONE}：${problem}`);
    caps.provide.use(codeSandbox, new OsCodeSandboxService(proc, backend));
    // 这台机器上没有沙箱时整个插件用不了：在诊断里给出修法，没装 WebUI 的用户靠 /doctor 看到
    caps.doctor.use.registerCheck({
      id: 'code-sandbox.backend',
      category: 'env',
      run: () =>
        problem
          ? { id: 'code-sandbox.backend', category: 'env', level: 'warn', message: NONE, detail: problem }
          : { id: 'code-sandbox.backend', category: 'env', level: 'ok', message: `OS 沙箱可用（${backend}）` },
    });
    log.info(`code-sandbox-os 就绪（后端: ${backend}）`);
  },
});
