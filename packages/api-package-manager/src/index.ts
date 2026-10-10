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
  install(npmPkg: string): Promise<InstallResult>;
  /**
   * 从根 `dependencies` 摘掉并 npm uninstall，卸掉它的全部实例并清掉它们的停用标记；闸在服务层（类型 / 撤销通道 / 来源 /
   * 服务依赖者）。配置文档没写成时包已卸掉，ok 仍为 true，message 写明原因与要手动处理的残留
   */
  uninstall(pluginName: string, options?: UninstallOptions): Promise<{ ok: boolean; message: string }>;
  /**
   * 卸载 name 会打断哪些插件：name 的某个实例正在提供（已激活或激活中）或马上就提供（pending 而只是在等，按 api-doctor
   * 的共享判据）的某服务没有别的插件正在提供，而它们 required 该服务（已禁用的不算）；name 的实例都没在提供时（失败、停用、
   * pending 而缺服务）卸掉它断不了谁，为空。卸载闸与市场的卸载前预警共用这一份判定。
   * name 是插件定义 name；市场的预警按 npm 包名近似，定义 name 与包名不同的插件在那里查不到、预警为空，
   * 卸载闸按解析出的定义 name 查，不受影响。
   */
  serviceDependents(name: string): string[];
  /**
   * 安装与更新实际使用的 npm 源：在项目根执行 `npm config get registry` 的结果（去掉尾部斜杠），首次成功后缓存。
   * 查询失败时拒绝且不缓存，下次调用重查。市场的最新版与「可更新」按它查，才与真正装到的版本一致；
   * 作用域源（`@scope:registry`）不在此列。
   */
  registry(): Promise<string>;
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

/** 安装的结果 */
export interface InstallResult {
  ok: boolean;
  message: string;
  /**
   * 装上的插件已登记时是它的主实例 id（加载器解析出的定义 name，可能与包名不同），界面据它打开这个插件；
   * 前端界面这类不进插件列表的包、以及没装成的不给
   */
  plugin?: string;
}

/** 卸载的选项 */
export interface UninstallOptions {
  /**
   * 同时删掉它各实例在配置文档里的配置段，落盘后只有这些段引用的密钥随之删除。缺省为 false：配置段与密钥留着，
   * 重装后照原配置启动，与在终端里 npm uninstall 一致
   */
  removeConfig?: boolean;
}

/** 一个待更新目标：包名 + 目标版本（不带范围符，由调用方从市场卡片取安装源上的 latest）。 */
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

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
export const packageManager = defineService<PackageManagerService>('package-manager');
