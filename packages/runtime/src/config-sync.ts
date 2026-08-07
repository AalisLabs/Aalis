// ============================================================
// config-sync —— 插件配置同步政策 + 配置热重载编排（宿主政策层）
//
//   - syncPluginDefaults：schema 派生默认值回填 + 按 configSchema 裁剪未知字段
//   - handleConfigChanged / installConfigHotReload：配置外部变更的 diff + bounce 编排
//
// 这些是**政策**（要不要裁剪、怎么合并、何时 bounce），core 只持有机制
// （配置快照 get/set、watch 透传、updatePluginConfig）。不接本模块的嵌入式
// 宿主将没有自动配置同步与热重载——需要时用公开 API 自行编排。
// ============================================================

import type { App } from '@aalis/core';
import { defaultsFrom } from '@aalis/schema-config';

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
 * 插件的 configSchema 经 `getPlugin(instanceId).module` 读取
 * （core 的状态摘要不携带配置详情）。
 */
export function syncPluginDefaults(app: App, opts?: ConfigSyncOptions): string[] {
  const trim = opts?.trimUnknownFields ?? true;
  const config = app.ctx.config;
  const changed: string[] = [];
  for (const status of app.plugins.getStatus()) {
    const entry = app.plugins.getPlugin(status.instanceId);
    if (!entry) continue;
    const schema = entry.module.configSchema;
    const defaults = defaultsFrom(schema);
    const fileConfig = config.getPluginConfig(status.instanceId);

    let merged = deepMergeDefaults(defaults, fileConfig);
    if (trim && schema && Object.keys(schema).length > 0) {
      merged = removeExtraFields(merged, schema);
    }

    if (JSON.stringify(merged) !== JSON.stringify(fileConfig)) {
      config.setPluginConfig(status.instanceId, merged);
      changed.push(status.instanceId);
    }
  }
  if (changed.length > 0) config.save();
  return changed;
}

/**
 * 配置外部变更时的处理：先按启动路径同一政策同步，再重新计算各插件配置
 * 并热重载差异（updatePluginConfig → bounce）。
 */
export async function handleConfigChanged(app: App, opts?: ConfigSyncOptions): Promise<void> {
  app.logger.info('检测到配置变更，正在热重载...');
  try {
    // 与启动路径同一政策先同步一遍（补 schema 派生默认值缺失字段 + 裁剪 schema 外字段）
    // ——否则热重载读入的原始快照会绕过政策，内存态与启动态在字段清理上不一致。
    const synced = syncPluginDefaults(app, opts);
    for (const id of synced) app.logger.debug(`热重载配置同步: ${id}`);

    let changed = false;
    for (const status of app.plugins.getStatus()) {
      const entry = app.plugins.getPlugin(status.instanceId);
      if (!entry) continue;
      const defaults = defaultsFrom(entry.module.configSchema);
      const fileConfig = app.ctx.config.getPluginConfig(status.instanceId);
      const newConfig = { ...defaults, ...fileConfig };
      if (JSON.stringify(newConfig) !== JSON.stringify(entry.config)) {
        app.logger.info(`插件 ${status.instanceId} 配置已变更，正在重新加载...`);
        await app.plugins.updatePluginConfig(status.instanceId, newConfig);
        changed = true;
      }
    }
    if (changed) {
      await app.ctx.emit('plugins:changed');
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
  app.ctx.config.watch(() => void handleConfigChanged(app, opts));
}

// ---- helpers ----

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

/**
 * 移除多余字段。configSchema 是插件配置的**唯一声明来源**（默认值也从它派生），
 * 所以它的键集就是完整的白名单：不在 schema 里的字段，要么是用户手写的错别字，
 * 要么是已废弃的旧字段，裁掉即归位。无 schema 的插件不裁（见调用方守卫）。
 */
function removeExtraFields(config: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!(key in schema)) continue;
    const schemaDef = schema[key] as Record<string, unknown>;
    if (schemaDef.type === 'array') {
      result[key] = value;
    } else if (
      schemaDef.fields &&
      typeof schemaDef.fields === 'object' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = removeExtraFields(value as Record<string, unknown>, schemaDef.fields as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
