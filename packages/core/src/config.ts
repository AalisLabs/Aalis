import type { ConfigProvider } from './providers.js';

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
 * 也能通过 `ctx.config.get('myField')` 读到 unknown，避免 core 知晓任何业务字段。
 */
export interface AalisConfig {
  name: string;
  logLevel: string;
  plugins: Record<string, Record<string, unknown>>;
  /** 被禁用的插件名列表 */
  disabledPlugins?: string[];
  /**
   * 服务偏好：serviceName → preferred contextId。
   * 详见 ServiceContainer.prefer / Context.preferService。语义：偏好 > 优先级 > 注册顺序。
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

export interface ConfigManagerOptions {
  /** 持久化与外部变更监听由 provider 提供；省略则进入纯内存模式（save() 静默） */
  provider?: ConfigProvider;
  /**
   * 业务数据目录（plugin 用于解析相对路径，如 sqlite db、persona 文件等）。
   * core 自己不读写它；语义由宿主与插件约定。默认 `'.'`。
   */
  dataDir?: string;
}

/**
 * 配置管理器：纯内存的配置中枢。
 *
 * 职责：
 * - 持有当前配置快照（`AalisConfig`）
 * - 提供 get/set/getPluginConfig 等访问器
 * - 处理插件默认配置合并、schema 裁剪、服务偏好
 *
 * **不**做的事：
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
  private readonly dataDir: string;
  private unwatchFn: (() => void) | null = null;
  private onChangeCallback: (() => void) | null = null;

  constructor(initial: AalisConfig, options?: ConfigManagerOptions) {
    this.config = mergeDefaultsConfig(initial);
    this.provider = options?.provider;
    this.dataDir = options?.dataDir ?? '.';
  }

  get<K extends keyof AalisConfig>(key: K): AalisConfig[K] {
    return this.config[key];
  }

  getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(pluginName: string): T {
    return (this.config.plugins[pluginName] ?? {}) as T;
  }

  /**
   * 业务数据目录——plugin 用于解析相对路径。
   * 命名沿用历史接口（`getConfigDir`），语义上是"宿主指定的数据根目录"。
   */
  getConfigDir(): string {
    return this.dataDir;
  }

  getAll(): Readonly<AalisConfig> {
    return this.config;
  }

  set<K extends keyof AalisConfig>(key: K, value: AalisConfig[K]): void {
    this.config[key] = value;
  }

  setPluginConfig(pluginName: string, config: Record<string, unknown>): void {
    this.config.plugins[pluginName] = config;
  }

  removePluginConfig(pluginName: string): void {
    delete this.config.plugins[pluginName];
  }

  isPluginDisabled(pluginName: string): boolean {
    return (this.config.disabledPlugins ?? []).includes(pluginName);
  }

  setPluginEnabled(pluginName: string, enabled: boolean): void {
    if (!this.config.disabledPlugins) {
      this.config.disabledPlugins = [];
    }
    const idx = this.config.disabledPlugins.indexOf(pluginName);
    if (enabled && idx >= 0) {
      this.config.disabledPlugins.splice(idx, 1);
    } else if (!enabled && idx < 0) {
      this.config.disabledPlugins.push(pluginName);
    }
  }

  getServicePreferences(): Record<string, string> {
    return (this.config.servicePreferences ?? {}) as Record<string, string>;
  }

  setServicePreference(name: string, contextId: string): void {
    if (!this.config.servicePreferences) this.config.servicePreferences = {};
    (this.config.servicePreferences as Record<string, string>)[name] = contextId;
  }

  removeServicePreference(name: string): void {
    if (!this.config.servicePreferences) return;
    delete (this.config.servicePreferences as Record<string, string>)[name];
  }

  /**
   * 持久化当前配置。委托给 provider，无 provider 时静默忽略（内存模式）。
   * 同步语义：若 provider 异步保存，调用方不会等待完成——这与原 fs sync 行为一致。
   */
  save(): void {
    if (!this.provider?.save) return;
    const result = this.provider.save(this.config);
    if (result instanceof Promise) {
      result.catch(() => {
        /* provider 自身负责报错；core 不做处理 */
      });
    }
  }

  /**
   * 重新加载配置——把外部传入的快照写回内部状态。
   *
   * 历史上这是"从磁盘 re-read"的入口；现在交由 provider 决定何时
   * 通过 `watch(onChange)` 把新快照推过来；本方法仅供 watch 回调使用。
   *
   * 注意：本方法（与 watch 回调）不应用任何字段政策（默认回填/裁剪）——
   * 政策归宿主（@aalis/runtime 的 config-sync），机制与政策分层。
   */
  reloadFrom(next: AalisConfig): AalisConfig {
    this.config = mergeDefaultsConfig(next);
    return this.config;
  }

  /**
   * 订阅配置外部变更。委托给 provider；无 provider 时为 no-op。
   */
  watch(onChange: () => void): void {
    this.onChangeCallback = onChange;
    if (!this.provider?.watch) return;
    if (this.unwatchFn) return;
    this.unwatchFn = this.provider.watch(next => {
      this.config = mergeDefaultsConfig(next);
      this.onChangeCallback?.();
    });
  }

  unwatch(): void {
    this.unwatchFn?.();
    this.unwatchFn = null;
    this.onChangeCallback = null;
  }
}

// ---- helpers ----

function mergeDefaultsConfig(input: AalisConfig | Partial<AalisConfig>): AalisConfig {
  const merged: AalisConfig = {
    name: (input.name as string) ?? DEFAULT_CONFIG.name,
    logLevel: (input.logLevel as string) ?? DEFAULT_CONFIG.logLevel,
    plugins: (input.plugins as Record<string, Record<string, unknown>>) ?? {},
    disabledPlugins: (input.disabledPlugins as string[]) ?? [],
  };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'name' || key === 'logLevel' || key === 'plugins' || key === 'disabledPlugins') continue;
    merged[key] = value;
  }
  return merged;
}
