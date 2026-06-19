// ----- App 服务接口 -----

import type { ConfigSchema } from './core.js';
import type { PluginEntry, PluginState } from './plugin.js';

/**
 * App 生命周期 + 配置 + 市场 接口
 *
 * 插件通过 `ctx.getService('app')` 获取，
 * 用于触发应用级操作，无需直接导入 App 类。
 */
export interface AppService {
  /** 停止应用 */
  stop(): Promise<void>;
  /** 重启应用（延迟 spawn 新进程后退出当前进程） */
  restart(): void;
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
  config: Record<string, unknown>;
  configSchema?: ConfigSchema;
  defaultConfig?: Record<string, unknown>;
  error?: string;
}

/**
 * 插件管理服务接口
 *
 * 通过 `ctx.getService('plugins')` 获取。
 * 内部由 core 的 PluginManager 提供。消费方不应直接 import App 类。
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
  /** 基于 reusable 插件创建新实例，返回 instanceId */
  createInstance(moduleName: string, suffix: string, config?: Record<string, unknown>): Promise<string | undefined>;
  /** 删除实例 */
  removeInstance(instanceId: string): Promise<boolean>;
}

declare module './services.js' {
  interface ServiceTypeMap {
    app: AppService;
    plugins: PluginManagerService;
  }
}
