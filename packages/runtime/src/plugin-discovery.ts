import type { PluginSourceService } from '@aalis/api-plugin-source';
import { type App, definePlugin, type PluginDefinition, type PluginRegistration, parseInstanceId } from '@aalis/core';
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
 * - `prepare(definition)` 可选——发现驱动定下要登记的定义后、交给 core 之前逐个调用（宿主的配置同步政策挂在这里）；
 *   插件名已被别的包占下而跳过的定义不经过它
 */
export interface PluginLoader {
  discover(): Promise<PluginDescriptor[]>;
  load(descriptor: PluginDescriptor): Promise<PluginDefinition | null>;
  reload?(descriptor: PluginDescriptor): Promise<PluginDefinition | null>;
  prepare?(definition: PluginDefinition): void;
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
 *   默认值回填与密钥拆出由加载器一侧的政策（withPluginConfigSync）先写进文档。
 */
export function createPluginDiscovery(
  app: App,
  loader: PluginLoader,
  doc: Pick<ConfigStore, 'get' | 'isPluginDisabled' | 'resolvePluginConfig'>,
): PluginDiscovery {
  const log = app.logger;

  const registration = (definition: PluginDefinition, instanceId = definition.name): PluginRegistration => {
    const { config, dangling } = doc.resolvePluginConfig(instanceId, definition.configSchema);
    if (dangling.length > 0) log.error(describeDangling(instanceId, dangling).source);
    return { definition, instanceId, config, disabled: doc.isPluginDisabled(instanceId) };
  };

  /** 经本驱动交给 core 的定义 → 导出它的包（描述符名）：插件名已登记时据此说出是哪个包占下的 */
  const packageOf = new WeakMap<PluginDefinition, string>();

  /**
   * 导入一批描述符并备好各自的登记项；单个失败（含 id 撞上危险键、文档拒取）只记该条，不拖累其余。
   * 插件名是登记的身份：名字已登记或已被同一批里先发现的包占下时，后来的包跳过，占下它的是别的包就告警点名两个包。
   * 跳过要在 prepare 与备登记项之前：留给 core 去拒收为时已晚——后来者的 schema 已同步进先到者的配置段
   * （裁掉先到者的字段并落盘），配置里的后缀实例也按后来者的定义登记。
   * 包名与插件名不同的包，热扫描按包名查不到它已登记，会再导入一次：占下名字的就是它自己，照样跳过，不算冲突
   */
  async function importAll(descriptors: PluginDescriptor[], fresh: boolean) {
    const loaded: PluginRegistration[] = [];
    /** 本批已占下的插件名 → 占下它的包（描述符名） */
    const claimed = new Map<string, string>();
    /** 加载器交回的全部定义名，含随后校验不过、被跳过的：冷启动据此不把它们的配置段当孤儿 */
    const declared = new Set<string>();
    for (const desc of descriptors) {
      try {
        // 加载器已按入口约定判定（pluginDefinitionOf），不是插件返回 null。定义在占名之前按 core 的规则校验：
        // 名字只让给 core 会收下的定义，先到的过不了校验（如包里自带一份 core，描述符不是宿主的）时同名的后来者照常登记
        const definition = fresh && loader.reload ? await loader.reload(desc) : await loader.load(desc);
        if (!definition) continue;
        declared.add(definition.name);
        definePlugin(definition);
        const registered = app.plugins.getPlugin(definition.name)?.definition;
        const holder = claimed.get(definition.name) ?? (registered ? packageOf.get(registered) : undefined);
        if (holder === desc.name) continue;
        if (holder !== undefined) {
          log.warn(`包 "${desc.name}" 与 "${holder}" 声明了同一个插件名 "${definition.name}"，只加载 "${holder}"`);
          continue;
        }
        // 已登记、但不是经本驱动登记的（宿主直接登记），说不出包名
        if (registered) {
          log.warn(`包 "${desc.name}" 声明的插件名 "${definition.name}" 已登记，跳过`);
          continue;
        }
        loader.prepare?.(definition);
        loaded.push(registration(definition));
        claimed.set(definition.name, desc.name);
        packageOf.set(definition, desc.name);
      } catch (err) {
        log.error(`加载插件 "${desc.name}" 失败:`, err);
      }
    }
    return { loaded, declared };
  }

  /**
   * 配置键里的 `name:suffix` 实例：模块查得到定义才登记，已在注册表的跳过。模块的定义取这一批新登记的（`batch`），
   * 没有就取注册表里该模块在册实例的（{@link moduleDefinitionOf}）：插件名已登记的包在导入后即被跳过，
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
   * 发现到却没登记上的（导入失败、定义校验不过）已有加载错误，不重复报，按描述符名与加载器交回的定义名两样认；
   * 多实例键由 {@link configuredInstances} 报。
   */
  function warnOrphanedConfig(declared: ReadonlySet<string>, discovered: PluginDescriptor[]): void {
    const attempted = new Set(discovered.map(d => d.name));
    for (const configKey of Object.keys(doc.get('plugins') ?? {})) {
      if (parseInstanceId(configKey).suffix) continue;
      if (declared.has(configKey) || attempted.has(configKey) || app.plugins.getPlugin(configKey)) continue;
      log.warn(`配置段 "${configKey}" 对应的插件未找到，已忽略；若已卸载可删除该段（其中可能含密钥）`);
    }
  }

  return {
    async loadAll() {
      const discovered = await loader.discover();
      log.info(`发现 ${discovered.length} 个插件`);
      const { loaded, declared } = await importAll(discovered, false);
      const known = new Map(loaded.map(item => [item.definition.name, item.definition]));
      warnOrphanedConfig(declared, discovered);
      await app.pluginAll([...loaded, ...configuredInstances(known)]);
      // app:ready / app:started 的发出时机依赖「返回即全部收敛」；引导路径不在任何 apply 内，无自等死锁面。
      await app.plugins.idle();
    },

    async rescan() {
      const fresh = (await loader.discover()).filter(desc => !app.plugins.getPlugin(desc.name));
      const { loaded } = await importAll(fresh, true);
      const known = new Map(loaded.map(item => [item.definition.name, item.definition]));
      const results = await app.pluginAll([...loaded, ...configuredInstances(known)]);
      // core 拒收的（定义校验不过、已在停机等）不算热加载，不报进名单。
      // 报的是登记进注册表的主实例名（定义名），不是加载器给的描述符名（通常是包名，二者可以不同）。
      const names = loaded.filter((_, i) => results[i]).map(item => item.definition.name);
      for (const name of names) log.info(`热加载插件: ${name}`);
      return names;
    },

    async registerConfiguredInstances() {
      // 主实例已卸载时用同模块任一在册实例的定义，与冷启动时这一段照常登记一致
      await app.pluginAll(configuredInstances());
    },

    // 与 importAll 判「插件名已被哪个包占下」读同一份记录（packageOf）
    loadedFrom(name) {
      const registered = app.plugins.getPlugin(name)?.definition;
      return registered ? packageOf.get(registered) : undefined;
    },
  };
}
