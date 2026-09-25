// ============================================================
// config-store —— 宿主配置文档（内存态 + 危险键闸 + 落盘委托）与 host-config 服务
//
// 运行态（实例配置、禁用态、服务偏好）在 core；本模块持「下次启动用什么」的文档：
//   - 启动：宿主从文档取每个实例的配置与禁用标记交给 app.pluginAll，偏好经根绑定 services.prefer 应用；
//   - 运行：管理动作只改运行态，要跨重启保留的调用方经 host-config 自己写文档并 save()。
// 本模块不碰文件（无 node: import）：持久化与外部变更监听由注入的 ConfigProvider 完成。
// ============================================================

import { type AalisConfig, type HostConfig, hostConfig } from '@aalis/api-host-config';
import { type App, events, provide, services } from '@aalis/core';
import { cloneConfigObject, isUnsafeConfigKey } from '@aalis/schema-config';

/**
 * 提供者因配置源有尚未生效的外部修改而拒写：可预期的拒绝（盘上内容受保护），不是落盘故障。
 * 宿主据此只记一条告警，不当作错误上报。
 */
export class ConfigSaveRefusedError extends Error {
  override name = 'ConfigSaveRefusedError';
}

/**
 * 配置提供者：负责持久化层。文档由宿主在构造前自己加载好传入，provider 不必提供 load()。
 */
export interface ConfigProvider {
  /**
   * 持久化当前完整文档。不提供表示宿主拒绝持久化（内存配置 / 只读部署）。
   * 不排队也不去重：上一次未结束时可能再次被调用，实现须可重入；传入的是活对象，
   * 跨 await 使用须自行复制；写的原子性与外部编辑的合并由实现自负。
   */
  save?(config: AalisConfig): void | Promise<void>;
  /** 订阅外部对配置源的变更；返回 dispose */
  watch?(onChange: (next: AalisConfig) => void): () => void;
}

/**
 * 宿主持有的配置文档。读写方法与插件经 host-config 看到的相同；落盘与外部变更监听只给宿主：
 * `persist()` 是裸落盘，不记日志，失败原样以拒绝传出。插件拿到的 `save()` 由 {@link installHostConfig}
 * 包上日志与「拒绝已处理」，两者名字不同，本对象因此不能被误当成 HostConfig 直接交出去。
 */
export interface ConfigStore extends Omit<HostConfig, 'save'> {
  persist(): Promise<void>;
  /** 订阅外部变更（新快照已过同一道闸替换进文档后回调）；单订阅者，返回退订 */
  watch(onChange: () => void): () => void;
  unwatch(): void;
}

/**
 * 插件 id 不得当 `plugins` / 禁用名单的对象键——那三条会落到原型链。
 * 按 id 取放的入口共用这一抛错，文案给 WebUI 映射 400。
 */
function assertSafePluginId(id: string): void {
  if (isUnsafeConfigKey(id)) throw new Error(`插件 id 不合法: ${id}`);
}

export function createConfigStore(initial: Partial<AalisConfig>, provider?: ConfigProvider): ConfigStore {
  let config = normalize(initial);
  let unwatchFn: (() => void) | null = null;
  let onChangeCallback: (() => void) | null = null;
  const store: ConfigStore = {
    get: key => config[key],
    getAll: () => config,
    set: (key, value) => {
      config[key] = value;
    },
    getPluginConfig<T extends Record<string, unknown>>(instanceId: string): T {
      assertSafePluginId(instanceId);
      return (Object.hasOwn(config.plugins, instanceId) ? config.plugins[instanceId] : {}) as T;
    },
    setPluginConfig(instanceId, next) {
      assertSafePluginId(instanceId);
      // 值也过闸：外来对象（WebUI 请求体、工具参数）里 JSON 解出的 __proto__ 等键不进文档，调用方之后改它也写不穿
      config.plugins[instanceId] = cloneConfigObject(next);
    },
    removePluginConfig(instanceId) {
      assertSafePluginId(instanceId);
      delete config.plugins[instanceId];
    },
    isPluginDisabled(instanceId) {
      assertSafePluginId(instanceId);
      return (config.disabledPlugins ?? []).includes(instanceId);
    },
    setPluginEnabled(instanceId, enabled) {
      assertSafePluginId(instanceId);
      config.disabledPlugins ??= [];
      const idx = config.disabledPlugins.indexOf(instanceId);
      if (enabled && idx >= 0) config.disabledPlugins.splice(idx, 1);
      else if (!enabled && idx < 0) config.disabledPlugins.push(instanceId);
    },
    getServicePreferences: () => config.servicePreferences ?? {},
    setServicePreference(name, contextId) {
      if (isUnsafeConfigKey(name)) return;
      config.servicePreferences ??= {};
      config.servicePreferences[name] = contextId;
    },
    removeServicePreference(name) {
      if (!config.servicePreferences || isUnsafeConfigKey(name)) return;
      delete config.servicePreferences[name];
    },
    // async：同步 provider 的抛错也以拒绝传出，调用方统一经 Promise 接住
    persist: async () => {
      await provider?.save?.(config);
    },
    watch(onChange) {
      if (onChangeCallback) throw new Error('配置变更只支持一个订阅者，先 unwatch 再订阅');
      onChangeCallback = onChange;
      unwatchFn =
        provider?.watch?.(next => {
          config = normalize(next);
          onChangeCallback?.();
        }) ?? null;
      return () => store.unwatch();
    },
    unwatch() {
      unwatchFn?.();
      unwatchFn = null;
      onChangeCallback = null;
    },
  };
  return store;
}

/**
 * 把文档接到 App：以 host-config 服务独占登记在根激活上，应用文档里的服务偏好，
 * 并在服务上线时记录它有无用户偏好。须在注册任何插件之前调用，偏好才先于全部提供者生效。
 */
export function installHostConfig(app: App, store: ConfigStore): void {
  const host = app.bind({ events, provide, services });
  const { persist, watch: _watch, unwatch: _unwatch, ...doc } = store;
  host.provide(
    hostConfig,
    {
      ...doc,
      // 失败在这里记一笔并标记已处理：不 await 的调用方不会因一次落盘失败变成未处理拒绝、被宿主当致命错误退出
      save: () => {
        const done = (async () => {
          await persist();
          app.logger.info('配置已保存');
        })();
        done.catch(err => {
          try {
            // 拒写是保护盘上外部修改的预期结果，调用方已收到拒绝：一行告警即可，不带栈
            if (err instanceof ConfigSaveRefusedError) app.logger.warn(`配置未保存：${err.message}`);
            else app.logger.error('配置保存失败:', err);
          } catch {
            /* 上报器自身失败不再外抛 */
          }
        });
        return done;
      },
    },
    { exclusive: true },
  );
  for (const [name, contextId] of Object.entries(store.getServicePreferences())) host.services.prefer(name, contextId);
  host.events.on('service:registered', name => {
    const pref = store.getServicePreferences()[name];
    if (pref) app.logger.debug(`服务 "${name}" 注册时存在用户偏好: ${pref}`);
  });
}

// ----- helpers -----

function copyOwnSafeStringDict(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of Object.keys(input)) {
    if (isUnsafeConfigKey(key)) continue;
    const val = (input as Record<string, unknown>)[key];
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

function normalize(input: Partial<AalisConfig>): AalisConfig {
  const merged: AalisConfig = {
    name: (input.name as string) ?? 'Aalis',
    logLevel: (input.logLevel as string) ?? 'info',
    // 键与值都过闸：JSON 解出的 plugins.__proto__ / 插件配置里的 __proto__ 都不能当自有键留下
    plugins: cloneConfigObject((input.plugins ?? {}) as Record<string, unknown>) as AalisConfig['plugins'],
    disabledPlugins: (input.disabledPlugins as string[]) ?? [],
  };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'name' || key === 'logLevel' || key === 'plugins' || key === 'disabledPlugins') continue;
    if (isUnsafeConfigKey(key)) continue;
    if (key === 'servicePreferences') {
      merged.servicePreferences = copyOwnSafeStringDict(value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}
