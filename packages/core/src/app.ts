import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigManager } from './config.js';
import { Context } from './context.js';
import { EventBus } from './events.js';
import { HookRegistry } from './hooks.js';
import { Logger, type LogLevel } from './logger.js';
import { PluginManager, type PluginModule, parseInstanceId } from './plugin.js';
import { ServiceContainer } from './service.js';

// ----- 应用配置选项 -----

/**
 * App 构造选项
 *
 * 所有字段均可选：未提供的子系统由 App 自动创建。
 * 传入自定义实例即可实现隔离/沙盒/测试等场景。
 */
export interface AppOptions {
  /** 配置文件路径 */
  configPath?: string;
  /** 注入自定义事件总线（默认新建） */
  events?: EventBus;
  /** 注入自定义服务容器（默认新建） */
  services?: ServiceContainer;
  /** 注入自定义钩子注册表（默认新建） */
  hooks?: HookRegistry;
  /** 注入自定义配置管理器（默认新建） */
  config?: ConfigManager;
  /**
   * 自定义必需服务列表。
   *
   * 例如 `['webui-server', 'cli']` 表示这些服务必须至少有一个提供者在运行。
   * 默认 `[]`——core 不假设任何具体服务存在，由应用入口显式传入。
   */
  requiredServices?: string[];
}

/**
 * 创建 App 实例的工厂函数
 *
 * 推荐用此函数而非直接 `new App()` — 语义更clear，
 * 未来可在不改调用方的前提下加入缓存、校验等逻辑。
 *
 * @example
 * // 默认用法
 * const app = createApp();
 *
 * // 沙盒隔离: 完全独立的子系统
 * const sandbox = createApp({
 *   config: new ConfigManager('sandbox.config.yaml'),
 *   events: new EventBus(),
 *   services: new ServiceContainer(),
 *   hooks: new HookRegistry(),
 *   requiredServices: [], // 沙盒不需要任何预设服务
 * });
 */
export function createApp(options?: AppOptions | string): App {
  return new App(options);
}

/**
 * Aalis 应用主容器
 *
 * 职责:
 * - 初始化所有核心子系统 (事件总线, 服务容器, 钩子注册表, 配置)
 * - 创建根 Context
 * - 管理插件生命周期
 * - 启动 Agent 消息路由
 *
 * 所有子系统均可通过 AppOptions 注入，使得：
 * - 测试时可 mock 任意子系统
 * - 沙盒插件可创建完全隔离的 App 实例
 * - 多实例部署无需修改 core
 */
export class App {
  readonly ctx: Context;
  readonly plugins: PluginManager;
  readonly logger: Logger;
  readonly packagesDir: string;

  /** 事件总线（可被沙盒插件获取以实现事件桥接） */
  readonly events: EventBus;
  /** 服务容器 */
  readonly services: ServiceContainer;
  /** 钩子注册表 */
  readonly hooks: HookRegistry;

  /** 可配置的必需服务列表 */
  readonly requiredServices: readonly string[];

  constructor(options?: AppOptions | string) {
    // 兼容旧签名: new App('path/to/config.yaml')
    const opts: AppOptions = typeof options === 'string' ? { configPath: options } : (options ?? {});

    // 1. 核心基础设施（允许外部注入，未提供则自动创建）
    const config = opts.config ?? new ConfigManager(opts.configPath);
    this.events = opts.events ?? new EventBus();
    this.services = opts.services ?? new ServiceContainer();
    this.hooks = opts.hooks ?? new HookRegistry();
    this.logger = new Logger('aalis', config.get('logLevel') as LogLevel);

    // 2. 根上下文
    this.ctx = new Context({
      id: 'root',
      events: this.events,
      services: this.services,
      hooks: this.hooks,
      logger: this.logger,
      config,
    });

    // 3. 插件管理器
    this.plugins = new PluginManager(this.ctx, this.logger);
    this.requiredServices = opts.requiredServices ?? [];
    this.plugins.requiredServices = this.requiredServices;
    this.packagesDir = resolve(process.cwd(), 'packages');

    // 4. 注册核心服务
    this.ctx.provide('app', this, { capabilities: ['lifecycle', 'config', 'market'] });
    this.ctx.provide('plugins', this.plugins, { capabilities: ['plugin-mgmt'] });

    // 5. 新服务注册时自动应用配置文件中的服务偏好
    this.ctx.on('service:registered', svcName => {
      const pref = config.getServicePreferences()[svcName];
      if (pref) {
        this.ctx.preferService(svcName, pref);
      }
    });

    // 6. 监控核心必需服务，卸载时自动恢复
    this.ctx.on('service:unregistered', async name => {
      if (!this.requiredServices.includes(name)) return;
      if (this.ctx.hasService(name)) return;
      this.logger.warn(`必需服务 "${name}" 被卸载，尝试自动恢复...`);
      const activated = await this.plugins.ensureServiceProvider(name);
      if (activated) {
        this.logger.info(`必需服务 "${name}" 已通过插件 "${activated}" 恢复`);
      } else if (!this.ctx.hasService(name)) {
        this.logger.error(`必需服务 "${name}" 自动恢复失败！`);
      }
    });

    this.logger.info(`Aalis v0.1.0 - ${config.get('name')}`);
  }

  /**
   * 注册插件
   *
   * @param module     插件模块
   * @param config     插件配置（覆盖文件配置）
   * @param instanceId 实例 ID（多实例时为 `name:suffix`，留空则使用 module.name）
   */
  async plugin(module: PluginModule, config?: Record<string, unknown>, instanceId?: string): Promise<void> {
    const id = instanceId ?? module.name;
    // 合并优先级: 插件默认配置 ← 配置文件 ← 代码传入
    const defaults = module.defaultConfig ?? {};
    const fileConfig = this.ctx.config.getPluginConfig(id);
    const mergedConfig = { ...defaults, ...fileConfig, ...config };
    await this.plugins.register(module, mergedConfig, id);
  }

  /**
   * 自动扫描 packages/ 目录，动态加载所有插件
   *
   * 规则:
   * - 跳过 package.json 中标记 `"aalis": { "core": true }` 的包
   * - 其余包全部视为插件，通过 dynamic import() 加载
   * - commands、tools 等业务服务由插件提供；Context 会缓冲相关注册直到服务就绪
   */
  async autoLoadPlugins(packagesDir?: string): Promise<void> {
    const dir = packagesDir ?? this.packagesDir;
    const discovered = await this.discoverPlugins(dir);
    this.logger.info(`发现 ${discovered.length} 个插件`);

    // 按模块名索引已加载的模块（用于多实例查找）
    const loadedModules = new Map<string, PluginModule>();

    // Pass 1: 先 import 所有模块，触发其顶层副作用（如 Context.extend 注入便捷方法）。
    // 这样可以避免按字母序激活时，依赖 Context.extend 注入方法的插件先于
    // 注入者（如 plugin-tools-system / plugin-commands）执行而激活失败。
    const modules: Array<{ pkg: (typeof discovered)[number]; mod: PluginModule }> = [];
    for (const pkg of discovered) {
      try {
        const mod = (await import(pathToFileURL(pkg.entry).href)) as PluginModule;
        if (typeof mod.apply !== 'function' || !mod.name) {
          this.logger.debug(`跳过非插件模块: ${pkg.name}（缺少 name 或 apply）`);
          continue;
        }
        modules.push({ pkg, mod });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`加载插件 "${pkg.name}" 失败: ${message}`);
      }
    }

    // Pass 2: 注册并尝试激活所有已加载模块。此时 Context.prototype 上的扩展方法都已就位。
    for (const { mod } of modules) {
      loadedModules.set(mod.name, mod);
      try {
        await this.plugin(mod);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`注册插件 "${mod.name}" 失败: ${message}`);
      }
    }

    // 扫描配置文件中的多实例条目（name:suffix 格式）
    const pluginConfigs = this.ctx.config.get('plugins') ?? {};
    for (const configKey of Object.keys(pluginConfigs)) {
      const { moduleName, suffix } = parseInstanceId(configKey);
      if (!suffix) continue; // 非多实例条目，已在上面加载
      const mod = loadedModules.get(moduleName);
      if (!mod) {
        this.logger.warn(`多实例配置 "${configKey}" 对应的模块 "${moduleName}" 未找到，跳过`);
        continue;
      }
      if (!mod.reusable) {
        this.logger.warn(`插件 "${moduleName}" 未声明 reusable，跳过多实例 "${configKey}"`);
        continue;
      }
      try {
        await this.plugin(mod, undefined, configKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`加载多实例插件 "${configKey}" 失败: ${message}`);
      }
    }

    // 将插件默认配置中缺失的字段同步到配置文件（内部已按需保存）
    this.syncPluginDefaults();
  }

  /**
   * 将各插件 defaultConfig 中缺失的字段同步到配置文件，
   * 同时移除 configSchema 中未定义的多余字段
   */
  private syncPluginDefaults(): void {
    const plugins = this.plugins.getStatus();
    let changed = false;

    for (const plugin of plugins) {
      const defaults = plugin.defaultConfig ?? {};
      const schema = plugin.configSchema;
      const fileConfig = this.ctx.config.getPluginConfig(plugin.instanceId);

      // 步骤 1: 补充缺失的默认值
      let merged = this.deepMergeDefaults(defaults, fileConfig);

      // 步骤 2: 移除 schema 中未定义的多余字段
      if (schema && Object.keys(schema).length > 0) {
        merged = this.removeExtraFields(merged, schema);
      }

      if (JSON.stringify(merged) !== JSON.stringify(fileConfig)) {
        this.ctx.config.setPluginConfig(plugin.instanceId, merged);
        changed = true;
        this.logger.debug(`同步插件配置: ${plugin.name}`);
      }
    }

    if (changed) {
      this.ctx.config.save();
      this.logger.info('已将插件配置同步到配置文件');
    }
  }

  /**
   * 根据 configSchema 移除多余字段
   * SchemaGroup (含 fields) 对应嵌套对象，SchemaArray (type=array) 直接保留，SchemaField 对应普通字段
   */
  private removeExtraFields(config: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (!(key in schema)) continue; // 多余字段，丢弃
      const schemaDef = schema[key] as Record<string, unknown>;
      // SchemaArray: type === 'array'，数组内容由用户管理，直接保留
      if (schemaDef.type === 'array') {
        result[key] = value;
        // SchemaGroup: 有 fields 子对象，递归清理
      } else if (
        schemaDef.fields &&
        typeof schemaDef.fields === 'object' &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        result[key] = this.removeExtraFields(
          value as Record<string, unknown>,
          schemaDef.fields as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * 深度合并默认值：只填充缺失的键，不覆盖已有值
   */
  private deepMergeDefaults(
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
        // 嵌套对象递归合并
        result[key] = this.deepMergeDefaults(
          defaultValue as Record<string, unknown>,
          result[key] as Record<string, unknown>,
        );
      }
    }
    return result;
  }

  /**
   * 重新扫描 packages/ 目录，加载新发现的插件（已注册的跳过）
   * 返回新加载的插件名列表
   */
  async rescanPlugins(): Promise<string[]> {
    const discovered = await this.discoverPlugins(this.packagesDir);
    const loaded: string[] = [];

    for (const pkg of discovered) {
      // 跳过已注册的
      if (this.plugins.getPlugin(pkg.name)) continue;

      try {
        // 用入口文件 mtime 做缓存键：未修改则走 ESM 缓存，改了的才重载
        let cacheKey = '';
        try {
          cacheKey = `?t=${(await stat(pkg.entry)).mtimeMs}`;
        } catch {
          /* stat 失败时用空 key，让 import 自己报错 */
        }
        const mod = (await import(pathToFileURL(pkg.entry).href + cacheKey)) as PluginModule;
        if (typeof mod.apply !== 'function' || !mod.name) {
          this.logger.debug(`跳过非插件模块: ${pkg.name}（缺少 name 或 apply）`);
          continue;
        }
        await this.plugin(mod);
        loaded.push(pkg.name);
        this.logger.info(`热加载插件: ${pkg.name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`热加载插件 "${pkg.name}" 失败: ${message}`);
      }
    }

    return loaded;
  }

  /**
   * 从 npm 安装插件到 packages/ 目录并加载
   * @param npmPkg npm 包名，如 "@aalis/plugin-example"
   * @returns 安装结果
   */
  async installPlugin(npmPkg: string): Promise<{ ok: boolean; message: string }> {
    // 从包名推导目录名: @aalis/plugin-xxx → plugin-xxx
    const dirName = npmPkg.replace(/^@[^/]+\//, '');
    const targetDir = resolve(this.packagesDir, dirName);

    if (existsSync(targetDir)) {
      return { ok: false, message: `目录 ${dirName} 已存在` };
    }

    this.logger.info(`正在安装插件: ${npmPkg} → packages/${dirName}`);

    try {
      await this.exec('npm', ['pack', npmPkg, '--pack-destination', this.packagesDir]);

      // npm pack 产出的文件名格式: scope-name-version.tgz
      // 找到 tgz 文件
      const dirents = await readdir(this.packagesDir);
      const tgzFile = dirents.find(f => f.endsWith('.tgz') && f.includes(dirName));
      if (!tgzFile) {
        return { ok: false, message: '下载包失败: 未找到 tgz 文件' };
      }

      const tgzPath = resolve(this.packagesDir, tgzFile);

      // 创建目录并解压
      await this.exec('mkdir', ['-p', targetDir]);
      await this.exec('tar', ['xzf', tgzPath, '-C', targetDir, '--strip-components=1']);

      // 清理 tgz
      await this.exec('rm', ['-f', tgzPath]);

      // 安装依赖
      await this.exec('pnpm', ['install', '--filter', npmPkg], process.cwd());

      // 加载插件
      const newPlugins = await this.rescanPlugins();

      if (newPlugins.length > 0) {
        return { ok: true, message: `已安装并加载: ${newPlugins.join(', ')}` };
      } else {
        return { ok: true, message: `已安装到 packages/${dirName}，但未发现新插件` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`安装插件 "${npmPkg}" 失败: ${message}`);
      return { ok: false, message };
    }
  }

  /**
   * 卸载插件：停用并删除 packages/ 下的目录
   */
  async uninstallPlugin(pluginName: string): Promise<{ ok: boolean; message: string }> {
    // 先卸载
    await this.plugins.unload(pluginName);

    // 从包名推导目录名
    const dirName = pluginName.replace(/^@[^/]+\//, '');
    const targetDir = resolve(this.packagesDir, dirName);

    if (!existsSync(targetDir)) {
      return { ok: true, message: `插件 ${pluginName} 已卸载（目录不存在）` };
    }

    try {
      await this.exec('rm', ['-rf', targetDir]);
      this.logger.info(`已删除插件目录: packages/${dirName}`);
      return { ok: true, message: `插件 ${pluginName} 已卸载并删除` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }

  // ---- 内部方法 ----

  /**
   * 扫描目录，返回可加载的插件列表
   */
  private async discoverPlugins(dir: string): Promise<Array<{ name: string; dir: string; entry: string }>> {
    this.logger.info(`正在扫描插件目录: ${dir}`);

    let entries: string[];
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      entries = dirents.filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name);
    } catch {
      this.logger.warn(`无法读取 packages 目录: ${dir}`);
      return [];
    }

    const discovered: Array<{ name: string; dir: string; entry: string }> = [];

    for (const entry of entries) {
      const pkgJsonPath = resolve(dir, entry, 'package.json');
      let pkgJson: Record<string, unknown>;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      } catch {
        this.logger.debug(`跳过 ${entry}: 无法读取 package.json`);
        continue;
      }

      // 跳过标记为 core 的包
      const aalisMeta = pkgJson.aalis as Record<string, unknown> | undefined;
      if (aalisMeta?.core) {
        this.logger.debug(`跳过核心包: ${pkgJson.name}`);
        continue;
      }

      // 跳过标记为 client 的前端包（非 Node.js 插件）
      if (aalisMeta?.client) {
        this.logger.debug(`跳过前端包: ${pkgJson.name}`);
        continue;
      }

      // 跳过标记为 types-only 的 API 包（仅提供类型声明合并，无 apply 实现）
      if (aalisMeta?.types) {
        this.logger.debug(`跳过类型包: ${pkgJson.name}`);
        continue;
      }

      const main = (pkgJson.main as string) || 'dist/index.js';
      discovered.push({
        name: pkgJson.name as string,
        dir: resolve(dir, entry),
        entry: resolve(dir, entry, main),
      });
    }

    return discovered;
  }

  private exec(cmd: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        {
          cwd: cwd ?? this.packagesDir,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        },
      );
    });
  }

  /**
   * 保存当前配置到磁盘
   */
  saveConfig(): void {
    this.ctx.config.save();
    this.logger.info('配置已保存');
  }

  /**
   * 配置文件外部变更时的处理：重新加载各插件配置并重新激活
   */
  private async handleConfigFileChanged(): Promise<void> {
    this.logger.info('检测到配置文件变更，正在热重载...');
    try {
      let changed = false;
      for (const p of this.plugins.getStatus()) {
        const defaults = p.defaultConfig ?? {};
        const fileConfig = this.ctx.config.getPluginConfig(p.instanceId);
        const newConfig = { ...defaults, ...fileConfig };
        if (JSON.stringify(newConfig) !== JSON.stringify(p.config)) {
          this.logger.info(`插件 ${p.instanceId} 配置已变更，正在重新加载...`);
          await this.plugins.updatePluginConfig(p.instanceId, newConfig);
          changed = true;
        }
      }
      if (changed) {
        await this.ctx.emit('plugins:changed');
      }
      this.logger.info('配置热重载完成');
    } catch (e) {
      this.logger.error('配置热重载失败:', e);
    }
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    this.logger.info('正在启动...');
    await this.ctx.emit('app:starting');

    // 应用配置文件中的服务偏好
    const prefs = this.ctx.config.getServicePreferences();
    for (const [service, contextId] of Object.entries(prefs)) {
      this.ctx.preferService(service, contextId);
    }

    // 检查核心必需服务，缺失时自动寻找并启动提供者
    await this.ensureRequiredServices();

    // 注：消息路由（inbound 多相位编排、outbound 钩子链）完全由
    // @aalis/plugin-gateway 承担。core 不内置任何消息派发兜底——若 gateway
    // 缺席，依赖它的插件会因为 inject.required 不满足而不激活，这正是
    // 反应式生命周期想要的"清晰失败"，而不是悄无声息地绕过 flow / trigger 等策略。

    // 发出 ready 事件
    await this.ctx.emit('ready');

    // 监听配置文件变更，热重载插件配置
    this.ctx.config.watch(() => this.handleConfigFileChanged());

    this.logger.info('启动完成');
    await this.ctx.emit('app:started');
  }

  /**
   * 重启应用（先停止再 spawn 新进程）
   * 延迟 500ms 执行，以便调用方能先返回响应
   */
  restart(): void {
    this.ctx
      .emit('restarting')
      .then(() => {
        setTimeout(async () => {
          await this.stop();
          const scriptFile = process.argv[1];
          let exec: string;
          let args: string[];
          if (scriptFile?.endsWith('.ts')) {
            const tsxBin = resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
            exec = existsSync(tsxBin) ? tsxBin : 'tsx';
            args = process.argv.slice(1);
          } else {
            [exec, ...args] = process.argv;
          }
          const child = spawn(exec, args, {
            cwd: process.cwd(),
            stdio: 'inherit',
            detached: true,
            env: process.env,
          });
          child.unref();
          process.exit(0);
        }, 500);
      })
      .catch(() => {});
  }

  /**
   * 停止应用
   */
  async stop(): Promise<void> {
    this.logger.info('正在停止...');
    this.ctx.config.unwatch();
    await this.ctx.emit('app:stopping');
    await this.ctx.emit('dispose');
    this.ctx.dispose();
    this.logger.info('已停止');
  }

  /**
   * 检查核心必需服务是否就绪，缺失时自动寻找并启动提供者
   */
  private async ensureRequiredServices(): Promise<void> {
    for (const service of this.requiredServices) {
      if (this.ctx.hasService(service)) {
        this.logger.debug(`必需服务 "${service}" 已就绪`);
        continue;
      }

      this.logger.warn(`必需服务 "${service}" 未就绪，尝试自动恢复...`);
      const activated = await this.plugins.ensureServiceProvider(service);
      if (activated) {
        this.logger.info(`必需服务 "${service}" 已通过插件 "${activated}" 恢复`);
      } else {
        this.logger.error(`必需服务 "${service}" 无法恢复！系统功能将受限。`);
      }
    }
  }
}
