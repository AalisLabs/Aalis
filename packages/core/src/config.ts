import type { FSWatcher } from 'node:fs';
import { existsSync, watch as fsWatch, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
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
  // 第三方业务字段兜底：plugin 可通过 declaration merging 提供具体类型
  [key: string]: unknown;
}

const DEFAULT_CONFIG: AalisConfig = {
  name: 'Aalis',
  logLevel: 'info',
  plugins: {},
  disabledPlugins: [],
};

/** core 自身管理的顶层字段（buildSaveObject 时按固定顺序输出；其余字段透传） */
const CORE_TOP_LEVEL_KEYS = new Set<string>(['name', 'logLevel', 'plugins', 'disabledPlugins']);

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

/**
 * 配置管理器
 * - 从 YAML 文件加载配置
 * - 支持环境变量插值 ${VAR_NAME}
 * - 提供默认值
 * - 支持保存配置回磁盘
 * - 支持运行时重新加载
 */
export class ConfigManager {
  private config!: AalisConfig;
  private configDir: string;
  private configPath: string;
  /** 原始 YAML 文本（保存时基于此还原环境变量占位符） */
  private rawYaml: string | null = null;
  /** 文件监听器 */
  private watcher: FSWatcher | null = null;
  /** save() 写入的最后内容，用于 watch 去重 */
  private lastWrittenYaml: string | null = null;
  /** debounce 定时器 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 外部变更回调 */
  private onChangeCallback: (() => void) | null = null;

  constructor(configPath?: string) {
    this.configPath = configPath ? resolve(configPath) : resolve(process.cwd(), 'aalis.config.yaml');

    this.configDir = dirname(this.configPath);
    this.loadFromDisk();
  }

  /**
   * 从磁盘读取配置
   */
  private loadFromDisk(): void {
    if (existsSync(this.configPath)) {
      this.rawYaml = readFileSync(this.configPath, 'utf-8');
      const interpolated = this.interpolateEnvVars(this.rawYaml);
      const parsed = parseYaml(interpolated) ?? {};
      this.config = this.mergeDefaults(parsed);
    } else {
      this.rawYaml = null;
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  get<K extends keyof AalisConfig>(key: K): AalisConfig[K] {
    return this.config[key];
  }

  getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(pluginName: string): T {
    return (this.config.plugins[pluginName] ?? {}) as T;
  }

  getConfigDir(): string {
    return this.configDir;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getAll(): Readonly<AalisConfig> {
    return this.config;
  }

  /**
   * 设置配置值（运行时）
   */
  set<K extends keyof AalisConfig>(key: K, value: AalisConfig[K]): void {
    this.config[key] = value;
  }

  /**
   * 更新插件配置（运行时）
   */
  setPluginConfig(pluginName: string, config: Record<string, unknown>): void {
    this.config.plugins[pluginName] = config;
  }

  /**
   * 移除插件配置（用于删除多实例条目）
   */
  removePluginConfig(pluginName: string): void {
    delete this.config.plugins[pluginName];
  }

  /**
   * 检查插件是否被禁用
   */
  isPluginDisabled(pluginName: string): boolean {
    return (this.config.disabledPlugins ?? []).includes(pluginName);
  }

  /**
   * 设置插件启用/禁用状态
   */
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

  /**
   * 保存当前配置到磁盘（YAML 格式）
   * 注意：环境变量引用会被保护，不会展开为实际值
   */
  save(): void {
    // 构建要保存的配置对象，保护环境变量
    const toSave = this.buildSaveObject();
    const yaml = stringifyYaml(toSave, { lineWidth: 0 });
    this.lastWrittenYaml = yaml;
    writeFileSync(this.configPath, yaml, 'utf-8');
  }

  /**
   * 重新从磁盘加载配置
   */
  reload(): AalisConfig {
    this.loadFromDisk();
    return this.config;
  }

  /**
   * 监听配置文件变更，外部修改时自动重新加载并触发回调
   */
  watch(onChange: () => void): void {
    this.onChangeCallback = onChange;
    if (this.watcher) return;
    if (!existsSync(this.configPath)) return;
    try {
      this.watcher = fsWatch(this.configPath, () => {
        // debounce: 编辑器可能触发多次 change 事件
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          try {
            // 读取当前文件内容，与上次自己写入的比较，相同则跳过
            const current = readFileSync(this.configPath, 'utf-8');
            if (this.lastWrittenYaml !== null && current === this.lastWrittenYaml) return;
            this.lastWrittenYaml = null;
            this.loadFromDisk();
            this.onChangeCallback?.();
          } catch {
            /* 文件可能被部分写入，忽略 */
          }
        }, 300);
      });
    } catch {
      /* 平台不支持 watch */
    }
  }

  /**
   * 停止监听配置文件
   */
  unwatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.onChangeCallback = null;
  }

  /**
   * 构建保存对象：把当前 config 转换为 YAML 安全格式，
   * 恢复环境变量占位符。
   *
   * 顺序约定：先按固定顺序输出 core 已知字段（name/logLevel/plugins/...），
   * 再透传其余顶层字段（来自插件的业务字段，core 不知晓其语义）。
   *
   * 业务字段中如有「运行时不应持久化」的子字段（如 dangerousPolicy.enabledAt），
   * 由对应插件自行避免写入 config，core 不做特例处理。
   */
  private buildSaveObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      name: this.config.name,
      logLevel: this.config.logLevel,
    };

    // 恢复插件配置中的环境变量占位符
    if (this.rawYaml) {
      const rawParsed = parseYaml(this.rawYaml) as Record<string, unknown> | null;
      const rawPlugins = (rawParsed?.plugins ?? {}) as Record<string, Record<string, unknown>>;
      const plugins: Record<string, Record<string, unknown>> = {};

      for (const [name, conf] of Object.entries(this.config.plugins)) {
        plugins[name] = this.restoreEnvVars(conf, rawPlugins[name] ?? {});
      }
      obj.plugins = plugins;
    } else {
      obj.plugins = this.config.plugins;
    }

    obj.disabledPlugins = this.config.disabledPlugins ?? [];

    // 透传其余顶层字段（插件业务字段；core 不解释也不变换）
    for (const [key, value] of Object.entries(this.config)) {
      if (CORE_TOP_LEVEL_KEYS.has(key)) continue;
      if (value === undefined) continue;
      // 空对象 / 空数组的字段不输出，与原有清理逻辑保持一致
      if (Array.isArray(value)) {
        if (value.length > 0) obj[key] = value;
      } else if (value && typeof value === 'object') {
        if (Object.keys(value as Record<string, unknown>).length > 0) obj[key] = value;
      } else {
        obj[key] = value;
      }
    }

    return obj;
  }

  /**
   * 恢复环境变量占位符：对比原始值与当前值，
   * 如果当前值与环境变量展开后的值一致，保留原始占位符
   */
  private restoreEnvVars(current: Record<string, unknown>, raw: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      const rawVal = raw[key];
      if (typeof rawVal === 'string' && /\$\{[^}]+}/.test(rawVal)) {
        // 原始值含环境变量占位符 — 保留占位符
        const expanded = this.interpolateEnvVars(rawVal);
        if (expanded === value) {
          result[key] = rawVal;
          continue;
        }
      }
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        rawVal &&
        typeof rawVal === 'object' &&
        !Array.isArray(rawVal)
      ) {
        result[key] = this.restoreEnvVars(value as Record<string, unknown>, rawVal as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * 替换 ${ENV_VAR} 为环境变量值
   */
  private interpolateEnvVars(text: string): string {
    return text.replace(/\$\{([^}]+)}/g, (_, varName: string) => {
      return process.env[varName.trim()] ?? '';
    });
  }

  /**
   * 合并配置：core 已知字段填默认值，其余顶层字段透传（插件业务字段）。
   *
   * 透传时保留原始类型（对象/数组/标量），不做任何 schema 校验——
   * 业务字段的合法性由消费它的 plugin 自己负责。
   */
  private mergeDefaults(parsed: Record<string, unknown>): AalisConfig {
    const merged: AalisConfig = {
      name: (parsed.name as string) ?? DEFAULT_CONFIG.name,
      logLevel: (parsed.logLevel as string) ?? DEFAULT_CONFIG.logLevel,
      plugins: (parsed.plugins as Record<string, Record<string, unknown>>) ?? {},
      disabledPlugins: (parsed.disabledPlugins as string[]) ?? [],
    };
    // 透传其余顶层字段
    for (const [key, value] of Object.entries(parsed)) {
      if (CORE_TOP_LEVEL_KEYS.has(key)) continue;
      merged[key] = value;
    }
    return merged;
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
 *   - 不接触磁盘：`save()` 抛错，`reload()` / `watch()` 为 no-op
 *
 * 用法：通过 `ctx.createScope()` 自动创建，沙盒插件可以 `scope.config.set(...)`
 * 给自己一份临时配置而不污染全局，且 dispose 后随作用域一起消失。
 */
export class ScopedConfigManager extends ConfigManager {
  private overlay: Partial<AalisConfig> = {};
  private parentConfig: ConfigManager;

  constructor(parent: ConfigManager) {
    // 不传 path，父类 loadFromDisk 在文件不存在时会 fallback 到 DEFAULT_CONFIG，
    // 该内存配置对 scope 不重要——我们通过 override 所有读写来代理到 parent + overlay。
    // 实际使用一个不存在的虚拟路径避免任何意外的 watch/save 副作用。
    super(`/__scoped_config_${Date.now()}_${Math.random().toString(36).slice(2)}.yaml`);
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
    // overlay 中的 disabledPlugins 完全覆盖父级（语义清晰）
    if (this.overlay.disabledPlugins !== undefined) {
      return this.overlay.disabledPlugins.includes(pluginName);
    }
    return this.parentConfig.isPluginDisabled(pluginName);
  }

  override getAll(): Readonly<AalisConfig> {
    // 浅合并父级与 overlay 的完整快照（plugins 需要逐项合并）
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
  override getConfigPath(): string {
    return this.parentConfig.getConfigPath();
  }

  /** 沙盒不接触磁盘 —— save() 直接抛错暴露误用 */
  override save(): void {
    throw new Error('ScopedConfigManager.save() 不可用：scope 配置仅在内存中存在。如需持久化请改用根 ConfigManager。');
  }

  /** 不重新加载磁盘配置；返回当前合并视图 */
  override reload(): AalisConfig {
    return this.getAll() as AalisConfig;
  }

  /** scope 不监听磁盘文件 */
  override watch(): void {
    /* no-op */
  }
  override unwatch(): void {
    /* no-op */
  }
}
