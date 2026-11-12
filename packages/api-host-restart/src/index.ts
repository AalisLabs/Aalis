/**
 * @aalis/api-host-restart — 宿主重启契约
 *
 * 重启是宿主的事：怎么换一个新进程、旧进程何时退出、新实例没起来怎么办，只有宿主知道。
 * Node 宿主 @aalis/runtime 把重启作为 host-restart 服务独占登记在根上；不能重启的宿主（嵌入式宿主、一次性的子命令进程）
 * 不提供它。插件在 uses 里以可选依赖声明，缺席即「这个宿主不能重启」。
 */

import { defineService } from '@aalis/core';

/**
 * 重启回滚凭据：「更新后新实例无法启动」时把工程恢复到更新前的手段。
 *
 * 由发起方（如市场的更新）在改写 `package.json` **之前**构造，随 `restart` 交给宿主。触发条件（新进程就绪前退出）
 * 与执行者都是宿主，凭据只在宿主的内存里，不落盘。
 */
export interface RestartRollback {
  /** 人类可读的来由，仅用于日志（如 `marketplace-update:@aalis/core`）。 */
  reason: string;
  /**
   * 需要还原的文件：绝对路径 → 更新前的原始内容。
   *
   * `deleteIfEmpty` 表示该文件**更新前并不存在**（如原本无 lockfile 的工程被 `npm install` 新建了一个），
   * 回滚时应删除而非写空：留着它会让后续的重装判定新版仍然满足，从而什么都不做。
   */
  restore: Array<{ path: string; content: string; deleteIfEmpty?: boolean }>;
  /**
   * 还原文件后需要跑的命令：`package.json` 回退了，`node_modules` 还停在新版，必须再执行一次安装才能真正回到旧状态。
   * 省略则只还原文件。
   */
  postRestore?: { cmd: string; args: string[]; cwd: string };
}

export interface HostRestart {
  /**
   * 请求重启。只受理一次：已受理过的再调是空操作；未受理过而应用已开始停机时抛错。
   * 受理后立即返回，停机与换新实例在之后进行，时序由宿主决定。
   *
   * @param opts.rollback 新实例没能接管时宿主用它把工程恢复原样
   */
  restart(opts?: { rollback?: RestartRollback }): void;
}

export const hostRestart = defineService<HostRestart>('host-restart');
