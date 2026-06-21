import type { ConfigProvider } from './providers.js';
import type { ConfigSchema } from './types/index.js';

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
  /**
   * `syncPluginDefaults` 是否按 configSchema 裁剪未知字段（默认 `true`）。
   * 设为 `false` 时保留 schema 外的字段——适合宿主允许手写实验性配置、
   * 或 schema 滞后于实现的场景。这是政策而非机制，故开放给宿主注入。
   */
  trimUnknownFields?: boolean;
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
  /** syncPluginDefaults 的字段裁剪政策（公开只读：scope 继承、宿主可内省） */
  readonly trimUnknownFields: boolean;
  private unwatchFn: (() => void) | null = null;
  private onChangeCallback: (() => void) | null = null;

  constructor(initial: AalisConfig, options?: ConfigManagerOptions) {
    this.config = mergeDefaultsConfig(initial);
    this.provider = options?.provider;
    this.dataDir = options?.dataDir ?? '.';
    this.trimUnknownFields = options?.trimUnknownFields ?? true;
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
      if (this.trimUnknownFields && schema && Object.keys(schema).length > 0) {
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
   *
   * 注意：本方法（与 watch 回调）**不应用 trimUnknownFields 政策**——
   * ConfigManager 不持有插件 schema，裁剪统一发生在 syncPluginDefaults
   * （App.handleConfigFileChanged 热重载时会重新调用它对齐政策）。
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
 *   - 不接触任何 provider：`save()` 为 no-op（与基类"无 provider 内存模式"
 *     同语义——通用插件代码可以照常调 save() 而不被炸），`watch()` 为 no-op
 *
 * ⚠️ 实现约定：本类继承 ConfigManager 仅为名义类型兼容（Context.config 等
 * 处声明为 ConfigManager），**基类内部状态从不读写**——所有公开方法都被
 * 显式覆写为「overlay 优先，回退 parentConfig」的委托。给基类新增公开方法
 * 时必须同步在此覆写，否则继承下来的实现会读写无效的基类快照（写穿透 /
 * 读过期）。test/core/config.test.ts 有反射式防漂移用例兜底。
 */
export class ScopedConfigManager extends ConfigManager {
  private overlay: Partial<AalisConfig> = {};
  private parentConfig: ConfigManager;

  constructor(parent: ConfigManager) {
    // 基类要求一个 initial 快照——传入独立的空白对象占位。绝不可传
    // parent.getAll()：那会把 plugins/disabledPlugins 等容器按引用共享给
    // 基类快照，一旦哪个方法漏覆写，继承实现的写入会穿透进父配置。
    // 政策字段（trimUnknownFields）按值继承父配置——syncPluginDefaults 经
    // 虚分派读 this.trimUnknownFields，scope 必须与父同政策。
    super({ name: '', logLevel: '', plugins: {} }, { trimUnknownFields: parent.trimUnknownFields });
    this.parentConfig = parent;
  }

  // ---- 读路径：overlay 优先，回退父配置 ----

  override get<K extends keyof AalisConfig>(key: K): AalisConfig[K] {
    if (this.overlay && key in this.overlay) {
      return this.overlay[key] as AalisConfig[K];
    }
    return this.parentConfig.get(key);
  }

  override getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(pluginName: string): T {
    const parentConf = this.parentConfig.getPluginConfig<T>(pluginName);
    const ownConf = (this.overlay.plugins?.[pluginName] ?? {}) as Partial<T>;
    // 浅合并：scope 的覆盖只影响顶层 key；嵌套对象由调用方自行 deep-merge
    return { ...parentConf, ...ownConf } as T;
  }

  override isPluginDisabled(pluginName: string): boolean {
    if (this.overlay.disabledPlugins !== undefined) {
      return this.overlay.disabledPlugins.includes(pluginName);
    }
    return this.parentConfig.isPluginDisabled(pluginName);
  }

  override getServicePreferences(): Record<string, string> {
    return (this.overlay.servicePreferences as Record<string, string>) ?? this.parentConfig.getServicePreferences();
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

  // ---- 写路径：只进 overlay，绝不触碰父配置 ----

  override set<K extends keyof AalisConfig>(key: K, value: AalisConfig[K]): void {
    if (!this.overlay) this.overlay = {};
    this.overlay[key] = value;
  }

  override setPluginConfig(pluginName: string, config: Record<string, unknown>): void {
    if (!this.overlay.plugins) this.overlay.plugins = {};
    this.overlay.plugins[pluginName] = config;
  }

  override removePluginConfig(pluginName: string): void {
    if (this.overlay.plugins) delete this.overlay.plugins[pluginName];
  }

  override setPluginEnabled(pluginName: string, enabled: boolean): void {
    // copy-on-write：首写时把父级列表拷一份进 overlay，之后整列表 shadow 父级
    if (this.overlay.disabledPlugins === undefined) {
      this.overlay.disabledPlugins = [...((this.parentConfig.get('disabledPlugins') as string[] | undefined) ?? [])];
    }
    const list = this.overlay.disabledPlugins;
    const idx = list.indexOf(pluginName);
    if (enabled && idx >= 0) {
      list.splice(idx, 1);
    } else if (!enabled && idx < 0) {
      list.push(pluginName);
    }
  }

  override setServicePreference(name: string, contextId: string): void {
    if (!this.overlay.servicePreferences) {
      this.overlay.servicePreferences = { ...this.parentConfig.getServicePreferences() };
    }
    (this.overlay.servicePreferences as Record<string, string>)[name] = contextId;
  }

  override removeServicePreference(name: string): void {
    if (!this.overlay.servicePreferences) {
      this.overlay.servicePreferences = { ...this.parentConfig.getServicePreferences() };
    }
    delete (this.overlay.servicePreferences as Record<string, string>)[name];
  }

  override syncPluginDefaults(
    plugins: ReadonlyArray<{
      instanceId: string;
      defaultConfig?: Record<string, unknown>;
      configSchema?: Record<string, unknown>;
    }>,
  ): string[] {
    // 基类算法走 this.getPluginConfig / this.setPluginConfig / this.save() 虚分派，
    // 在本类上即为「合并进 overlay、不落盘」——语义正确，显式声明以防漂移。
    return super.syncPluginDefaults(plugins);
  }

  // ---- provider 相关：scope 不持久化、不订阅 ----

  /**
   * no-op——与基类"无 provider 内存模式 save() 静默忽略"同语义。
   * 通用插件代码在 scope 内运行时调 config.save() 不应被炸；
   * 隔离性由"写只进 overlay"保证，而不是靠 save 抛错。
   */
  override save(): void {
    /* scope 配置仅存活于内存 */
  }

  /** scope 没有外部来源，快照重载没有意义；显式拒绝以暴露误用。 */
  override reloadFrom(): AalisConfig {
    throw new Error('ScopedConfigManager.reloadFrom() 不可用：scope 配置没有外部来源。');
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
