// ============================================================
// @aalis/plugin-code-sandbox-os — code-sandbox 的 OS 原生实现
//
// Linux bubblewrap / macOS sandbox-exec。把不可信代码包成沙箱启动器命令后，
// **经现有 `process` 服务网关** spawn（不碰 process-api / process-local 的实现，
// 也不直接 import node:child_process / node:fs——OS 探测靠经网关功能性试跑）。
// ============================================================

import type { Context, Logger, PluginModule } from '@aalis/core';
import type { CodeSandboxService, SandboxRunRequest } from '@aalis/plugin-code-sandbox-api';
import type { ExecResult, ProcessService } from '@aalis/plugin-process-api';
import { createProcessGateway } from '@aalis/plugin-process-api';
import { type SandboxBackend, wrapForSandbox } from './sandbox.js';

export const name = '@aalis/plugin-code-sandbox-os';
export const displayName = '代码沙箱（OS）';
export const provides = ['code-sandbox'];
export const inject = {
  required: ['process'],
};

/**
 * 功能性探测：经 process 网关真正跑一次最小沙箱命令，跑通才算可用。
 * 比「命令是否存在」更强——一次覆盖 存在性 + Linux unprivileged userns 是否真能用。
 */
async function probeBackend(proc: ProcessService, logger: Logger): Promise<SandboxBackend> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      await proc.execFile('sandbox-exec', ['-p', '(version 1) (allow default)', 'true'], { timeout: 5000 });
      return 'seatbelt';
    }
    if (platform === 'linux') {
      await proc.execFile('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true'], { timeout: 5000 });
      return 'bwrap';
    }
    logger.warn(`平台 ${platform} 暂无 OS 沙箱后端，code_runner auto 模式将 fail-closed`);
    return 'none';
  } catch {
    // 启动器不存在 / 不可用（如 Linux 未安装 bwrap、或 unprivileged user namespaces 被禁）→ 无后端
    logger.warn(`OS 沙箱后端探测失败（platform=${platform}）：无可用沙箱，code_runner auto 模式将 fail-closed`);
    return 'none';
  }
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
    // 经 process 网关 spawn 包好的启动器命令；env 已由 wrapper 的 --clearenv / env -i 注入白名单，
    // 故此处不再传 env（外层启动器进程继承宿主 env 无妨，wrapper 已为内层不可信子进程清空）。
    return this.proc.execFile(wrapped.cmd, wrapped.args, { cwd: req.cwd, timeout: req.timeout });
  }
}

export async function apply(ctx: Context): Promise<void> {
  const logger = ctx.logger.child('code-sandbox-os');
  const proc = createProcessGateway(ctx);
  const backend = await probeBackend(proc, logger);
  ctx.provide('code-sandbox', new OsCodeSandboxService(proc, backend));
  logger.info(
    `code-sandbox-os 就绪（后端: ${backend === 'none' ? '无 —— 沙箱不可用，code_runner 将 fail-closed' : backend}）`,
  );
}

const plugin: PluginModule = { name, apply };
export default plugin;
