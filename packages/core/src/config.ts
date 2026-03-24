import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
export interface AalisConfig {
  name: string;
  persona: string;
  logLevel: string;
  agent?: {
    maxToolIterations?: number;
    temperature?: number;
    maxTokens?: number;
  };
  plugins: Record<string, Record<string, unknown>>;
  /** 被禁用的插件名列表 */
  disabledPlugins?: string[];
  /** 服务偏好：服务名 → 偏好的提供者 contextId */
  servicePreferences?: Record<string, string>;
}

const DEFAULT_CONFIG: AalisConfig = {
  name: 'Aalis',
  persona: 'default',
  logLevel: 'info',
  plugins: {},
  disabledPlugins: [],
  servicePreferences: {},
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

  constructor(configPath?: string) {
    this.configPath = configPath
      ? resolve(configPath)
      : resolve(process.cwd(), 'aalis.config.yaml');

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

  getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(
    pluginName: string,
  ): T {
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
   * 设置服务偏好提供者
   */
  setServicePreference(serviceName: string, contextId: string): void {
    if (!this.config.servicePreferences) {
      this.config.servicePreferences = {};
    }
    this.config.servicePreferences[serviceName] = contextId;
  }

  /**
   * 获取服务偏好
   */
  getServicePreferences(): Record<string, string> {
    return this.config.servicePreferences ?? {};
  }

  /**
   * 保存当前配置到磁盘（YAML 格式）
   * 注意：环境变量引用会被保护，不会展开为实际值
   */
  save(): void {
    // 构建要保存的配置对象，保护环境变量
    const toSave = this.buildSaveObject();
    const yaml = stringifyYaml(toSave, { lineWidth: 0 });
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
   * 构建保存对象：把当前 config 转换为 YAML 安全格式，
   * 恢复环境变量占位符
   */
  private buildSaveObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      name: this.config.name,
      persona: this.config.persona,
      logLevel: this.config.logLevel,
    };

    if (this.config.agent && Object.keys(this.config.agent).length > 0) {
      obj.agent = this.config.agent;
    }

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

    if (this.config.disabledPlugins && this.config.disabledPlugins.length > 0) {
      obj.disabledPlugins = this.config.disabledPlugins;
    }

    if (this.config.servicePreferences && Object.keys(this.config.servicePreferences).length > 0) {
      obj.servicePreferences = this.config.servicePreferences;
    }

    return obj;
  }

  /**
   * 恢复环境变量占位符：对比原始值与当前值，
   * 如果当前值与环境变量展开后的值一致，保留原始占位符
   */
  private restoreEnvVars(
    current: Record<string, unknown>,
    raw: Record<string, unknown>,
  ): Record<string, unknown> {
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
      if (value && typeof value === 'object' && !Array.isArray(value) &&
          rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
        result[key] = this.restoreEnvVars(
          value as Record<string, unknown>,
          rawVal as Record<string, unknown>,
        );
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

  private mergeDefaults(parsed: Record<string, unknown>): AalisConfig {
    return {
      name: (parsed['name'] as string) ?? DEFAULT_CONFIG.name,
      persona: (parsed['persona'] as string) ?? DEFAULT_CONFIG.persona,
      logLevel: (parsed['logLevel'] as string) ?? DEFAULT_CONFIG.logLevel,
      agent: {
        ...DEFAULT_CONFIG.agent,
        ...((parsed['agent'] as Record<string, unknown>) ?? {}),
      },
      plugins: (parsed['plugins'] as Record<string, Record<string, unknown>>) ?? {},
      disabledPlugins: (parsed['disabledPlugins'] as string[]) ?? [],
      servicePreferences: (parsed['servicePreferences'] as Record<string, string>) ?? {},
    };
  }
}
