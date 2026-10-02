// ============================================================
// config-sync —— 插件配置同步政策 + 配置热重载编排（宿主政策层）
//
//   - syncPluginDefaults：schema 派生默认值回填 + 按 configSchema 裁剪未知字段 + 密钥字段上的明文移进密钥存储
//   - handleConfigChanged / installConfigHotReload：配置外部变更的 diff + bounce 编排（后缀实例随文件增删登记或卸载）
//
// 这些是**政策**（要不要裁剪、怎么合并、何时 bounce）。配置文档在 config-store，core 只持有
// 运行态与 updateConfig 机制。不接本模块的嵌入式宿主将没有自动配置同步与热重载——需要时用
// 公开 API 自行编排。
// ============================================================

import { isDeepStrictEqual } from 'node:util';
import { type AalisConfig, isConfigSaveRefused } from '@aalis/api-host-config';
import { type App, events, type PluginDefinition, parseInstanceId } from '@aalis/core';
import { deepMergeDefaults, defaultsFrom, removeExtraFields, validateConfig } from '@aalis/schema-config';
import type { ConfigStore } from './config-store.js';
import { moduleDefinitionOf, type PluginDiscovery, type PluginLoader } from './plugin-discovery.js';
import { describeDangling } from './secrets.js';

export interface ConfigSyncOptions {
  /**
   * 是否按 configSchema 裁剪未知字段（默认 `true`）。
   * 设为 `false` 时保留 schema 外的字段——适合允许手写实验性配置、
   * 或 schema 滞后于实现的场景。
   */
  trimUnknownFields?: boolean;
}

/**
 * 将各插件 schema 派生默认值中缺失的字段合并到配置；同时按 configSchema
 * 移除多余字段。返回发生变更的插件 instanceId 列表。
 *
 * 覆盖已登记的实例，以及文档里新出现、尚未登记的 `name:suffix` 实例（模块已登记且 reusable 时，定义取法同热重载登记）：
 * 后者随后由热重载按文档登记，先在这里规范化，首次 apply 拿到的就是带默认值的这一份。
 *
 * `previous` 是热重载前的文档：密钥字段上的明文写进它在同一位置引用的键，与 WebUI 替换同一规则。
 * 不给（启动时）就取新键。
 *
 * 副作用：对每个变化条目 setPluginConfig；若有变化最终落盘，移进密钥存储的字段写成之后才记日志。
 * 插件的 configSchema 经 `getPlugin(instanceId).definition` 读取
 * （core 的状态摘要不携带配置详情）。
 */
export function syncPluginDefaults(
  app: App,
  store: ConfigStore,
  opts?: ConfigSyncOptions,
  previous?: Readonly<AalisConfig>,
): string[] {
  const changed: string[] = [];
  const moved: string[] = [];
  const baseOf = (id: string) => (previous && Object.hasOwn(previous.plugins, id) ? previous.plugins[id] : undefined);
  for (const status of app.plugins.getStatus()) {
    const entry = app.plugins.getPlugin(status.instanceId);
    if (!entry) continue;
    const id = status.instanceId;
    if (syncPluginConfig(app, store, entry.definition, id, moved, opts, baseOf(id))) changed.push(id);
  }
  for (const id of Object.keys(store.get('plugins'))) {
    const { moduleName, suffix } = parseInstanceId(id);
    if (!suffix || app.plugins.getPlugin(id)) continue;
    const definition = moduleDefinitionOf(app, moduleName);
    if (definition?.reusable && syncPluginConfig(app, store, definition, id, moved, opts, baseOf(id))) changed.push(id);
  }
  if (changed.length > 0) saveSyncedConfig(app, store, moved);
  return changed;
}

/**
 * 宿主加载政策：导入定义后、交给 Core 注册前规范化主实例与已配置的复用实例。
 * 首次加载批次只落盘一次；随后市场 rescan 的 load/reload 也走同一政策。
 * 发现驱动随后按文档取每个实例的配置交给 core，首次 apply 拿到的就是规范化后的这一份。
 */
export function withPluginConfigSync(loader: PluginLoader, app: App, store: ConfigStore, opts?: ConfigSyncOptions) {
  let initialLoad = true;
  let initialChanged = false;
  // 首次加载批次里移进密钥存储的字段：合并的那次保存写成之后再记
  const initialMoved: string[] = [];
  const prepare = async (loaded: Promise<PluginDefinition | null>): Promise<PluginDefinition | null> => {
    const definition = await loaded;
    if (!definition) return null;
    const ids = [definition.name];
    if (definition.reusable) {
      for (const id of Object.keys(store.get('plugins'))) {
        const { moduleName, suffix } = parseInstanceId(id);
        if (suffix && moduleName === definition.name) ids.push(id);
      }
    }
    let changed = false;
    const moved = initialLoad ? initialMoved : [];
    for (const id of ids) {
      if (!syncPluginConfig(app, store, definition, id, moved, opts)) continue;
      app.logger.debug(`同步插件配置: ${id}`);
      changed = true;
    }
    if (initialLoad) initialChanged ||= changed;
    else if (changed) saveSyncedConfig(app, store, moved);
    return definition;
  };
  return {
    loader: {
      discover: () => loader.discover(),
      load: descriptor => prepare(loader.load(descriptor)),
      ...(loader.reload ? { reload: descriptor => prepare(loader.reload!(descriptor)) } : {}),
    } satisfies PluginLoader,
    finishInitialLoad() {
      initialLoad = false;
      if (initialChanged) saveSyncedConfig(app, store, initialMoved.splice(0));
      initialChanged = false;
    },
  };
}

/**
 * 配置外部变更时的处理：先卸载文件里已没有配置段的 `name:suffix` 实例，再按启动路径同一政策同步，
 * 重新计算各插件配置并热重载差异（updateConfig → bounce），最后经发现驱动登记文件里新出现的后缀实例
 * （判据同冷启动与热扫描）。`previous` 是变更前的文档，交给同步作拆密钥的基线（见 {@link syncPluginDefaults}）。
 */
export async function handleConfigChanged(
  app: App,
  store: ConfigStore,
  discovery: Pick<PluginDiscovery, 'registerConfiguredInstances'>,
  opts?: ConfigSyncOptions,
  previous?: Readonly<AalisConfig>,
): Promise<void> {
  app.logger.info('检测到配置变更，正在热重载...');
  try {
    // 后缀实例由配置段定义，冷启动只登记文件里有的；重载同样以文件为准，没有配置段的就卸载，新出现的在最后登记。
    // 留着不管的话，下面的同步会把它当成缺配置的实例：运行态配置被换成默认值（无默认值时是 {}），
    // 默认值还会作为一个新配置段写回文件。
    const plugins = store.get('plugins');
    for (const status of app.plugins.getStatus()) {
      if (!parseInstanceId(status.instanceId).suffix || Object.hasOwn(plugins, status.instanceId)) continue;
      app.logger.info(`实例 ${status.instanceId} 已不在配置文件中，正在卸载...`);
      await app.plugins.unload(status.instanceId);
    }

    // 与启动路径同一政策先同步一遍（补 schema 派生默认值缺失字段 + 裁剪 schema 外字段）
    // ——否则热重载读入的原始快照会绕过政策，内存态与启动态在字段清理上不一致。
    const synced = syncPluginDefaults(app, store, opts, previous);
    for (const id of synced) app.logger.debug(`热重载配置同步: ${id}`);

    // 启用中的插件由 updateConfig 收尾的重算发 plugins:changed；禁用插件只换配置、状态不变，这里都不必再补发。
    // 密钥文件的变更也走这里，只有解析结果变了的实例才重载
    for (const status of app.plugins.getStatus()) {
      const next = configToReload(app, store, status.instanceId, '配置已变更');
      if (next) await app.plugins.updateConfig(status.instanceId, next);
    }
    // 按上面已规范化的文档登记，首次 apply 即带默认值
    await discovery.registerConfiguredInstances();
    app.logger.info('配置热重载完成');
  } catch (e) {
    app.logger.error('配置热重载失败:', e);
  }
}

/**
 * 接管配置外部变更监听（provider 不支持 watch 时为 no-op），在 app:stopping（在飞动作排干后）停止监听。
 * startAalis 默认调用；嵌入式宿主可自行选择是否接。
 */
export function installConfigHotReload(
  app: App,
  store: ConfigStore,
  discovery: Pick<PluginDiscovery, 'registerConfiguredInstances'>,
  opts?: ConfigSyncOptions,
): void {
  store.watch(previous => void handleConfigChanged(app, store, discovery, opts, previous));
  app.bind({ events }).events.on('app:stopping', () => store.unwatch());
}

/**
 * 按文档重新解析一个已登记实例的配置，悬空引用记 error。与运行态相同返回 undefined；不同则按状态记一行（`change` 是起因，
 * 如「配置已变更」）并返回新配置，由调用方交给 updateConfig（即 bounce；禁用态只换配置、保持禁用）。
 * 热重载与改了共用密钥之后的重载共用；不在这里 await，没有改动时调用方一路同步走完
 */
export function configToReload(
  app: App,
  store: ConfigStore,
  instanceId: string,
  change: string,
): Record<string, unknown> | undefined {
  const entry = app.plugins.getPlugin(instanceId);
  if (!entry) return undefined;
  // 拿解析后的配置与运行态比：文档里是引用、运行态是原值，直接比永远不等
  const { config, dangling } = store.resolvePluginConfig(instanceId, entry.definition.configSchema);
  if (dangling.length > 0) app.logger.error(describeDangling(instanceId, dangling));
  if (isDeepStrictEqual(config, entry.config)) return undefined;
  app.logger.info(
    entry.state === 'disabled'
      ? `插件 ${instanceId} ${change}；插件已禁用，启用时按新配置激活`
      : `插件 ${instanceId} ${change}，正在重新加载...`,
  );
  return config;
}

// ---- helpers ----

/** 同步一个实例的配置，返回文档有没有变。移进密钥存储的字段说明记进 `moved`，由落盘写成之后记日志 */
function syncPluginConfig(
  app: App,
  store: ConfigStore,
  definition: PluginDefinition,
  id: string,
  moved: string[],
  opts?: ConfigSyncOptions,
  base?: Record<string, unknown>,
): boolean {
  const schema = definition.configSchema;
  const fileConfig = store.getPluginConfig(id);
  let merged = deepMergeDefaults(defaultsFrom(schema), fileConfig);
  if ((opts?.trimUnknownFields ?? true) && schema && Object.keys(schema).length > 0) {
    const removed: string[] = [];
    merged = removeExtraFields(merged, schema, removed);
    if (removed.length > 0) app.logger.warn(`配置同步：${id} 裁掉 schema 外字段 [${removed.join(', ')}]`);
  }
  // 密钥字段上的明文（手写进配置文件的、旧配置里的）移进密钥存储，文档里换成引用。这会改写用户刚编辑过的文件，
  // 日志只写路径与键，不写值
  const { doc, writes, placed } = store.splitPluginSecrets(id, schema, merged, base);
  if (writes.size > 0) {
    store.commitSecrets(writes);
    merged = doc;
    for (const p of placed) moved.push(`${id} 的 ${p.path} 移进 secrets.yaml（键 ${p.key}）`);
  }
  // 脏值在这里只告警、不改文档也不拦登记，读取时怎么处置归插件（parseConfig 回落默认值、忽略或拒绝激活）；
  // 禁用实例的休眠配置不产生必填缺失噪音。
  if (!store.isPluginDisabled(id)) {
    const problems = validateConfig(schema, merged);
    if (problems.length > 0) {
      const detail = problems.map(p => `${p.path}: ${p.message}`).join('；');
      app.logger.warn(`配置校验：${id} 有 ${problems.length} 处问题：${detail}`);
    }
  }
  if (JSON.stringify(merged) === JSON.stringify(fileConfig)) return false;
  store.setPluginConfig(id, merged);
  return true;
}

/** 落盘；`moved` 是这批移进密钥存储的字段，写成之后才记：拒写或写失败时明文还在配置文件里 */
function saveSyncedConfig(app: App, store: ConfigStore, moved: readonly string[]): void {
  store.persist().then(
    () => {
      for (const line of moved) app.logger.info(`配置同步：已把 ${line}`);
    },
    err => {
      // 拒写是保护盘上外部修改的预期结果，与 host-config 的 save 同一口径：一行告警，不带栈
      if (isConfigSaveRefused(err)) app.logger.warn(`配置同步未落盘：${err.message}`);
      else app.logger.warn('配置同步落盘失败:', err);
    },
  );
}
