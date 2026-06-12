import { type AalisConfig, ConfigManager } from './config.js';
import { Context } from './context.js';
import { EventBus } from './events.js';
import { HookRegistry } from './hooks.js';
import { DefaultLogger, type Logger, LogHub, type LogLevel } from './logger.js';
import { PluginManager, type PluginModule, parseInstanceId } from './plugin.js';
import type { ConfigProvider, PluginDescriptor, PluginLoader, RestartStrategy } from './providers.js';
import { ServiceContainer } from './service.js';

// ----- 应用配置选项 -----

/**
 * App 构造选项
 *
 * core 不感知"文件系统 / 进程 / 终端"等任何 I/O 概念——这些通过 provider 注入：
 * - `config`：当前配置快照（必填；由宿主从任意来源加载好传进来）
 * - `configProvider`：可选，提供 save() / watch() 能力；省略则配置只读
 * - `pluginLoader`：可选，提供插件发现+导入；省略则 `autoLoadPlugins()` 为 no-op
 * - `restartStrategy`：可选，提供重启实现；省略则 `restart()` 抛错
 *
 * 所有内核子系统（events / services / hooks / config）均可注入自定义实例，
 * 用于沙盒/测试/多实例场景。
 */
export interface AppOptions {
  /**
   * 配置快照——必填。
   * 测试可直接传字面量 `{ name: 'X', logLevel: 'error', plugins: {} }`；
   * 生产入口由宿主从文件/URL/远端加载后传入。
   *
   * 也接受已构造好的 `ConfigManager`（沙盒共享、scope 等场景）。
   */
  config: AalisConfig | ConfigManager;
  /** 配置持久化与外部变更监听；缺省=只读内存模式 */
  configProvider?: ConfigProvider;
  /** 业务数据目录（plugin 用作相对路径基准） */
  dataDir?: string;
  /** 插件加载器；缺省=不自动加载任何插件（必须通过 `app.plugin(mod)` 手动注册） */
  pluginLoader?: PluginLoader;
  /** 重启策略；缺省=`restart()` 抛错 */
  restartStrategy?: RestartStrategy;
  /** 注入自定义事件总线 */
  events?: EventBus;
  /** 注入自定义服务容器 */
  services?: ServiceContainer;
  /** 注入自定义钩子注册表 */
  hooks?: HookRegistry;
  /**
   * 注入自定义 LogHub。多 App 沙盒 / 集成测试 / 嵌入多实例场景下
   * 可以传入 `new LogHub()`使每个 App 拥有独立的日志通道，不互相串台。
   * 缺省 = `LogHub.default`（进程级共享，runtime sink 默认订阅的也是它）。
   */
  logHub?: LogHub;
  /**
   * 注入自定义 Logger 实现（如 pino/winston 适配对象）。
   * 注入后 core 不再写 LogHub 管线——runtime 的 console/file/webui sink
   * 监听的是 LogHub，是否对接由注入方自理。缺省 = DefaultLogger（写入 logHub）。
   */
  logger?: Logger;
  /**
   * 必需服务列表——这些服务必须至少有一个提供者在运行。
   * 默认 `[]`，core 不假设任何具体服务存在。
   */
  requiredServices?: string[];
  /**
   * 开发模式开关——传递给根 Context，决定 `provide` 是否跑能力探测。
   * 默认 `true`（dev-safe）；生产宿主应显式传入 `false` 跳过热路径开销。
   * core 不读 `process.env`，完全以宿主传入为准。
   */
  devMode?: boolean;
}

/**
 * 创建 App 实例的工厂函数。
 *
 * @example
 * // 浏览器/嵌入式：内存配置 + 内存插件加载
 * const app = createApp({
 *   config: { name: 'embedded', logLevel: 'info', plugins: {} },
 *   pluginLoader: bundledLoader([memoryPlugin, agentPlugin]),
 * });
 *
 * // Node 宿主由 src/runtime 提供 fs/yaml/spawn 实现
 */
export function createApp(options: AppOptions): App {
  return new App(options);
}

/**
 * Aalis 应用主容器
 *
 * core 的"内核"——只持有内存中的抽象（events / services / hooks / config / plugins），
 * 不接触任何外部 I/O。所有 I/O 通过 `AppOptions` 注入的 provider 完成。
 */
export class App {
  readonly ctx: Context;
  readonly plugins: PluginManager;
  readonly logger: Logger;

  readonly events: EventBus;
  readonly services: ServiceContainer;
  readonly hooks: HookRegistry;

  readonly requiredServices: readonly string[];

  private readonly pluginLoader?: PluginLoader;
  private readonly restartStrategy?: RestartStrategy;
  /** 已发现插件的描述符索引（按模块名）。用于热重载时拿到 source/metadata。 */
  private readonly discoveredCache: Map<string, PluginDescriptor> = new Map();

  constructor(options: AppOptions) {
    // 1. 配置：接受快照或已构造的 ConfigManager
    const config =
      options.config instanceof ConfigManager
        ? options.config
        : new ConfigManager(options.config, {
            provider: options.configProvider,
            dataDir: options.dataDir,
          });

    this.events = options.events ?? new EventBus();
    // 'ready' / 'app:started' 是"应用启动完成"里程碑：app.start() 仅 emit
    // 一次，但插件配置热重载会触发 bouncePlugin → 新插件实例的
    // ctx.on('ready'/'app:started', ...) 必须也能拿到通知，否则 adapter /
    // CLI TUI 等"在启动后才建立"的逻辑在 bounce 后就永远不会重新执行。
    // 标记为 sticky 后，bounce 出来的新实例注册 listener 时立即被微任务补发一次。
    this.events.markSticky('ready');
    this.events.markSticky('app:started');
    this.services = options.services ?? new ServiceContainer();
    this.hooks = options.hooks ?? new HookRegistry();
    this.logger =
      options.logger ??
      new DefaultLogger('aalis', config.get('logLevel') as LogLevel, options.logHub ?? LogHub.default);
    // EventBus 保持环境无关不持有 Logger，handler 错误经此回调上报。
    // 外部注入的 bus 若已自带上报器则尊重之（??=）。
    this.events.onHandlerError ??= (event, err) => {
      this.logger.warn(`事件 "${event}" 的监听器抛错（已隔离）:`, err);
    };
    this.pluginLoader = options.pluginLoader;
    this.restartStrategy = options.restartStrategy;

    // 2. 根上下文
    this.ctx = new Context({
      id: 'root',
      events: this.events,
      services: this.services,
      hooks: this.hooks,
      logger: this.logger,
      config,
      devMode: options.devMode ?? true,
    });

    // 3. 插件管理器
    this.plugins = new PluginManager(this.ctx, this.logger);
    this.requiredServices = options.requiredServices ?? [];
    this.plugins.requiredServices = this.requiredServices;

    // 4. 注册核心服务
    this.ctx.provide('app', this, { capabilities: ['lifecycle', 'config'] });
    this.ctx.provide('plugins', this.plugins, { capabilities: ['plugin-mgmt'] });

    // 5. 应用启动时已存在的服务偏好
    const initialPrefs = config.getServicePreferences();
    for (const [svcName, ctxId] of Object.entries(initialPrefs)) {
      this.ctx.preferService(svcName, ctxId);
    }

    // 6. 服务偏好诊断日志
    this.ctx.on('service:registered', svcName => {
      const pref = config.getServicePreferences()[svcName];
      if (pref) {
        this.logger.debug(`服务 "${svcName}" 注册时存在用户偏好: ${pref}`);
      }
    });

    // 7. 必需服务掉线自动恢复
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
   * 通过 `pluginLoader` 自动加载所有发现的插件。
   * 未注入 loader 时为 no-op，调用方需自行 `app.plugin(mod)` 手动注册。
   */
  async autoLoadPlugins(): Promise<void> {
    if (!this.pluginLoader) {
      this.logger.debug('未注入 pluginLoader，跳过自动加载');
      return;
    }

    const discovered = await this.pluginLoader.discover();
    this.logger.info(`发现 ${discovered.length} 个插件`);

    // 按模块名索引（用于多实例查找）
    const loadedModules = new Map<string, PluginModule>();

    // 加载所有模块（M2 后无 Context.extend 顶层副作用，单次遍历即可：加载并立即注册激活）
    for (const desc of discovered) {
      this.discoveredCache.set(desc.name, desc);
      try {
        const mod = await this.pluginLoader.load(desc);
        if (!mod || typeof mod.apply !== 'function' || !mod.name) {
          this.logger.debug(`跳过非插件模块: ${desc.name}（缺少 name 或 apply）`);
          continue;
        }
        loadedModules.set(mod.name, mod);
        try {
          await this.plugin(mod);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`注册插件 "${mod.name}" 失败: ${message}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`加载插件 "${desc.name}" 失败: ${message}`);
      }
    }

    // 扫描配置中的多实例条目（name:suffix 格式）
    const pluginConfigs = this.ctx.config.get('plugins') ?? {};
    for (const configKey of Object.keys(pluginConfigs)) {
      const { moduleName, suffix } = parseInstanceId(configKey);
      if (!suffix) continue;
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

    // 同步插件 defaultConfig
    const changed = this.ctx.config.syncPluginDefaults(this.plugins.getStatus());
    for (const id of changed) this.logger.debug(`同步插件配置: ${id}`);
    if (changed.length > 0) this.logger.info('已将插件配置同步到配置文件');
  }

  /**
   * 重新扫描插件源，加载新发现的插件（已注册的跳过）。
   * 返回新加载的插件名列表。
   *
   * 优先调用 `pluginLoader.reload(desc)` 实现热重载（loader 可做缓存失效）；
   * 未实现 reload 时退化到普通 `load(desc)`。
   */
  async rescanPlugins(): Promise<string[]> {
    if (!this.pluginLoader) return [];
    const discovered = await this.pluginLoader.discover();
    const loaded: string[] = [];

    for (const desc of discovered) {
      this.discoveredCache.set(desc.name, desc);
      // 跳过已注册的
      if (this.plugins.getPlugin(desc.name)) continue;

      try {
        const mod = this.pluginLoader.reload
          ? await this.pluginLoader.reload(desc)
          : await this.pluginLoader.load(desc);
        if (!mod || typeof mod.apply !== 'function' || !mod.name) {
          this.logger.debug(`跳过非插件模块: ${desc.name}`);
          continue;
        }
        await this.plugin(mod);
        loaded.push(desc.name);
        this.logger.info(`热加载插件: ${desc.name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`热加载插件 "${desc.name}" 失败: ${message}`);
      }
    }

    return loaded;
  }

  /**
   * 保存当前配置（委托给 configProvider；无 provider 时静默忽略）。
   */
  saveConfig(): void {
    this.ctx.config.save();
    this.logger.info('配置已保存');
  }

  /**
   * 配置外部变更时的处理：重新计算各插件配置并热重载差异。
   */
  private async handleConfigFileChanged(): Promise<void> {
    this.logger.info('检测到配置变更，正在热重载...');
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

    await this.ensureRequiredServices();

    // 注：消息路由由 @aalis/plugin-gateway 承担。
    await this.ctx.emit('ready');

    // 监听配置外部变更（provider 不支持 watch 时为 no-op）
    this.ctx.config.watch(() => this.handleConfigFileChanged());

    this.logger.info('启动完成');
    await this.ctx.emit('app:started');
  }

  /**
   * 重启应用——委托给 `restartStrategy`。
   *
   * core 只负责发出 `restarting` 事件并把 `stop` 回调交给策略；
   * **任何"等响应返回"的延迟、stop 与 restart 的顺序都由策略决定**。
   *
   * 未注入策略时抛错（明确暴露"嵌入式宿主没声明重启能力"的事实）。
   */
  restart(): void {
    if (!this.restartStrategy) {
      throw new Error('App.restart() 不可用：未注入 restartStrategy。');
    }
    const strategy = this.restartStrategy;
    // 防御性清掉全部 sticky 缓存（'ready' + 'app:started'）：strategy 可能走
    // "快速重启"路径不调 stop()，此时新一轮启动期间的早期订阅者会收到上一轮
    // 的 sticky 信号。stop() 内部会再清一次，重复调用无副作用。
    this.events.clearSticky();
    this.ctx
      .emit('restarting')
      .then(() => strategy.restart({ stop: () => this.stop() }))
      .catch(err => {
        this.logger.warn(`restart 失败: ${err}`);
      });
  }

  /**
   * 停止应用
   */
  async stop(): Promise<void> {
    this.logger.info('正在停止...');
    this.ctx.config.unwatch();
    await this.ctx.emit('app:stopping');
    // 先按拓扑逆序 dispose 所有 active 插件——消费者先关，提供者后关——这样下游
    // 插件的 ctx.onDispose 还能安全访问其依赖的服务。stopAll 会置位 shuttingDown，
    // 屏蔽反应式 service:unregistered 级联，避免无意义 bounce 噪声。
    await this.plugins.stopAll();
    // 清掉全部 sticky 缓存（'ready' + 'app:started'），防止后续 restart
    // 复用过时的"已启动"标记
    this.events.clearSticky();
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
