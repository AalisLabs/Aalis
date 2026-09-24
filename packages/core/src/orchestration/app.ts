import { reportQuietly } from '../kernel/disposable-chain.js';

import { ContributionRegistry } from '../primitives/contributions.js';
import { EventBus } from '../primitives/events.js';
import { HookRegistry } from '../primitives/hooks.js';
import { ServiceContainer } from '../primitives/services.js';

import type { Activation } from './activation.js';
import { ActivationHost, notify } from './activation-host.js';
import { PluginManager, parseInstanceId } from './plugin.js';
import type { PluginLoader, RestartStrategy } from './providers.js';
import { events, provide, services } from '../composition/core-services.js';
import { type BoundOf, defineService, type Uses } from '../composition/descriptors.js';
import type { PluginDefinition } from '../composition/plugin-definition.js';
import { type AalisConfig, ConfigManager, type ConfigProvider } from '../infrastructure/config.js';
import {
  cloneConfigObject,
  cloneConfigValue,
  isPlainConfigObject,
  isUnsafeConfigKey,
} from '../infrastructure/config-values.js';
import { DefaultLogger, type Logger, LogHub, type LogLevel } from '../infrastructure/logger.js';

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
  /** 插件加载器；缺省=不自动加载任何插件（必须通过 `app.plugin(mod)` 手动注册） */
  pluginLoader?: PluginLoader;
  /**
   * 插件默认配置的派生器；缺省=无默认值（注册时只用文件配置与传入配置）。
   *
   * 配置声明是宿主词汇（configSchema，见 @aalis/schema-config），core 不解释——
   * 宿主注入「从声明里派生默认值」的函数，core 只在注册合并时调用。
   * runtime 注入的是 `d => defaultsFrom(d.configSchema)`。
   */
  pluginDefaults?: (definition: PluginDefinition) => Record<string, unknown>;
  /** 重启策略；缺省=`restart()` 抛错 */
  restartStrategy?: RestartStrategy;
  /** 注入自定义事件总线 */
  events?: EventBus;
  /** 注入自定义服务容器 */
  services?: ServiceContainer;
  /** 注入自定义钩子注册表 */
  hooks?: HookRegistry;
  /** 注入自定义贡献点注册表 */
  contributions?: ContributionRegistry;
  /**
   * 单个异步清理项（onDispose 返回的 promise）的等待上限（毫秒），默认 5000。
   * 用于插件 unload / bounce / 停机路径的 disposeAsync——网络类关闭（数据库/
   * 浏览器/MCP 连接）卡死时放弃等待该项、继续后续清理并 warn 点名。该值不是整个停机的期限：
   * apply 与屏障事件没有新增超时，仍可能阻塞管理流程。传 0 表示不设限。
   */
  disposeTimeoutMs?: number;
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
   * 开发模式开关——传递给根激活，决定 `provide` 与激活路径是否跑一致性劝告。
   * 默认 `true`（dev-safe）；生产宿主应显式传入 `false` 跳过热路径开销。
   * core 不读 `process.env`，完全以宿主传入为准。
   */
  devMode?: boolean;
  /**
   * 时钟：日志时间戳的时间来源。缺省 `() => new Date()`（保持现行为）；宿主可注入固定时钟做
   * 确定性测试。core 逻辑不主动取墙上时间，全由此注入——与 `devMode` 同为"宿主决定"注入项。
   */
  now?: () => Date;
  /**
   * 内核版本号，仅用于启动 banner 展示（如 `Aalis Core 0.6.0 - <name>`）。
   * core 环境无关、零依赖，不能自读 package.json；由宿主（@aalis/runtime）读取
   * `@aalis/core` 的实际版本注入——与 `now` / `devMode` 同为"宿主决定"注入项。
   * 缺省时 banner 省略版本段（嵌入 / 测试场景无宿主注入）。
   */
  version?: string;
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
 * // Node 宿主由 @aalis/runtime 提供 fs/yaml/spawn 实现
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
  /** 根激活：宿主绑定（{@link bind}）与核心服务的归属，全部插件激活的父。不对外——宿主经 bind 取能力 */
  readonly #root: Activation;
  readonly #host: ActivationHost;
  readonly plugins: PluginManager;
  readonly logger: Logger;
  /** 整份配置的读写、落盘与外部变更监听（插件侧的同一对象经 `hostConfig` 描述符声明获取） */
  readonly config: ConfigManager;

  readonly events: EventBus;
  readonly services: ServiceContainer;
  readonly hooks: HookRegistry;
  readonly contributions: ContributionRegistry;

  private readonly pluginLoader?: PluginLoader;
  private pluginDefaults?: (definition: PluginDefinition) => Record<string, unknown>;
  private readonly restartStrategy?: RestartStrategy;
  private readonly disposeTimeoutMs: number;
  /** 停机单飞：重入返回同一 Promise；完成后仍保留，再调 stop() 立即落定 */
  private stopping?: Promise<void>;

  constructor(options: AppOptions) {
    // 1. 配置：接受快照或已构造的 ConfigManager
    const config =
      options.config instanceof ConfigManager
        ? options.config
        : new ConfigManager(options.config, {
            provider: options.configProvider,
          });

    this.config = config;
    this.events = options.events ?? new EventBus();
    // 'app:ready' / 'app:started' 是"应用启动完成"里程碑：app.start() 仅 emit
    // 一次，但插件配置热重载会触发 bounce → 新插件实例的
    // events.on('app:ready'/'app:started', ...) 必须也能拿到通知，否则 adapter /
    // CLI TUI 等"在启动后才建立"的逻辑在 bounce 后就永远不会重新执行。
    // 标记为 sticky 后，bounce 出来的新实例注册 listener 时立即被微任务补发一次。
    this.events.markSticky('app:ready');
    this.events.markSticky('app:started');
    this.services = options.services ?? new ServiceContainer();
    this.hooks = options.hooks ?? new HookRegistry();
    this.contributions = options.contributions ?? new ContributionRegistry();
    this.logger =
      options.logger ??
      new DefaultLogger('aalis', config.get('logLevel') as LogLevel, options.logHub ?? LogHub.default, options.now);
    // EventBus 保持环境无关不持有 Logger，handler 错误经此回调上报。
    // 外部注入的 bus 若已自带上报器则尊重之（??=）。
    this.events.onHandlerError ??= (event, err, contextId) => {
      this.logger.warn(`事件 "${event}" 的监听器抛错（已隔离${contextId ? `，来自 ${contextId}` : ''}）:`, err);
    };
    // 广播型钩子相位的"卡链"上报同理（handler 忘调 next 会静默吞掉下游注入）。
    this.hooks.onStall ??= (hook, contextId, skipped) =>
      this.logger.warn(`钩子 ${hook}: handler(来自 ${contextId}) 未调用 next()，其后 ${skipped} 个 handler 被跳过`);
    this.pluginLoader = options.pluginLoader;
    this.pluginDefaults = options.pluginDefaults;
    this.restartStrategy = options.restartStrategy;
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? 5000;

    // 2. 根激活
    const runtime = {
      events: this.events,
      services: this.services,
      hooks: this.hooks,
      contributions: this.contributions,
      devMode: options.devMode ?? true,
      notify: notify(this, this.logger),
    };
    this.#host = new ActivationHost(runtime, this.logger);
    this.#root = this.#host.root;
    const caps = this.#host.bind(this.#root, { events, provide, services });

    // 3. 插件管理器
    this.plugins = new PluginManager(this.#host, config, this.logger, this.disposeTimeoutMs);

    // 4. 注册核心服务
    caps.provide(defineService<App>('app'), this);
    caps.provide(defineService<PluginManager>('plugins'), this.plugins);
    caps.provide(defineService<ConfigManager>('host-config'), config);

    // 5. 应用启动时已存在的服务偏好
    const initialPrefs = config.getServicePreferences();
    for (const [svcName, ctxId] of Object.entries(initialPrefs)) {
      caps.services.prefer(svcName, ctxId);
    }

    // 6. 服务偏好诊断日志
    caps.events.on('service:registered', svcName => {
      const pref = config.getServicePreferences()[svcName];
      if (pref) {
        this.logger.debug(`服务 "${svcName}" 注册时存在用户偏好: ${pref}`);
      }
    });

    // 版本由宿主注入（core 不自读 package.json）；未注入时省略版本段。
    const versionSeg = options.version ? ` Core ${options.version}` : ' Core';
    this.logger.info(`Aalis${versionSeg} - ${config.get('name')}`);
  }

  /**
   * 宿主取根激活绑定的服务接口：与插件同一套描述符与装配，登记归属根激活、随 App 停止撤回。
   * 插件拿的是自己激活的绑定，不复用这里的。
   */
  bind<U extends Uses>(uses: U): BoundOf<U> {
    return this.#host.bind(this.#root, uses);
  }

  /**
   * 注册插件
   *
   * **resolve 语义 = 注册落账 + 尽力即时激活**：完全静置时激活在返回前同步收敛；
   * 有在飞 recompute（反应式级联/另一插件正在激活）**或手动 dispose 段在途**
   * （unload/disable/bounce 的挂起窗口）时，本次请求排队并入其收尾，
   * resolve 时激活可能尚未发生（排队不丢失——单飞排队见 recompute）。需要
   * 「激活已落定」的确定时机，调用后 `await app.plugins.idle()`（不得在插件
   * apply/onDispose 内这样做——自等死锁，见 idle）。
   *
   * @param definition 插件定义（definePlugin 的产物）
   * @param config     插件配置（覆盖文件配置）
   * @param instanceId 实例 ID（多实例时为 `name:suffix`，留空则使用 definition.name）
   * @returns 同 `plugins.register`：false = 重名或未声明 reusable 的多实例，已记 warn
   */
  async plugin(definition: PluginDefinition, config?: Record<string, unknown>, instanceId?: string): Promise<boolean> {
    const id = instanceId ?? definition.name;
    // 合并优先级: 宿主派生的默认配置 ← 配置文件 ← 代码传入，**逐层深合并**：
    // 同一路径上双方都是纯对象则递归，否则后者整体覆盖（数组与非纯对象是原子值）。
    // 与宿主层（runtime/config-sync.ts）落盘回填默认值时的合并语义一致——顶层浅合并会让
    // 配置文件里只写了半块的嵌套组（只写 server.port）把派生默认值整块顶掉，
    // 插件首次 apply 就拿到缺 server.host 的配置。
    const defaults = this.pluginDefaults?.(definition) ?? {};
    const fileConfig = this.config.getPluginConfig(id);
    const mergedConfig = mergeConfigLayers(mergeConfigLayers(defaults, fileConfig), config ?? {});
    return this.plugins.register(definition, mergedConfig, id);
  }

  /**
   * 通过 `pluginLoader` 自动加载所有发现的插件。
   * 未注入 loader 时为 no-op，调用方需自行 `app.plugin(definition)` 手动注册。
   */
  async autoLoadPlugins(): Promise<void> {
    if (!this.pluginLoader) {
      this.logger.debug('未注入 pluginLoader，跳过自动加载');
      return;
    }

    const discovered = await this.pluginLoader.discover();
    this.logger.info(`发现 ${discovered.length} 个插件`);

    // 按模块名索引（用于多实例查找）
    const loadedModules = new Map<string, PluginDefinition>();

    // 加载并立即注册激活（导入插件模块没有顶层副作用，单次遍历即可）
    for (const desc of discovered) {
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
          this.logger.error(`注册插件 "${mod.name}" 失败:`, err);
        }
      } catch (err) {
        this.logger.error(`加载插件 "${desc.name}" 失败:`, err);
      }
    }

    await this.registerConfiguredInstances(loadedModules);

    // 配置同步政策（默认值回填 / schema 裁剪）属宿主层，由宿主在本方法之后自行执行。

    // 引导期收敛保证的结构化落点：register 的 recompute 在有在飞 run 时排队早退
    // （见 plugin() JSDoc），此前「本方法返回即全部收敛」靠调用点 await 交错偶然
    // 成立——app:ready / app:started 的发出时机依赖这条保证，必须等静置而非碰运气。
    // 引导路径不在任何 apply 内，无 idle 自等死锁面。
    await this.plugins.idle();
  }

  /**
   * 重新扫描插件源，加载新发现的插件（已注册的跳过）。
   * 返回新加载的插件名列表。
   *
   * 优先调用 `pluginLoader.reload(desc)` 实现热重载（loader 可做缓存失效）；
   * 未实现 reload 时退化到普通 `load(desc)`。
   *
   * resolve 语义同 `plugin()`（注册落账+尽力即时激活）。**刻意不等静置**：本方法
   * 挂在 HTTP 热路径上，等静置会把请求延迟耦合到无关插件的慢 apply；市场的
   * 就位判据本就只看注册表在场（见 package-manager 的 isPluginRegistered）。
   */
  async rescanPlugins(): Promise<string[]> {
    if (!this.pluginLoader) return [];
    const discovered = await this.pluginLoader.discover();
    const loaded: string[] = [];
    const loadedModules = new Map<string, PluginDefinition>();

    for (const desc of discovered) {
      const already = this.plugins.getPlugin(desc.name);
      if (already) {
        loadedModules.set(already.definition.name, already.definition);
        continue;
      }

      try {
        const mod = this.pluginLoader.reload
          ? await this.pluginLoader.reload(desc)
          : await this.pluginLoader.load(desc);
        if (!mod || typeof mod.apply !== 'function' || !mod.name) {
          this.logger.debug(`跳过非插件模块: ${desc.name}`);
          continue;
        }
        loadedModules.set(mod.name, mod);
        // 按 desc.name 查重只能挡住同名描述符；模块自报的 name 与 desc.name 不同且已注册时，
        // register 会拒绝——那不算热加载，不能报进名单。定义仍留给后缀实例循环用。
        if (!(await this.plugin(mod))) continue;
        loaded.push(desc.name);
        this.logger.info(`热加载插件: ${desc.name}`);
      } catch (err) {
        this.logger.error(`热加载插件 "${desc.name}" 失败:`, err);
      }
    }

    await this.registerConfiguredInstances(loadedModules);
    return loaded;
  }

  /**
   * 配置键里的 `name:suffix` 多实例：模块已在 loadedModules 时登记。已在注册表的跳过。
   * autoLoad 与 rescan 共用，热激活不得比引导少收后缀实例。
   */
  private async registerConfiguredInstances(loadedModules: Map<string, PluginDefinition>): Promise<void> {
    const pluginConfigs = this.config.get('plugins') ?? {};
    for (const configKey of Object.keys(pluginConfigs)) {
      const { moduleName, suffix } = parseInstanceId(configKey);
      if (!suffix) continue;
      if (this.plugins.getPlugin(configKey)) continue;
      const mod = loadedModules.get(moduleName);
      if (!mod) {
        this.logger.warn(`多实例配置 "${configKey}" 对应的模块 "${moduleName}" 未找到，跳过`);
        continue;
      }
      try {
        await this.plugin(mod, undefined, configKey);
      } catch (err) {
        this.logger.error(`加载多实例插件 "${configKey}" 失败:`, err);
      }
    }
  }

  /**
   * 保存当前配置（委托给 configProvider；无 provider 时立即完成）。返回的 Promise 兑现时保存已完成，
   * provider 失败以拒绝传出——调用方应 await，见 AppService 契约。
   *
   * 失败在这里记一笔并标记为已处理：不 await 也不 catch 的调用方（0.13.0 之前发布的插件如此）
   * 不会因一次落盘失败变成未处理拒绝、被宿主当致命错误退出；await 的调用方照常拿到拒绝。
   */
  saveConfig(): Promise<void> {
    const done = this.persistConfig();
    done.catch(err => reportQuietly(() => this.logger.error('配置保存失败:', err)));
    return done;
  }

  private async persistConfig(): Promise<void> {
    await this.config.save();
    this.logger.info('配置已保存');
  }

  /**
   * 启动应用
   *
   * 配置外部变更的热重载编排（diff + bounce）属宿主政策：
   * 宿主自行 `app.config.watch(cb)` 接管。
   */
  async start(): Promise<void> {
    this.logger.info('正在启动...');
    await this.events.emit('app:starting');

    // 注：消息路由由 @aalis/plugin-gateway 承担。
    await this.events.emit('app:ready');

    this.logger.info('启动完成');
    await this.events.emit('app:started');
  }

  /**
   * 重启应用——委托给 `restartStrategy`。
   *
   * core 只负责发出 `app:restarting` 事件并把 `stop` 回调交给策略；
   * **任何"等响应返回"的延迟、stop 与 restart 的顺序都由策略决定**。
   *
   * 未注入策略时抛错（明确暴露"嵌入式宿主没声明重启能力"的事实）。
   */
  restart(opts?: { rollback?: unknown }): void {
    if (!this.restartStrategy) {
      throw new Error('App.restart() 不可用：未注入 restartStrategy。');
    }
    const strategy = this.restartStrategy;
    // 防御性清掉全部 sticky 缓存（'app:ready' + 'app:started'）：strategy 可能走
    // "快速重启"路径不调 stop()，此时新一轮启动期间的早期订阅者会收到上一轮
    // 的 sticky 信号。stop() 内部会再清一次，重复调用无副作用。
    this.events.clearSticky();
    this.events
      .emit('app:restarting')
      .then(() => strategy.restart({ stop: () => this.stop(), rollback: opts?.rollback }))
      .catch(err => reportQuietly(() => this.logger.error('restart 失败:', err)));
  }

  /**
   * 停止应用。单飞：重入返回同一 Promise。
   *
   * 先 `beginShutdown()` 置 shuttingDown（新 bounce/register 被拒），再 `idle()` 排干在飞者，
   * 然后发 `app:stopping`，最后 stopAll。已静置时 `idle()` 仍让出一轮微任务——必须先冻闸，
   * 否则同轮排队的 bounce 会在置位前过闸、停机后留下 pending 幽灵。
   *
   * 每次调用都返回完整停机的同一 Promise，包括屏障监听器与清理期间的调用。
   * `app:stopping` 监听器与清理回调不得 await 或返回该 Promise，否则会等待自身。
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    // 在调用宿主 logger / unwatch 前发布完成对象，同步重入也只能加入本次停机。
    this.stopping = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // 同步启动：不能延后一轮微任务，否则 bounce 可能抢在 beginShutdown 前过闸。
    void this.runStop().then(resolve, reject);
    return this.stopping;
  }

  private async runStop(): Promise<void> {
    this.logger.info('正在停止...');
    this.config.unwatch();
    this.plugins.beginShutdown();
    await this.plugins.idle();
    await this.events.emit('app:stopping');
    await this.plugins.idle();
    // 全部 active 插件与根激活进同一张关停计划——beginShutdown 已冻，这里执行 drain/close。
    await this.plugins.stopAll();
    // 清掉全部 sticky 缓存（'app:ready' + 'app:started'），防止后续 restart
    // 复用过时的"已启动"标记
    this.events.clearSticky();
    // 等待根激活的异步清理真正完成再宣告停止
    await this.#root.disposeAsync(this.disposeTimeoutMs);
    this.logger.info('已停止');
  }
}

/**
 * 配置层的逐层深合并：同一键上 base 与 override 都是纯对象时递归合并，
 * 否则 override 的值整体覆盖。数组与非纯对象（Date / Map / 类实例）当作
 * 原子值，只覆盖不逐元素合并。
 *
 * 全程返回新对象、不改写入参：`defaults` 可能是宿主复用的常量，`fileConfig`
 * 是 ConfigManager 持有的活对象，合并写回去就是隔空篡改配置。
 * 纯对象递归拷贝，数组拷一层（元素若为纯对象也拷）；原子值按引用透传，
 * 调用方不得依赖其不可变。危险键（`__proto__` / `constructor` / `prototype`）跳过。
 */
function mergeConfigLayers(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = cloneConfigObject(base);
  for (const [key, value] of Object.entries(override)) {
    if (isUnsafeConfigKey(key)) continue;
    const prev = result[key];
    result[key] =
      isPlainConfigObject(prev) && isPlainConfigObject(value)
        ? mergeConfigLayers(prev, value)
        : cloneConfigValue(value);
  }
  return result;
}
