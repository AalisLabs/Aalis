import type { PluginSourceService } from '@aalis/api-plugin-source';
import { type App, type PluginDefinition, parseInstanceId } from '@aalis/core';

// ============================================================
// plugin-discovery —— 插件发现与自动加载（宿主层）
//
// core 只接收定义好的插件（app.plugin / app.pluginAll）。「插件从哪里来」由加载器回答，
// 「发现到的怎么交给 core」在这里：先把本轮发现的定义全部导入，再整批交给 core——整批落账后
// 只重算一次，依赖方在同一次重算里排在全部提供者之后激活，不会先挂到先登记的后备提供者上。
// 本模块自身不碰 node:*，但 runtime 包入口会引入 node 模块；非 Node 宿主要自备这层驱动。
// ============================================================

/**
 * 已发现但尚未导入的插件条目。`source` 是 loader 自己理解的字符串
 * （fs loader 用绝对路径，URL loader 用 URL，内存 loader 用 module 别名）。
 */
export interface PluginDescriptor {
  /** 插件名，与定义的 `name` 一致；按它跳过已注册者 */
  name: string;
  /** 给 loader 自己用的不透明定位串 */
  source: string;
  /** loader 可挂任意辅助元数据（cache key、版本号、manifest 等） */
  metadata?: Record<string, unknown>;
}

/**
 * 插件加载器：负责"插件从哪里来"。
 *
 * - `discover()` 列出当前可用的插件条目
 * - `load(descriptor)` 把条目导入成插件定义（模块默认导出的 definePlugin 产物）；不是插件返回 null
 * - `reload(descriptor)` 可选——热扫描时用（fs loader 用 mtime 做 cache buster），不提供时退化为 `load()`
 */
export interface PluginLoader {
  discover(): Promise<PluginDescriptor[]>;
  load(descriptor: PluginDescriptor): Promise<PluginDefinition | null>;
  reload?(descriptor: PluginDescriptor): Promise<PluginDefinition | null>;
}

export interface PluginDiscovery extends PluginSourceService {
  /** 冷启动：发现并导入全部插件，整批注册，返回时已静置 */
  loadAll(): Promise<void>;
}

type Registration = Parameters<App['pluginAll']>[0][number];

export function createPluginDiscovery(app: App, loader: PluginLoader): PluginDiscovery {
  const log = app.logger;

  /** 导入一批描述符；单个失败只记该条，不拖累其余 */
  async function importAll(descriptors: PluginDescriptor[], fresh: boolean) {
    const loaded: Array<{ desc: PluginDescriptor; definition: PluginDefinition }> = [];
    for (const desc of descriptors) {
      try {
        // 加载器已按入口约定判定（pluginDefinitionOf），不是插件返回 null；定义本身的校验在注册时做
        const definition = fresh && loader.reload ? await loader.reload(desc) : await loader.load(desc);
        if (!definition) continue;
        loaded.push({ desc, definition });
      } catch (err) {
        log.error(`加载插件 "${desc.name}" 失败:`, err);
      }
    }
    return loaded;
  }

  /** 配置键里的 `name:suffix` 实例：模块在 known 里才登记，已在注册表的跳过。冷启动与热扫描共用，热扫描不得少收 */
  function configuredInstances(known: Map<string, PluginDefinition>): Registration[] {
    const items: Registration[] = [];
    for (const configKey of Object.keys(app.config.get('plugins') ?? {})) {
      const { moduleName, suffix } = parseInstanceId(configKey);
      if (!suffix || app.plugins.getPlugin(configKey)) continue;
      const definition = known.get(moduleName);
      if (definition) items.push({ definition, instanceId: configKey });
      else log.warn(`多实例配置 "${configKey}" 对应的模块 "${moduleName}" 未找到，跳过`);
    }
    return items;
  }

  return {
    async loadAll() {
      const discovered = await loader.discover();
      log.info(`发现 ${discovered.length} 个插件`);
      const loaded = await importAll(discovered, false);
      const known = new Map(loaded.map(({ definition }) => [definition.name, definition]));
      await app.pluginAll([...loaded.map(({ definition }) => ({ definition })), ...configuredInstances(known)]);
      // app:ready / app:started 的发出时机依赖「返回即全部收敛」；引导路径不在任何 apply 内，无自等死锁面。
      await app.plugins.idle();
    },

    async rescan() {
      const known = new Map<string, PluginDefinition>();
      const fresh: PluginDescriptor[] = [];
      for (const desc of await loader.discover()) {
        const registered = app.plugins.getPlugin(desc.name);
        if (registered) known.set(registered.definition.name, registered.definition);
        else fresh.push(desc);
      }
      const loaded = await importAll(fresh, true);
      for (const { definition } of loaded) known.set(definition.name, definition);
      const results = await app.pluginAll([
        ...loaded.map(({ definition }) => ({ definition })),
        ...configuredInstances(known),
      ]);
      // 模块自报的 name 与描述符不同且已注册时 register 会拒绝——那不算热加载，不报进名单。
      const names = loaded.filter((_, i) => results[i]).map(({ desc }) => desc.name);
      for (const name of names) log.info(`热加载插件: ${name}`);
      return names;
    },
  };
}
