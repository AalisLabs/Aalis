// ----- 插件系统类型与纯辅助函数 -----
//
// 与运行时实现 (PluginManager) 分离，避免下游消费者只为类型而拉入 class。
// 实现详见 ../plugin.ts。

import type { Context } from '../context.js';
import type { ConfigSchema, InjectDeclaration } from './core.js';

// 注：NormalizedDependency 来自 types/service.ts，但为避免在 PluginEntry
// 中再循环引入，这里直接 import type。
import type { NormalizedDependency } from './service.js';

// ----- 插件定义格式 -----

export interface PluginModule {
  name: string;
  /** 插件的显示名称，用于前端展示 */
  displayName?: string;
  inject?: InjectDeclaration;
  provides?: string[];
  /** 标记为 core 的插件不能被用户禁用 */
  core?: boolean;
  /**
   * 是否允许同一插件以不同配置多次加载（多实例）
   *
   * 默认 false：同一 module 只能注册一次（防止重复注册命令等副作用）。
   * 设为 true 后，可通过 `name:suffix` 格式注册多个实例，
   * 每个实例拥有独立的 Context、配置和 contextId。
   *
   * 适合多实例的插件：LLM adapters、embedding adapters、platform adapters、memory backends。
   */
  reusable?: boolean;
  /** 配置 Schema，用于前端自动生成配置表单 */
  configSchema?: ConfigSchema;
  /** 插件默认配置，当主配置文件中无此插件配置时使用 */
  defaultConfig?: Record<string, unknown>;
  /**
   * 通用命名的插件 RPC 动作表 —— 供 host （如 WebUI / CLI / IPC 层）远程调用。
   *
   * core 不负责调起，仅存为传输插槽；在 listPlugins() 中以 `actionNames`
   * （顶层 key 列表）导出，供 host 路由。调用方使用 host 提供的
   * `entry.context` 及 args 调用 handler；core 本身不感知 webui/cli 这样的
   * 具体消费者。
   */
  actions?: Record<string, (ctx: Context, args: Record<string, unknown>) => Promise<unknown>>;
  /**
   * 逃生舱：声明本插件在依赖的 provider 发生变化（被 dispose / 替换）时
   * 必须由 core 主动级联 dispose + reapply 才能恢复正确状态。
   *
   * 默认 `false`：core **不会**主动级联 bounce 下游。绝大多数插件应让
   * `ctx.getService(...)` 在 handler/方法体内每次惰性查询，从而天然跟随
   * provider 切换，无需 bounce。
   *
   * 仅当插件无法响应式处理状态（如必须在启动期一次性把 provider 引用
   * 缓存到第三方 SDK 内部、或必须在 apply 时跑昂贵的同步初始化）时设为
   * `true`。第三方插件开发者迁移成本太高时也可以临时打开。
   */
  requiresBounceOnDepChange?: boolean;
  apply(ctx: Context, config: Record<string, unknown>): void | Promise<void>;
  // 注：subsystem / extends 等纯 WebUI 展示元数据由
  // @aalis/plugin-webui-api 通过 declaration merging 注入；core 不读取它们，
  // 仅在 listPlugins() 中以 unknown 类型透传。
  // webuiPages 已迁移到 useWebuiService(ctx).registerPage()。
}

// ----- 插件状态 -----

export type PluginState = 'pending' | 'activating' | 'active' | 'disabled' | 'disposed' | 'error';

/**
 * recompute() 的触发原因。所有导致插件库状态需重新计算的事件
 * 都收拢到这个判别联合上，让 PluginManager 只有一条状态转移路径。
 *
 * - service-up：某服务刚被 provide —— 可能让 pending 插件能激活
 * - service-down：某服务刚被 unregister —— required 依赖其的要停用，
 *   optional 依赖其的要 bounce（重新 apply 以对接可能的新实例）
 * - plugin-state-changed：插件被显式禁用/启用/重载/改配置后调用
 * - shutdown：App.stop() 调用，按拓扑逆序 dispose 所有插件
 */
export type RecomputeReason =
  | { type: 'service-up'; service: string }
  | { type: 'service-down'; service: string }
  | { type: 'plugin-state-changed' }
  | { type: 'shutdown' };

export interface PluginEntry {
  module: PluginModule;
  /** 实例 ID：单实例时与 module.name 相同，多实例时为 `name:suffix` */
  instanceId: string;
  config: Record<string, unknown>;
  state: PluginState;
  error?: string;
  context?: Context;
  requiredDeps: NormalizedDependency[];
  optionalDeps: NormalizedDependency[];
}

/**
 * 解析插件实例 ID
 *
 * 格式：`@scope/plugin-name:suffix` → { moduleName: '@scope/plugin-name', suffix: 'suffix' }
 * 无 suffix 时返回 { moduleName, suffix: undefined }
 */
export function parseInstanceId(instanceId: string): { moduleName: string; suffix?: string } {
  // 从右侧找最后一个冒号，但跳过 scope 中的冒号
  // 格式: @scope/name:suffix 或 name:suffix
  const slashIdx = instanceId.indexOf('/');
  const searchFrom = slashIdx >= 0 ? slashIdx + 1 : 0;
  const colonIdx = instanceId.indexOf(':', searchFrom);
  if (colonIdx < 0) return { moduleName: instanceId };
  return {
    moduleName: instanceId.slice(0, colonIdx),
    suffix: instanceId.slice(colonIdx + 1),
  };
}
