/**
 * @aalis/api-plugin-source — 插件来源契约
 *
 * 插件从哪里来是宿主的事（core 只接收定义好的插件）。宿主若能在运行中重新发现插件
 * （Node 宿主扫 node_modules 或 packages/），就在根上提供本服务；打包进来的静态插件表没有
 * 可重扫的来源，不提供即可，消费方以 optional 声明。
 */

import { defineService, type PluginDefinition } from '@aalis/core';

export interface PluginSourceService {
  /**
   * 重新发现插件，登记新出现且尚未注册的（含配置里它们的 `name:suffix` 实例）。
   * 返回本次新登记的主实例名。resolve = 落账 + 尽力即时激活，不等静置；
   * 要判断某个插件是否就位，看 plugins 服务的注册表，不看返回值。
   */
  rescan(): Promise<string[]>;
}

export const pluginSource = defineService<PluginSourceService>('plugin-source');

/**
 * 插件包的入口约定：模块的 default 须是 `definePlugin` 的产物（带非空 name 与 apply 的对象）。
 * 对不上返回 null。加载器与包管理都走这里——「是不是插件 / 名字是什么」只有这一份判定。
 *
 * default 为函数或类不算：它们天然继承 Function.prototype.apply，只查 `.apply` 会把
 * `export default function` 误当插件，随后被调用的是 Function.prototype.apply——插件体空跑却被标记已激活。
 */
export function pluginDefinitionOf(mod: unknown): PluginDefinition | null {
  const candidate = (mod as { default?: unknown } | null)?.default as Partial<PluginDefinition> | null | undefined;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.name !== 'string' ||
    candidate.name === '' ||
    typeof candidate.apply !== 'function'
  ) {
    return null;
  }
  return candidate as PluginDefinition;
}
