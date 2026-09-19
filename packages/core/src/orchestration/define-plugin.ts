// ============================================================
// define-plugin.ts — 插件定义入口
//
// 插件声明它用到的服务（描述符），apply 拿到按这次激活绑定的接口；不接收 Context。
// 原型期返回值同时满足现行 PluginModule 形状，让调度器零改动地跑新形式；
// 完整迁移后调度器直接认定义对象，apply(ctx) 形状删除。
// ============================================================

import type { AppService, PluginManagerService } from '../types/app.js';
import type { PluginModule } from '../types/plugin.js';

import {
  assemble,
  type BoundOf,
  defineService,
  optionalNames,
  requiredNames,
  type ServiceDescriptor,
  type Uses,
} from '../context/binding.js';
import {
  type DefaultCaps,
  defaultUses,
  isKernelService,
  type ModuleDefinition,
  setActivationConfig,
} from '../context/builtins.js';
import type { Context } from '../context/context.js';

// biome-ignore lint/complexity/noBannedTypes: 无声明时的空声明表
export interface PluginDefinition<U extends Uses = {}> {
  name: string;
  displayName?: string;
  /** 用到的服务：键是 apply 里的参数名，值是契约包导出的描述符；可选依赖包一层 optional() */
  uses?: U;
  /** 本插件提供的服务（激活后校验确已提供） */
  // biome-ignore lint/suspicious/noExplicitAny: 描述符泛型只作推导载体
  provides?: ServiceDescriptor<any, any>[];
  core?: boolean;
  reusable?: boolean;
  apply(caps: BoundOf<U> & DefaultCaps): void | Promise<void>;
}

// biome-ignore lint/complexity/noBannedTypes: 同上
export function definePlugin<U extends Uses = {}>(definition: PluginDefinition<U>): PluginModule & ModuleDefinition {
  const declared = (definition.uses ?? {}) as Uses;
  for (const [key, use] of Object.entries(declared)) {
    if (key in defaultUses) throw new Error(`插件 "${definition.name}" 的 uses 键 "${key}" 与默认注入重名`);
    const descriptor = (use as { optional?: unknown } | null)?.optional ?? use;
    if (typeof (descriptor as { bind?: unknown } | null)?.bind !== 'function') {
      throw new Error(`插件 "${definition.name}" 的 uses.${key} 不是服务描述符（应为契约包导出的 defineService 结果）`);
    }
  }
  const all = { ...defaultUses, ...declared } as Uses;
  const gated = Object.fromEntries(
    Object.entries(all).filter(([, use]) => !isKernelService('optional' in use ? use.optional : use)),
  );

  const mount = (ctx: Context, config: Record<string, unknown>): void | Promise<void> => {
    setActivationConfig(ctx, config);
    // 任一 bind 抛错 → 这里抛出 → 激活路径拆掉 ctx，已装配部分经撤回段回滚
    return definition.apply(assemble(ctx, all) as BoundOf<U> & DefaultCaps);
  };

  return {
    name: definition.name,
    displayName: definition.displayName,
    core: definition.core,
    reusable: definition.reusable,
    inject: { required: requiredNames(gated), optional: optionalNames(gated) },
    provides: definition.provides?.map(d => d.name),
    apply: mount,
    mount,
  };
}

/** 宿主管理面：App 在根激活上提供的两个普通调用型服务。管理类插件显式声明才拿得到。 */
export const appService = defineService<AppService>('app');
export const pluginsService = defineService<PluginManagerService>('plugins');
