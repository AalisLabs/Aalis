// ============================================================
// @aalis/api-package-manager — 包管理契约
//
// 默认提供者：@aalis/plugin-package-manager。消费方（如 WebUI 市场）以
// optional(packageManager) 声明，缺席时自行降级。
// ============================================================

import { defineService } from '@aalis/core';

/**
 * 包管理服务：在项目根 `dependencies` 里装卸插件。
 *
 * 根 `dependencies` 是加载器**唯一**的发现来源，所以装卸都落在那里——不再有「解包到
 * packages/ 目录」那条路径（它按 `pnpm-workspace.yaml` 猜部署形态，而那个文件与真正
 * 生效的加载器无因果关系，猜错时会把包装进加载器永不查看的地方并静默失败）。
 *
 * 这些操作涉及子进程（npm），不属于 core 内核职责，因此从 App 抽出到独立插件；
 * 底层子进程统一走 api-process。
 */
export interface PackageManagerService {
  /** 装进根 `dependencies` + node_modules，随后 rescan 让加载器发现它；只接受插件与前端界面包 */
  install(npmPkg: string): Promise<{ ok: boolean; message: string }>;
  /** 从根 `dependencies` 摘掉并 npm uninstall；闸在服务层（类型 / 撤销通道 / 来源 / 服务依赖者） */
  uninstall(pluginName: string): Promise<{ ok: boolean; message: string }>;
  /**
   * 卸载 name 会打断哪些活跃插件：name 提供的某服务没有别的提供者，而它们 required 该服务。
   * 卸载闸与市场的卸载前预警共用这一份判定。name 按插件定义 name 查。
   */
  serviceDependents(name: string): string[];
  /**
   * 批量更新到指定版本，随后重启进程接管。
   *
   * **必须整批提交**，不能每个包各调一次：
   * - peer 冲突只有对整张版本映射一次预检才能发现（A@new 要 core>=0.10、B@new 要
   *   core<0.10，逐个预检各自都过，一起装才冲突）；
   * - 更新是文件系统操作而进程只在启动那一刻读文件系统，所以重启次数恒为 1，
   *   与改了多少个包无关。逐个更新 = 重启 N 次，且中间态是半新半旧。
   *
   * 返回 `ok: true` 表示已提交安装并即将重启——此时 HTTP 响应要抢在进程退出前发出。
   */
  update(targets: UpdateTarget[]): Promise<UpdateResult>;
}

/** 一个待更新目标：包名 + 目标版本（不带范围符，由调用方从市场卡片取 npm latest）。 */
export interface UpdateTarget {
  name: string;
  version: string;
}

export interface UpdateResult {
  ok: boolean;
  message: string;
  /** 预检失败时的逐条冲突说明（npm dry-run 的报告摘要），供前端直接展示。 */
  conflicts?: string[];
  /** 本次是否会重启进程。ok 且 restarting 时前端应进入「等待重连」状态。 */
  restarting?: boolean;
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const packageManager = defineService<PackageManagerService>('package-manager');
