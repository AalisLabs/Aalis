import type { ConfigProvider } from './providers.js';
import type { ConfigSchema } from './types/index.js';

/**
 * Aalis 应用配置（基础设施字段）
 *
 * 仅声明 core 自身管理的字段。业务字段（owners / agent / dangerousPolicy 等）
 * 由对应 plugin 通过 declaration merging 注入：
 *
 * ```ts
 * declare module '@aalis/core' {
 *   interface AalisConfig {
 *     owners?: Array<{ platform: string; userId: string }>;
 *     defaultAuthority?: number;
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

/** 核心配置的 Schema，与插件 configSchema 走同一套渲染路径 */
export const CORE_CONFIG_SCHEMA: ConfigSchema = {
  name: { type: 'string', label: '应用名称', description: '应用显示名称，用于日志和界面展示', default: 'Aalis' },
  logLevel: {
    type: 'select',
    label: '日志等级',
    description: '日志输出等级',
    default: 'info',
    options: [
      { label: 'debug', value: 'debug' },
      { label: 'info', value: 'info' },
      { label: 'warn', value: 'warn' },
      { label: 'error', value: 'error' },
    ],
  },
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

  /**
   * 将插件 defaultConfig 中缺失的字段合并到配置；同时按 configSchema
   * 移除多余字段。返回发生变更的插件 instanceId 列表（调用方可决定要不要 log）。
   *
   * 副作用：内部对每个发生变化的条目调用 setPluginConfig；若有变化最终调用 save()。
   */
  syncPluginDefaults(
    plugins: ReadonlyArray<{
      instanceId: string;
      defaultConfig?: Record<string, unknown>;
      configSchema?: Record<string, unknown>;
    }>,
  ): string[] {
    const changed: string[] = [];
    for (const plugin of plugins) {
      const defaults = plugin.defaultConfig ?? {};
      const schema = plugin.configSchema;
      const fileConfig = this.getPluginConfig(plugin.instanceId);

      let merged = deepMergeDefaults(defaults, fileConfig);
      if (schema && Object.keys(schema).length > 0) {
        merged = removeExtraFields(merged, schema);
      }

      if (JSON.stringify(merged) !== JSON.stringify(fileConfig)) {
        this.setPluginConfig(plugin.instanceId, merged);
        changed.push(plugin.instanceId);
      }
    }
    if (changed.length > 0) this.save();
    return changed;
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

/**
 * 隔离作用域配置管理器（cleanup-7 新增）
 *
 * 与 {@link ScopedServiceContainer} 对称：fallback-read + override-write。
 *   - `get(key)` 优先返回 overlay 内的值，否则回退到父配置
 *   - `set(key, value)` 仅写入 overlay，不影响父配置
 *   - `getPluginConfig(name)` 返回 `{ ...parent, ...overlay }`（浅合并）
 *   - `setPluginConfig(name, conf)` 完整替换 overlay 中该插件条目
 *   - 不接触任何 provider：`save()` 抛错，`watch()` 为 no-op
 */
export class ScopedConfigManager extends ConfigManager {
  private overlay: Partial<AalisConfig> = {};
  private parentConfig: ConfigManager;

  constructor(parent: ConfigManager) {
    // 父类需要一个 initial 快照——传父配置当前快照（仅用于初始化内部字段；
    // 所有读写都被下面的 override 接管，父类的内部 state 不会被使用）。
    super(parent.getAll() as AalisConfig, { dataDir: parent.getConfigDir() });
    this.parentConfig = parent;
  }

  override get<K extends keyof AalisConfig>(key: K): AalisConfig[K] {
    if (this.overlay && key in this.overlay) {
      return this.overlay[key] as AalisConfig[K];
    }
    return this.parentConfig.get(key);
  }

  override set<K extends keyof AalisConfig>(key: K, value: AalisConfig[K]): void {
    if (!this.overlay) this.overlay = {};
    this.overlay[key] = value;
  }

  override getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(pluginName: string): T {
    const parentConf = this.parentConfig.getPluginConfig<T>(pluginName);
    const ownConf = (this.overlay.plugins?.[pluginName] ?? {}) as Partial<T>;
    // 浅合并：scope 的覆盖只影响顶层 key；嵌套对象由调用方自行 deep-merge
    return { ...parentConf, ...ownConf } as T;
  }

  override setPluginConfig(pluginName: string, config: Record<string, unknown>): void {
    if (!this.overlay.plugins) this.overlay.plugins = {};
    this.overlay.plugins[pluginName] = config;
  }

  override removePluginConfig(pluginName: string): void {
    if (this.overlay.plugins) delete this.overlay.plugins[pluginName];
  }

  override isPluginDisabled(pluginName: string): boolean {
    if (this.overlay.disabledPlugins !== undefined) {
      return this.overlay.disabledPlugins.includes(pluginName);
    }
    return this.parentConfig.isPluginDisabled(pluginName);
  }

  override getAll(): Readonly<AalisConfig> {
    const parentAll = this.parentConfig.getAll();
    const mergedPlugins: Record<string, Record<string, unknown>> = { ...parentAll.plugins };
    if (this.overlay.plugins) {
      for (const [name, conf] of Object.entries(this.overlay.plugins)) {
        mergedPlugins[name] = { ...(parentAll.plugins[name] ?? {}), ...conf };
      }
    }
    return {
      ...parentAll,
      ...this.overlay,
      plugins: mergedPlugins,
    };
  }

  override getConfigDir(): string {
    return this.parentConfig.getConfigDir();
  }

  /** 沙盒不持久化 —— save() 直接抛错暴露误用 */
  override save(): void {
    throw new Error('ScopedConfigManager.save() 不可用：scope 配置仅在内存中存在。');
  }

  override watch(): void {
    /* scope 不订阅 provider */
  }

  override unwatch(): void {
    /* no-op */
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
 * 根据 configSchema 移除多余字段。
 * SchemaGroup（含 fields）对应嵌套对象，递归清理；
 * SchemaArray（type=array）直接保留；
 * SchemaField 对应普通字段。
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
