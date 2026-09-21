// ============================================================
// config-sync —— 插件配置同步政策 + 配置热重载编排（宿主政策层）
//
//   - syncPluginDefaults：schema 派生默认值回填 + 按 configSchema 裁剪未知字段
//   - handleConfigChanged / installConfigHotReload：配置外部变更的 diff + bounce 编排
//
// 这些是**政策**（要不要裁剪、怎么合并、何时 bounce），core 只持有机制
// （配置快照 get/set、watch 透传、updateConfig）。不接本模块的嵌入式
// 宿主将没有自动配置同步与热重载——需要时用公开 API 自行编排。
// ============================================================

import { type App, type PluginDefinition, type PluginLoader, parseInstanceId } from '@aalis/core';
import { defaultsFrom, removeExtraFields, validateConfig } from '@aalis/schema-config';

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
 * 副作用：对每个变化条目 setPluginConfig；若有变化最终调用 save()。
 * 插件的 configSchema 经 `getPlugin(instanceId).definition` 读取
 * （core 的状态摘要不携带配置详情）。
 */
export function syncPluginDefaults(app: App, opts?: ConfigSyncOptions): string[] {
  const changed: string[] = [];
  for (const status of app.plugins.getStatus()) {
    const entry = app.plugins.getPlugin(status.instanceId);
    if (!entry) continue;
    if (syncPluginConfig(app, entry.definition, status.instanceId, opts)) changed.push(status.instanceId);
  }
  if (changed.length > 0) saveSyncedConfig(app);
  return changed;
}

/**
 * 宿主加载政策：导入定义后、交给 Core 注册前规范化主实例与已配置的复用实例。
 * 首次加载批次只落盘一次；随后市场 rescan 的 load/reload 也走同一政策。
 * getApp 延迟取值，因为加载器在 App 构造时注入，而 load 在构造完成后才执行。
 */
export function withPluginConfigSync(loader: PluginLoader, getApp: () => App, opts?: ConfigSyncOptions) {
  let initialLoad = true;
  let initialChanged = false;
  const prepare = async (loaded: Promise<PluginDefinition | null>): Promise<PluginDefinition | null> => {
    const definition = await loaded;
    if (!definition) return null;
    const app = getApp();
    const ids = [definition.name];
    if (definition.reusable) {
      for (const id of Object.keys(app.config.get('plugins'))) {
        const { moduleName, suffix } = parseInstanceId(id);
        if (suffix && moduleName === definition.name) ids.push(id);
      }
    }
    let changed = false;
    for (const id of ids) {
      if (!syncPluginConfig(app, definition, id, opts)) continue;
      app.logger.debug(`同步插件配置: ${id}`);
      changed = true;
    }
    if (initialLoad) initialChanged ||= changed;
    else if (changed) saveSyncedConfig(app);
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
      if (initialChanged) saveSyncedConfig(getApp());
      initialChanged = false;
    },
  };
}

/**
 * 配置外部变更时的处理：先按启动路径同一政策同步，再重新计算各插件配置
 * 并热重载差异（updateConfig → bounce）。
 */
export async function handleConfigChanged(app: App, opts?: ConfigSyncOptions): Promise<void> {
  app.logger.info('检测到配置变更，正在热重载...');
  try {
    // 与启动路径同一政策先同步一遍（补 schema 派生默认值缺失字段 + 裁剪 schema 外字段）
    // ——否则热重载读入的原始快照会绕过政策，内存态与启动态在字段清理上不一致。
    const synced = syncPluginDefaults(app, opts);
    for (const id of synced) app.logger.debug(`热重载配置同步: ${id}`);

    // 每次 updateConfig 收尾的重算都会发 plugins:changed，这里不必再补发
    for (const status of app.plugins.getStatus()) {
      const entry = app.plugins.getPlugin(status.instanceId);
      if (!entry) continue;
      const newConfig = app.config.getPluginConfig(status.instanceId);
      if (JSON.stringify(newConfig) !== JSON.stringify(entry.config)) {
        app.logger.info(`插件 ${status.instanceId} 配置已变更，正在重新加载...`);
        await app.plugins.updateConfig(status.instanceId, newConfig);
      }
    }
    app.logger.info('配置热重载完成');
  } catch (e) {
    app.logger.error('配置热重载失败:', e);
  }
}

/**
 * 接管配置外部变更监听（provider 不支持 watch 时为 no-op）。
 * startAalis 默认调用；嵌入式宿主可自行选择是否接。
 */
export function installConfigHotReload(app: App, opts?: ConfigSyncOptions): void {
  app.config.watch(() => void handleConfigChanged(app, opts));
}

// ---- helpers ----

function syncPluginConfig(app: App, definition: PluginDefinition, id: string, opts?: ConfigSyncOptions): boolean {
  const schema = definition.configSchema;
  const fileConfig = app.config.getPluginConfig(id);
  let merged = deepMergeDefaults(defaultsFrom(schema), fileConfig);
  if ((opts?.trimUnknownFields ?? true) && schema && Object.keys(schema).length > 0) {
    const removed: string[] = [];
    merged = removeExtraFields(merged, schema, removed);
    if (removed.length > 0) app.logger.warn(`配置同步：${id} 裁掉 schema 外字段 [${removed.join(', ')}]`);
  }
  // 脏值只告警不拒载；禁用实例的休眠配置不产生必填缺失噪音。
  if (!app.config.isPluginDisabled(id)) {
    const problems = validateConfig(schema, merged);
    if (problems.length > 0) {
      app.logger.warn(
        `配置校验：${id} 有 ${problems.length} 处问题（仅告警，不影响加载）：` +
          problems.map(p => `${p.path}: ${p.message}`).join('；'),
      );
    }
  }
  if (JSON.stringify(merged) === JSON.stringify(fileConfig)) return false;
  app.config.setPluginConfig(id, merged);
  return true;
}

function saveSyncedConfig(app: App): void {
  app.config.save().catch(err => app.logger.warn('配置同步落盘失败:', err));
}

/**
 * 深度合并默认值：只填充缺失的键，不覆盖已有值。
 * 嵌套对象会递归合并；数组与基础类型按"已存在则保留"处理。
 */
function deepMergeDefaults(
  defaults: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...current };
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in result)) {
      result[key] = defaultValue;
    } else if (
      defaultValue !== null &&
      typeof defaultValue === 'object' &&
      !Array.isArray(defaultValue) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeDefaults(defaultValue as Record<string, unknown>, result[key] as Record<string, unknown>);
    }
  }
  return result;
}
