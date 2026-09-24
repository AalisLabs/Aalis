// ----- 插件系统类型与纯辅助函数 -----
//
// 与运行时实现 (PluginManager) 分离，避免下游消费者只为类型而拉入 class。
// 实现详见 ../orchestration/plugin.ts。

import type { PluginDefinition } from '../composition/plugin-definition.js';

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
 * 格式：`@scope/plugin-name:suffix` 或 `plugin-name:suffix` → { moduleName, suffix }；无 suffix 时 suffix 为 undefined。
 * 模块名是 npm 包名，不含 ':'，所以第一个 ':' 就是后缀的起点，后缀里可以再出现 '/' 或 ':'。
 */
export function parseInstanceId(instanceId: string): { moduleName: string; suffix?: string } {
  const colonIdx = instanceId.indexOf(':');
  if (colonIdx < 0) return { moduleName: instanceId };
  return {
    moduleName: instanceId.slice(0, colonIdx),
    suffix: instanceId.slice(colonIdx + 1),
  };
}
