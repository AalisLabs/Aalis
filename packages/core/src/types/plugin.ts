// ----- 插件系统类型与纯辅助函数 -----
//
// 与运行时实现 (PluginManager) 分离，避免下游消费者只为类型而拉入 class。
// 实现详见 ../orchestration/plugin.ts。

import type { PluginDefinition } from '../context/definition.js';

// ----- 插件状态 -----

export type PluginState = 'pending' | 'activating' | 'active' | 'disabled' | 'disposed' | 'error';

/** 注册表里的一条插件实例（管理面经 `plugins.getPlugin` 读到的形状） */
export interface PluginEntry {
  definition: PluginDefinition;
  /** 实例 ID：单实例时与 definition.name 相同，多实例时为 `name:suffix` */
  instanceId: string;
  config: Record<string, unknown>;
  state: PluginState;
  error?: string;
  /** 参与激活闸的依赖服务名（uses 里未包 optional 的外部服务） */
  required: string[];
  /** 不参与激活闸的依赖服务名 */
  optional: string[];
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
