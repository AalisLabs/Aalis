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
import { events } from '@aalis/api-events';
import { type AalisConfig, isConfigSaveRefused } from '@aalis/api-host-config';
import { type App, lifecycle, type PluginDefinition, parseInstanceId, services } from '@aalis/core';
import { deepMergeDefaults, defaultsFrom, removeExtraFields, validateConfig } from '@aalis/schema-config';
import { applyServicePreferences, type ConfigStore } from './config-store.js';
import { moduleDefinitionOf, type PluginDiscovery, type PluginDiscoveryOptions } from './plugin-discovery.js';
import { describeDangling } from './secrets.js';

const bindRoot = (app: App) => app.bind({ events, services });
const roots = new WeakMap<App, ReturnType<typeof bindRoot>>();
/** 宿主根上的绑定，每个 App 只做一次：events 的绑定带归属表，每绑一次都在根激活上留一份跟随与订阅，到停机才撤 */
function rootOf(app: App): ReturnType<typeof bindRoot> {
  const held = roots.get(app);
  if (held) return held;
  const host = bindRoot(app);
  roots.set(app, host);
  return host;
}

/**
 * 后缀实例由配置段定义：在册而文档里没有它的段，就是等着卸载的（文件里删了它，卸载还没轮到、或被停机拒绝），不是缺配置的。
 * 只有卸载碰它：同步会把默认值当成它的新配置段写回文件，重载会让它带着默认值重新激活。各轮热重载不排队，
 * 判断一律按当前文档现取，一轮开头的名单在它等待期间可能已经过时
 */
function awaitsUnload(store: ConfigStore, instanceId: string): boolean {
  return parseInstanceId(instanceId).suffix !== undefined && !Object.hasOwn(store.get('plugins'), instanceId);
}

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
 * 覆盖已登记的实例（等着卸载的后缀实例除外，见 {@link awaitsUnload}），以及文档里新出现、尚未登记的 `name:suffix` 实例
 * （模块已登记且 reusable 时，定义取法同热重载登记）：
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
    if (!entry || awaitsUnload(store, status.instanceId)) continue;
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
 * 宿主加载政策，交给 createPluginDiscovery 的 options：发现驱动每批定下要登记的定义后、交给 Core 注册前，规范化各定义的主实例
 * 与已配置的复用实例，这一批有改动就落盘一次（冷启动整批一次，之后每次热扫描一次）。
 * 不在导入时做：导入了不等于要登记，被跳过、拒载的定义按它的 schema 同步，会裁掉同名配置段的字段。
 * 发现驱动随后按文档取每个实例的配置交给 core，首次 apply 拿到的就是规范化后的这一份。
 * 配置段被改了的实例各发一次 host-config:changed（带 instanceId）。某个定义同步时抛错只记该条、不登记它，其余照常
 */
export function withPluginConfigSync(app: App, store: ConfigStore, opts?: ConfigSyncOptions): PluginDiscoveryOptions {
  const host = rootOf(app);
  return {
    prepare(definitions) {
      const ready: PluginDefinition[] = [];
      let changed = false;
      // 这一批移进密钥存储的字段：落盘写成之后再记
      const moved: string[] = [];
      for (const definition of definitions) {
        try {
          const ids = [definition.name];
          if (definition.reusable) {
            for (const id of Object.keys(store.get('plugins'))) {
              const { moduleName, suffix } = parseInstanceId(id);
              if (suffix && moduleName === definition.name) ids.push(id);
            }
          }
          for (const id of ids) {
            if (!syncPluginConfig(app, store, definition, id, moved, opts)) continue;
            app.logger.debug(`同步插件配置: ${id}`);
            changed = true;
            void host.events.use.emit('host-config:changed', { instanceId: id });
          }
          ready.push(definition);
        } catch (err) {
          app.logger.error(`同步插件 "${definition.name}" 的配置失败，不加载:`, err);
        }
      }
      if (changed) saveSyncedConfig(app, store, moved);
      return ready;
    },
  };
}

/**
 * 配置外部变更时的处理：先核对服务偏好（全局与本插件），卸载文件里已没有配置段的 `name:suffix` 实例，再按启动路径同一政策同步，
 * 重新计算各插件配置并热重载差异（updateConfig → bounce），最后经发现驱动登记文件里新出现的后缀实例
 * （判据同冷启动与热扫描）。`previous` 是变更前的文档：核对偏好的基线（不给时只应用新文档里的），也交给同步作拆密钥的基线
 * （见 {@link syncPluginDefaults}）。
 * 结束时（成功与失败都一样）文档与 `previous` 不同就发 host-config:changed（带 document）：热重载换下整份文档，不经 host-config
 * 的写方法。只换了密钥文件、文档没换时不发；不给 `previous` 时按变了处理。配置文件解析失败的变更到不了这里
 */
export async function handleConfigChanged(
  app: App,
  store: ConfigStore,
  discovery: Pick<PluginDiscovery, 'registerConfiguredInstances'>,
  opts?: ConfigSyncOptions,
  previous?: Readonly<AalisConfig>,
): Promise<void> {
  app.logger.info('检测到配置变更，正在热重载...');
  const host = rootOf(app);
  try {
    applyServicePreferences(host.services.use, store.getAll(), previous);
    // 后缀实例由配置段定义，冷启动只登记文件里有的；重载同样以文件为准，没有配置段的就卸载，新出现的在最后登记。
    // 这里没卸成的，下面的同步与重载都不碰，见 awaitsUnload
    for (const status of app.plugins.getStatus()) {
      if (!awaitsUnload(store, status.instanceId)) continue;
      app.logger.info(`实例 ${status.instanceId} 已不在配置文件中，正在卸载...`);
      await app.plugins.unload(status.instanceId);
    }

    // 与启动路径同一政策先同步一遍（补 schema 派生默认值缺失字段 + 裁剪 schema 外字段）
    // ——否则热重载读入的原始快照会绕过政策，内存态与启动态在字段清理上不一致。
    const synced = syncPluginDefaults(app, store, opts, previous);
    for (const id of synced) app.logger.debug(`热重载配置同步: ${id}`);

    // 启用中的插件由 updateConfig 收尾的重算通知 plugins.watch 的订阅；禁用插件只换配置、状态不变，这里都不必再补发。
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
  } finally {
    if (!isDeepStrictEqual(previous, store.getAll()))
      await host.events.use.emit('host-config:changed', { document: true });
  }
}

/**
 * 接管配置外部变更监听（provider 不支持 watch 时为 no-op）。应用开始停机之后到来的变更不再重载；监听在宿主根收尾时
 * 摘掉（那时插件都已收尾）。startAalis 默认调用；嵌入式宿主可自行选择是否接。
 */
export function installConfigHotReload(
  app: App,
  store: ConfigStore,
  discovery: Pick<PluginDiscovery, 'registerConfiguredInstances'>,
  opts?: ConfigSyncOptions,
): void {
  store.watch(previous => {
    if (!app.stopping) void handleConfigChanged(app, store, discovery, opts, previous);
  });
  app.bind({ lifecycle }).lifecycle.use.onDrain(() => store.unwatch());
}

/**
 * 按文档重新解析一个已登记实例的配置，悬空引用记 error。与运行态相同、或它是等着卸载的后缀实例时返回 undefined；不同则按状态记一行（`change` 是起因，
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
  if (!entry || awaitsUnload(store, instanceId)) return undefined;
  // 拿解析后的配置与运行态比：文档里是引用、运行态是原值，直接比永远不等
  const { config, dangling } = store.resolvePluginConfig(instanceId, entry.definition.configSchema);
  if (dangling.length > 0) app.logger.error(describeDangling(instanceId, dangling).source);
  if (isDeepStrictEqual(config, entry.config)) return undefined;
  app.logger.info(
    entry.state === 'disabled'
      ? `插件 ${instanceId} ${change}；插件已禁用，启用时按新配置激活`
      : `插件 ${instanceId} ${change}，正在重新加载...`,
  );
  return config;
}

// ---- helpers ----

/**
 * 同步一个实例的配置，返回文档有没有变。移进密钥存储的字段说明在这个实例写进文档之后才记进 `moved`（写不进时抛错、不记），
 * 由落盘写成之后记日志
 */
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
  // 拆出了密钥时文档换成了引用、与原段必然不同，一定走到这里
  for (const p of placed) moved.push(`${id} 的 ${p.path} 移进 secrets.yaml（键 ${p.key}）`);
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
