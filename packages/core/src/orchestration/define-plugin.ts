// ============================================================
// define-plugin.ts — 插件定义入口
//
// 插件声明它用到的服务（描述符），apply 拿到按这次激活绑定的接口；不接收 Context。
// 原型期返回值同时满足现行 PluginModule 形状，让调度器零改动地跑新形式；
// 完整迁移后调度器直接认定义对象，apply(ctx) 形状删除。
// ============================================================

import type { AppService, PluginManagerService } from '../types/app.js';
import type { PluginMeta, PluginModule } from '../types/plugin.js';

import {
  assemble,
  type BoundOf,
  defineService,
  optionalNames,
  requiredNames,
  type ServiceDescriptor,
  type Uses,
} from '../context/binding.js';
import { type ModuleDefinition, setActivationConfig } from '../context/builtins.js';
import type { ConfigManager } from '../context/config.js';
import type { Context } from '../context/context.js';

// biome-ignore lint/complexity/noBannedTypes: 无声明时的空声明表
export interface PluginDefinition<U extends Uses = {}> extends PluginMeta {
  name: string;
  displayName?: string;
  /**
   * 用到的全部能力：键是 apply 里的参数名，值是描述符（内置能力从 @aalis/core、其余从契约包导入）；
   * 可选依赖包一层 optional()。没有默认注入——这里写了什么，插件就只能碰到什么。
   */
  uses?: U;
  /** 本插件提供的服务（激活后校验确已提供） */
  // biome-ignore lint/suspicious/noExplicitAny: 描述符泛型只作推导载体
  provides?: ServiceDescriptor<any, any>[];
  core?: boolean;
  reusable?: boolean;
  apply(caps: BoundOf<U>): void | Promise<void>;
}

// biome-ignore lint/complexity/noBannedTypes: 同上
export function definePlugin<U extends Uses = {}>(definition: PluginDefinition<U>): PluginModule & ModuleDefinition {
  const uses = (definition.uses ?? {}) as Uses;
  for (const [key, use] of Object.entries(uses)) {
    const descriptor = (use as { optional?: unknown } | null)?.optional ?? use;
    if (typeof (descriptor as { bind?: unknown } | null)?.bind !== 'function') {
      throw new Error(`插件 "${definition.name}" 的 uses.${key} 不是服务描述符（应为 defineService 的结果）`);
    }
  }
  const requires = requiredNames(uses);

  const mount = (ctx: Context, config: Record<string, unknown>): void | Promise<void> => {
    setActivationConfig(ctx, config);
    // 任一 bind 抛错 → 这里抛出 → 激活路径拆掉 ctx，已装配部分经撤回段回滚
    return definition.apply(assemble(ctx, uses) as BoundOf<U>);
  };

  // 元数据（PluginMeta 上经 declaration merging 挂进来的字段，如 configSchema / subsystem）原样带上
  const { uses: _uses, provides, apply: _apply, ...meta } = definition;
  return {
    ...meta,
    inject: { required: requires, optional: optionalNames(uses) },
    provides: provides?.map(d => d.name),
    apply: mount,
    requires,
    mount,
  };
}

/**
 * 宿主管理面：App 在根激活上提供的普通调用型服务，管理类插件显式声明才拿得到。
 * 插件自己的配置视图是内置能力 `config`；这里的 hostConfig 是整份配置的读写与落盘。
 */
export const appService = defineService<AppService>('app');
export const pluginsService = defineService<PluginManagerService>('plugins');
export const hostConfig = defineService<ConfigManager>('host-config');
