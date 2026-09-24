import { assertSafePluginId, cloneConfigObject, isUnsafeConfigKey } from './config-values.js';

/**
 * Aalis 应用配置（基础设施字段）
 *
 * 仅声明 core 自身管理的字段。业务字段（owners / agent / deniedCapabilities 等）
 * 由对应 plugin 通过 declaration merging 注入：
 *
 * ```ts
 * declare module '@aalis/core' {
 *   interface AalisConfig {
 *     owners?: Array<{ platform: string; userId: string }>;
 *     deniedCapabilities?: string[];
 *   }
 * }
 * ```
 *
 * `[key: string]: unknown` 兜底允许第三方插件即便不做 declaration merging
 * 也能通过宿主的 `app.config.get('myField')` 读到 unknown，避免 core 知晓任何业务字段。
 */
export interface AalisConfig {
  name: string;
  logLevel: string;
  plugins: Record<string, Record<string, unknown>>;
  /** 被禁用的插件名列表 */
  disabledPlugins?: string[];
  /**
   * 服务偏好：serviceName → preferred contextId。
   * 插件经 `services.prefer` 设置偏好。语义：偏好 > 优先级 > 注册顺序。
   */
  servicePreferences?: Record<string, string>;
  // 第三方业务字段兜底：plugin 可通过 declaration merging 提供具体类型
  [key: string]: unknown;
}

const DEFAULT_CONFIG: AalisConfig = {
  name: 'Aalis',
  logLevel: 'info',
  plugins: {},
  disabledPlugins: [],
};

/**
 * 配置提供者：负责"持久化层"。core 内部的 `ConfigManager` 持有运行时
 * 解析后的 `AalisConfig` 快照，所有读写都走自己的内存结构；
 * `save()` / `watch()` 才转交给 provider。
 *
 * 因此 provider 不必提供 `load()`——`AalisConfig` 由宿主在构造 `App` 之前
 * 自己加载好传进来即可。这让 core 完全无视"配置从哪里读"的细节。
 */
export interface ConfigProvider {
  /**
   * 持久化当前完整 config 快照。
   *
   * 实现可以做：写文件、PUT 到 HTTP 端点、写 KV 存储等。
   * 不提供时表示宿主拒绝持久化（典型场景：内存配置 / 只读部署）。
   *
   * core 不排队也不去重：上一次未结束时可能再次被调用，实现须可重入；传入的是 core 的活对象，
   * 跨 await 使用须自行复制；写的原子性与外部编辑的合并由实现自负。
   */
  save?(config: AalisConfig): void | Promise<void>;

  /**
   * 订阅外部对配置源的变更（其他进程改了配置文件、远端推送等）。
   *
   * 当 provider 检测到 config 已变化时调用 `onChange(next)`，
   * core 的 ConfigManager 会用新快照重置内部状态并触发热重载。
   *
   * 返回的 dispose 函数会在 `App.stop()` 时被调用。
   */
  watch?(onChange: (next: AalisConfig) => void): () => void;
}

export interface ConfigManagerOptions {
  /** 持久化与外部变更监听由 provider 提供；省略则进入纯内存模式（save() 静默） */
  provider?: ConfigProvider;
}

/**
 * 配置管理器：纯内存的配置中枢。
 *
 * 职责：
 * - 持有当前配置快照（`AalisConfig`）
 * - 提供 get/set/getPluginConfig 等访问器
 * - 持有服务偏好表（serviceName → preferred contextId）
 *
 * **不**做的事：
 * - 不做插件默认配置合并与 schema 裁剪——归宿主的 config-sync 政策
 * - 不读写文件，不解析 yaml/json，不 watch 文件系统
 *   ——这些由 `ConfigProvider`（宿主注入）负责
 *
 * 这样 core 可以在浏览器、嵌入式宿主、单元测试里直接使用：
 * 测试代码可以 `new App({ config: { name: 'X', logLevel: 'error', plugins: {} } })`
 * 而无需创建临时目录写 yaml 文件。
 */
export class ConfigManager {
  private config: AalisConfig;
  private readonly provider?: ConfigProvider;
  private unwatchFn: (() => void) | null = null;
  private onChangeCallback: (() => void) | null = null;

  constructor(initial: AalisConfig, options?: ConfigManagerOptions) {
    this.config = mergeDefaultsConfig(initial);
    this.provider = options?.provider;
  }

  get<K extends keyof AalisConfig>(key: K): AalisConfig[K] {
    return this.config[key];
  }

  getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(instanceId: string): T {
    assertSafePluginId(instanceId);
    const plugins = this.config.plugins;
    if (!Object.hasOwn(plugins, instanceId)) return {} as T;
    return plugins[instanceId] as T;
  }

  getAll(): Readonly<AalisConfig> {
    return this.config;
  }

  set<K extends keyof AalisConfig>(key: K, value: AalisConfig[K]): void {
    this.config[key] = value;
  }

  setPluginConfig(instanceId: string, config: Record<string, unknown>): void {
    assertSafePluginId(instanceId);
    this.config.plugins[instanceId] = config;
  }

  removePluginConfig(instanceId: string): void {
    assertSafePluginId(instanceId);
    if (!Object.hasOwn(this.config.plugins, instanceId)) return;
    delete this.config.plugins[instanceId];
  }

  isPluginDisabled(instanceId: string): boolean {
    assertSafePluginId(instanceId);
    return (this.config.disabledPlugins ?? []).includes(instanceId);
  }

  setPluginEnabled(instanceId: string, enabled: boolean): void {
    assertSafePluginId(instanceId);
    if (!this.config.disabledPlugins) {
      this.config.disabledPlugins = [];
    }
    const idx = this.config.disabledPlugins.indexOf(instanceId);
    if (enabled && idx >= 0) {
      this.config.disabledPlugins.splice(idx, 1);
    } else if (!enabled && idx < 0) {
      this.config.disabledPlugins.push(instanceId);
    }
  }

  getServicePreferences(): Record<string, string> {
    return this.config.servicePreferences ?? {};
  }

  setServicePreference(name: string, contextId: string): void {
    if (isUnsafeConfigKey(name)) return;
    if (!this.config.servicePreferences) this.config.servicePreferences = {};
    this.config.servicePreferences[name] = contextId;
  }

  removeServicePreference(name: string): void {
    if (!this.config.servicePreferences || isUnsafeConfigKey(name)) return;
    if (!Object.hasOwn(this.config.servicePreferences, name)) return;
    delete this.config.servicePreferences[name];
  }

  /**
   * 持久化当前配置。委托给 provider，无 provider 时立即完成（内存模式）。
   * 返回 provider 的完成：同步 provider 立即落定，异步 provider 等其 settle；失败以拒绝传出。
   *
   * 机制口。公开入口是 `app.saveConfig()`（AppService 契约），全部插件
   * 消费者都应走它；本方法仅供 App 门面与宿主使用，避免同一件事两条公开路。
   * @internal
   */
  save(): Promise<void> {
    if (!this.provider?.save) return Promise.resolve();
    // 非 async 函数：同步 provider 的抛错仍同步冒出（与此前一致）；
    // 异步 provider 的拒绝经返回值传出，不再吞掉——「已保存」的假象由此消失。
    return Promise.resolve(this.provider.save(this.config));
  }

  /**
   * 订阅配置外部变更，返回退订闭包（与 core 其余订阅口同形）。委托给 provider；无 provider 时为 no-op。
   * 单订阅者：已有订阅时再调即抛错，而不是静默顶替。
   */
  watch(onChange: () => void): () => void {
    if (this.onChangeCallback) throw new Error('ConfigManager: 配置变更只支持一个订阅者，先 unwatch 再订阅');
    this.onChangeCallback = onChange;
    this.unwatchFn =
      this.provider?.watch?.(next => {
        this.config = mergeDefaultsConfig(next);
        this.onChangeCallback?.();
      }) ?? null;
    return () => this.unwatch();
  }

  /** 整体清扫（属主 App 在 stop() 时调用；订阅者是宿主，App 不持退订句柄）。 */
  unwatch(): void {
    this.unwatchFn?.();
    this.unwatchFn = null;
    this.onChangeCallback = null;
  }
}

// ----- helpers -----

function copyOwnSafeStringDict(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of Object.keys(input)) {
    if (isUnsafeConfigKey(key) || !Object.hasOwn(input, key)) continue;
    const val = (input as Record<string, unknown>)[key];
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

function mergeDefaultsConfig(input: AalisConfig | Partial<AalisConfig>): AalisConfig {
  const merged: AalisConfig = {
    name: (input.name as string) ?? DEFAULT_CONFIG.name,
    logLevel: (input.logLevel as string) ?? DEFAULT_CONFIG.logLevel,
    // 键与值都过闸：JSON 解出的 plugins.__proto__ / 插件配置里的 __proto__ 都不能当自有键留下
    plugins: cloneConfigObject((input.plugins ?? {}) as Record<string, unknown>) as Record<
      string,
      Record<string, unknown>
    >,
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
