// ============================================================
// host-services.ts — 宿主管理面的服务描述符与窄面
//
// App 在根激活上提供的普通调用型服务。管理类插件（WebUI、市场、CLI）在 uses 里显式声明才拿得到；
// 插件自己的配置视图是内置能力 `config`。配置文档（host-config）由宿主提供，不在这里。
// 提供方只交出契约列出的方法：App / PluginManager 本体（含原始注册表、停机开关）不进容器。
// ============================================================

import type { AppService, PluginManagerService } from '../types/app.js';

import { defineService } from '../composition/descriptors.js';

export const appService = defineService<AppService>('app');
export const pluginsService = defineService<PluginManagerService>('plugins');

/** 只交出列出的方法（绑定到源对象），源对象本身不外露 */
export function narrow<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(
    keys.map(key => [key, (source[key] as (...args: unknown[]) => unknown).bind(source)]),
  ) as Pick<T, K>;
}
