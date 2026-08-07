// ----- App 服务接口 -----

import type { PluginEntry, PluginState } from './plugin.js';

/**
 * App 生命周期 + 配置 + 市场 接口
 *
 * 插件通过 `ctx.getService<AppService>('app')` 获取，用于触发应用级操作，无需直接导入 App 类。
 *
 * **必须显式写类型参数**：`ServiceTypeMap` 在 core 内保持字面为空（条目一律由 `-api` 包
 * 就近注入），所以 `getService('app')` 不带参数会落到 `<T = unknown>` 兜底重载。
 */
export interface AppService {
  /** 停止应用 */
  stop(): Promise<void>;
  /** 重启应用（延迟 spawn 新进程后退出当前进程） */
  /**
   * 重启应用（延迟 spawn 新实例后退出当前实例；具体机制由宿主注入的 RestartStrategy 决定）。
   *
   * @param opts.rollback 不透明回滚凭据，仅在「新实例未能接管」时由策略消费。
   *   形状由宿主策略与发起方约定，core 只透传（见 `RestartStrategy`）。
   */
  restart(opts?: { rollback?: unknown }): void;
  /** 保存配置到磁盘 */
  saveConfig(): void;

  /** 重新扫描 packages/ 目录，返回新发现并加载的插件名列表 */
  rescanPlugins(): Promise<string[]>;
}

/** PluginManager 暴露给插件消费的接口 */
export interface PluginStatusEntry {
  name: string;
  instanceId: string;
  displayName?: string;
  state: PluginState;
  provides?: string[];
  core?: boolean;
  reusable?: boolean;
  /** 必需依赖的服务名（来自 inject.required，能力披露用：该插件「要调用哪些子系统」） */
  requiredServices?: string[];
  /** 可选依赖的服务名（来自 inject.optional） */
  optionalServices?: string[];
  error?: string;
  // 配置详情（config / configSchema）不属状态摘要——
  // 消费者经 getPlugin(instanceId) 从 entry.config / entry.module 读取。
}

/**
 * 插件管理服务接口
 *
 * 通过 `ctx.getService<PluginManagerService>('plugins')` 获取（**必须显式写类型参数**，
 * 理由同 {@link AppService}）。内部由 core 的 PluginManager 提供，消费方不应直接 import App 类。
 */
export interface PluginManagerService {
  /** 获取所有已注册插件的状态 */
  getStatus(): PluginStatusEntry[];
  /** 获取单个插件条目 */
  getPlugin(name: string): PluginEntry | undefined;
  /** 更新插件配置（自动触发软重载） */
  updatePluginConfig(name: string, config: Record<string, unknown>): Promise<boolean>;
  /** 启用插件 */
  enablePlugin(name: string): Promise<boolean>;
  /** 禁用插件 */
  disablePlugin(name: string): Promise<boolean>;
  /** 彻底卸载插件：dispose 上下文并从注册表移除（用于市场卸载，区别于 disablePlugin 仅置禁用态） */
  unload(name: string): Promise<void>;
  /** 注册并尝试激活一个插件模块（多实例经 instanceId 区分；供管理面基于 register/unload 组合实例编排） */
  register(module: PluginEntry['module'], config?: Record<string, unknown>, instanceId?: string): Promise<void>;
  /**
   * 等待插件状态机静置（无在飞/排队的 recompute）。变更 API 在 flight 在飞时
   * 排队早退，需要"尘埃落定后再观察"的调用方在变更后 await 本方法。
   * ⚠． 不得在插件 apply / onDispose 内调用（互等死锁）。
   */
  idle(): Promise<void>;
}
