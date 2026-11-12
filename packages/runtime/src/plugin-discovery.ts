import type { PluginSourceService } from '@aalis/api-plugin-source';
import { type App, type PluginDefinition, type PluginRegistration, parseInstanceId } from '@aalis/core';
import type { ConfigStore } from './config-store.js';
import { describeDangling } from './secrets.js';

// ============================================================
// plugin-discovery —— 插件发现与自动加载（宿主层）
//
// core 只接收定义好的插件（app.plugin / app.pluginAll）。「插件从哪里来」由加载器回答，
// 「发现到的怎么交给 core」在这里：先把本轮发现的定义全部导入，再连同配置文档里各实例的配置与
// 禁用标记整批交给 core——整批登记后只重算一次，依赖方在同一次重算里排在全部提供者之后激活，
// 不会先挂到先登记的后备提供者上。
// 本模块自身不碰 node:*，但 runtime 包入口会引入 node 模块；非 Node 宿主要自备这层驱动。
// ============================================================

/**
 * 已发现但尚未导入的插件条目。`source` 是 loader 自己理解的字符串
 * （fs loader 用绝对路径，URL loader 用 URL，内存 loader 用 module 别名）。
 */
export interface PluginDescriptor {
  /** 插件名，等于包名：这个条目导出的定义 `name` 必须与它相同，不一致的拒载；按它去重、认出已登记的 */
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

export interface PluginDiscoveryOptions {
  /**
   * 每一批（冷启动一批、每次热扫描一批）定下要登记的定义后、交给 core 之前调用一次（宿主的配置同步政策 withPluginConfigSync
   * 挂在这里），返回其中准备好的；没准备好的由它记下，不登记。被拒载、去重或已登记而跳过的不经过它
   */
  prepare(definitions: PluginDefinition[]): PluginDefinition[];
}

export interface PluginDiscovery extends PluginSourceService {
  /** 冷启动：发现并导入全部插件，整批注册，返回时已静置 */
  loadAll(): Promise<void>;
  /**
   * 登记配置文档里尚未注册的 `name:suffix` 实例，模块取注册表里该模块在册实例的定义（主实例优先）；判据与冷启动、热扫描相同。
   * 配置热重载在同步文档之后调用。不等静置。
   */
  registerConfiguredInstances(): Promise<void>;
}

/**
 * 模块在注册表里的定义：主实例在册取主实例的，否则取同模块任一在册实例的（主实例已卸载、后缀实例还在时）。
 * 由配置段定义、还没登记的后缀实例按它登记或新建：热重载登记、配置同步与 host-config 新建实例同一判据
 */
export function moduleDefinitionOf(app: App, moduleName: string): PluginDefinition | undefined {
  const main = app.plugins.getPlugin(moduleName)?.definition;
  if (main) return main;
  for (const status of app.plugins.getStatus()) {
    if (status.name !== moduleName) continue;
    const definition = app.plugins.getPlugin(status.instanceId)?.definition;
    if (definition) return definition;
  }
  return undefined;
}

/**
 * @param doc 配置文档：登记时按实例 id 取配置（解析密钥引用后交给 core）与禁用标记，并从中枚举 `name:suffix` 实例。
 *   默认值回填与密钥拆出由 `options.prepare`（宿主的配置同步政策）先写进文档。
 */
export function createPluginDiscovery(
  app: App,
  loader: PluginLoader,
  doc: Pick<ConfigStore, 'get' | 'isPluginDisabled' | 'resolvePluginConfig'>,
  options?: PluginDiscoveryOptions,
): PluginDiscovery {
  const log = app.logger;

  const registration = (definition: PluginDefinition, instanceId = definition.name): PluginRegistration => {
    const { config, dangling } = doc.resolvePluginConfig(instanceId, definition.configSchema);
    if (dangling.length > 0) log.error(describeDangling(instanceId, dangling).source);
    return { definition, instanceId, config, disabled: doc.isPluginDisabled(instanceId) };
  };

  /** 经本驱动交给 core 的定义：插件来源据此回答注册表里以某个名字登记的是不是经它登记的 */
  const ours = new WeakSet<PluginDefinition>();

  /** 以 name 登记的主实例是不是经本驱动登记的；没登记或宿主直接登记的为 false */
  const isOurs = (name: string): boolean => {
    const registered = app.plugins.getPlugin(name)?.definition;
    return registered !== undefined && ours.has(registered);
  };

  /**
   * 导入一批描述符并备好各自的登记项；单个失败（含 id 撞上危险键、文档拒取）只记该条，不拖累其余。
   * 插件名即包名，是登记的身份：名字已登记的、同一批里已导入过同名一份的，在导入之前跳过；导入后定义名与包名不同的拒载。
   * 只有导入成了的那份占名：前面的没导入成（导入失败、拒载）时照常导入后面同名的。
   * 跳过与拒载都在 prepare 之前：留给 core 去拒收为时已晚，它们的 schema 已同步进同名的配置段。prepare 整批调用一次
   */
  async function importAll(descriptors: PluginDescriptor[], fresh: boolean): Promise<PluginRegistration[]> {
    const imported: PluginDefinition[] = [];
    const seen = new Map<string, PluginDescriptor>();
    for (const desc of descriptors) {
      if (app.plugins.getPlugin(desc.name)) {
        // 经本驱动登记过的是已加载的包，不再导入；宿主直接登记的占着这个名字
        if (!isOurs(desc.name)) log.warn(`插件 "${desc.name}" 已由宿主直接登记，跳过发现到的同名包`);
        continue;
      }
      const first = seen.get(desc.name);
      if (first) {
        log.warn(`插件 "${desc.name}" 发现了两份（${first.source} 与 ${desc.source}），只加载前一份`);
        continue;
      }
      try {
        // 加载器已按入口约定判定（pluginDefinitionOf），不是插件返回 null
        const definition = fresh && loader.reload ? await loader.reload(desc) : await loader.load(desc);
        if (!definition) continue;
        if (definition.name !== desc.name) {
          log.error(`插件包 "${desc.name}" 的定义 name 是 "${definition.name}"，必须与包名相同，已拒绝加载`);
          continue;
        }
        // 导入途中并发的另一次热扫描已登记了它
        if (app.plugins.getPlugin(desc.name)) continue;
        seen.set(desc.name, desc);
        imported.push(definition);
      } catch (err) {
        log.error(`加载插件 "${desc.name}" 失败:`, err);
      }
    }
    const loaded: PluginRegistration[] = [];
    for (const definition of options ? options.prepare(imported) : imported) {
      try {
        loaded.push(registration(definition));
        ours.add(definition);
      } catch (err) {
        log.error(`加载插件 "${definition.name}" 失败:`, err);
      }
    }
    return loaded;
  }

  /**
   * 配置键里的 `name:suffix` 实例：模块查得到定义才登记，已在注册表的跳过。模块的定义取这一批新登记的（`batch`），
   * 没有就取注册表里该模块在册实例的（{@link moduleDefinitionOf}）：插件名已登记的包不再导入，
   * 它的后缀实例跟已登记的定义走，与主实例跑同一份代码。
   * 冷启动、热扫描与热重载共用，任何一处都不得少收
   */
  function configuredInstances(batch: ReadonlyMap<string, PluginDefinition> = new Map()): PluginRegistration[] {
    const items: PluginRegistration[] = [];
    for (const configKey of Object.keys(doc.get('plugins') ?? {})) {
      const { moduleName, suffix } = parseInstanceId(configKey);
      if (!suffix || app.plugins.getPlugin(configKey)) continue;
      const definition = batch.get(moduleName) ?? moduleDefinitionOf(app, moduleName);
      if (definition) items.push(registration(definition, configKey));
      else log.warn(`多实例配置 "${configKey}" 对应的模块 "${moduleName}" 未找到，跳过`);
    }
    return items;
  }

  /**
   * 单实例配置段找不到对应插件（多为直接 `npm uninstall` 后残留）：冷启动时逐段告警一次。
   * 发现到却没登记上的（导入失败、定义校验不过）已有加载错误，不重复报；多实例键由 {@link configuredInstances} 报。
   */
  function warnOrphanedConfig(discovered: PluginDescriptor[]): void {
    const attempted = new Set(discovered.map(d => d.name));
    for (const configKey of Object.keys(doc.get('plugins') ?? {})) {
      if (parseInstanceId(configKey).suffix) continue;
      if (attempted.has(configKey) || app.plugins.getPlugin(configKey)) continue;
      log.warn(`配置段 "${configKey}" 对应的插件未找到，已忽略；若已卸载可删除该段（其中可能含密钥）`);
    }
  }

  return {
    async loadAll() {
      const discovered = await loader.discover();
      log.info(`发现 ${discovered.length} 个插件`);
      const loaded = await importAll(discovered, false);
      const known = new Map(loaded.map(item => [item.definition.name, item.definition]));
      warnOrphanedConfig(discovered);
      await app.pluginAll([...loaded, ...configuredInstances(known)]);
      // 就绪回调的时机依赖「返回即全部收敛」；引导路径不在任何 apply 内，无自等死锁面。
      await app.plugins.idle();
    },

    async rescan() {
      const loaded = await importAll(await loader.discover(), true);
      const known = new Map(loaded.map(item => [item.definition.name, item.definition]));
      const results = await app.pluginAll([...loaded, ...configuredInstances(known)]);
      // core 拒收的（定义校验不过、已在停机等）不算热加载，不报进名单
      const names = loaded.filter((_, i) => results[i]).map(item => item.definition.name);
      for (const name of names) log.info(`热加载插件: ${name}`);
      return names;
    },

    async registerConfiguredInstances() {
      // 主实例已卸载时用同模块任一在册实例的定义，与冷启动时这一段照常登记一致
      await app.pluginAll(configuredInstances());
    },

    loaded: isOurs,
  };
}
