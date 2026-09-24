import type { PluginManagerService } from '../types/app.js';

import { reportQuietly } from '../kernel/disposable-chain.js';

import { ContributionRegistry } from '../primitives/contributions.js';
import { EventBus } from '../primitives/events.js';
import { HookRegistry } from '../primitives/hooks.js';
import { ServiceContainer } from '../primitives/services.js';

import type { Activation } from './activation.js';
import { ActivationHost, notify } from './activation-host.js';
import { appService, HOST_CONFIG_KEYS, hostConfig, narrow, pluginsService } from './host-services.js';
import { PluginManager } from './plugin.js';
import type { RestartStrategy } from './providers.js';
import { events, provide, services } from '../composition/core-services.js';
import type { BoundOf, Uses } from '../composition/descriptors.js';
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
 * - `restartStrategy`：可选，提供重启实现；省略则 `restart()` 抛错
 */
export interface AppOptions {
  /**
   * 配置快照——必填。
   * 测试可直接传字面量 `{ name: 'X', logLevel: 'error', plugins: {} }`；
   * 生产入口由宿主从文件/URL/远端加载后传入。
   */
  config: AalisConfig;
  /** 配置持久化与外部变更监听；缺省=只读内存模式 */
  configProvider?: ConfigProvider;
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
 * // 浏览器/嵌入式：内存配置，插件由宿主直接交给 core
 * const app = createApp({ config: { name: 'embedded', logLevel: 'info', plugins: {} } });
 * await app.pluginAll([{ definition: memoryPlugin }, { definition: agentPlugin }]);
 *
 * // Node 宿主由 @aalis/runtime 提供插件发现、fs/yaml/spawn 实现
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
  /** 插件管理面（契约类型）；停机编排用的内部方法经 #plugins */
  readonly plugins: PluginManagerService;
  readonly #plugins: PluginManager;
  readonly logger: Logger;
  /** 整份配置的读写、落盘与外部变更监听（插件侧经 `hostConfig` 拿到的是只含读写方法的窄面） */
  readonly config: ConfigManager;
  /** 屏障事件（app:*）由 App 自己发；四原语注册表不外露，插件与宿主都经描述符取用 */
  readonly #events: EventBus;

  private pluginDefaults?: (definition: PluginDefinition) => Record<string, unknown>;
  private readonly restartStrategy?: RestartStrategy;
  private readonly disposeTimeoutMs: number;
  /** 停机单飞：重入返回同一 Promise；完成后仍保留，再调 stop() 立即落定 */
  private stopping?: Promise<void>;

  constructor(options: AppOptions) {
    // 1. 配置
    const config = new ConfigManager(options.config, { provider: options.configProvider });
    this.config = config;
    this.#events = new EventBus();
    // 'app:ready' / 'app:started' 是"应用启动完成"里程碑：app.start() 仅 emit
    // 一次，但插件配置热重载会触发 bounce → 新插件实例的
    // events.on('app:ready'/'app:started', ...) 必须也能拿到通知，否则 adapter /
    // CLI TUI 等"在启动后才建立"的逻辑在 bounce 后就永远不会重新执行。
    // 标记为 sticky 后，bounce 出来的新实例注册 listener 时立即被微任务补发一次。
    this.#events.markSticky('app:ready');
    this.#events.markSticky('app:started');
    const container = new ServiceContainer();
    const hookRegistry = new HookRegistry();
    const contributionRegistry = new ContributionRegistry();
    this.logger =
      options.logger ??
      new DefaultLogger('aalis', config.get('logLevel') as LogLevel, options.logHub ?? LogHub.default, options.now);
    // EventBus 保持环境无关不持有 Logger，handler 错误经此回调上报。
    this.#events.onHandlerError = (event, err, contextId) => {
      this.logger.warn(`事件 "${event}" 的监听器抛错（已隔离${contextId ? `，来自 ${contextId}` : ''}）:`, err);
    };
    // 广播型钩子相位的"卡链"上报同理（handler 忘调 next 会静默吞掉下游注入）。
    hookRegistry.onStall = (hook, contextId, skipped) =>
      this.logger.warn(`钩子 ${hook}: handler(来自 ${contextId}) 未调用 next()，其后 ${skipped} 个 handler 被跳过`);
    this.pluginDefaults = options.pluginDefaults;
    this.restartStrategy = options.restartStrategy;
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? 5000;

    // 2. 根激活
    const runtime = {
      events: this.#events,
      services: container,
      hooks: hookRegistry,
      contributions: contributionRegistry,
      devMode: options.devMode ?? true,
      notify: notify({ events: this.#events }, this.logger),
    };
    this.#host = new ActivationHost(runtime, this.logger);
    this.#root = this.#host.root;
    const caps = this.#host.bind(this.#root, { events, provide, services });

    // 3. 插件管理器
    this.#plugins = new PluginManager(this.#host, config, this.logger, this.disposeTimeoutMs);
    this.plugins = this.#plugins;

    // 4. 宿主服务：与内置八项同一登记规则（根激活、独占），只交出契约列出的方法
    caps.provide(appService, narrow(this, ['stop', 'restart', 'saveConfig']), { exclusive: true });
    caps.provide(
      pluginsService,
      {
        ...narrow(this.plugins, [
          'getStatus',
          'bounce',
          'updateConfig',
          'enable',
          'disable',
          'unload',
          'register',
          'idle',
        ]),
        // 交给插件的是快照：只有公开字段，内部激活记录不外露
        getPlugin: instanceId => {
          const entry = this.plugins.getPlugin(instanceId);
          if (!entry) return undefined;
          const { definition, config, state, error, required, optional } = entry;
          return { definition, instanceId: entry.instanceId, config, state, error, required, optional };
        },
      },
      { exclusive: true },
    );
    caps.provide(hostConfig, narrow(config, HOST_CONFIG_KEYS), { exclusive: true });

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
   * 有在飞 recompute（反应式级联/另一插件正在激活）**或挂起段在途**
   * （unload/disable/bounce 的拆卸窗口、另一批登记）时，本次请求排队并入其收尾，
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
    const [registered] = await this.pluginAll([{ definition, config, instanceId }]);
    return registered;
  }

  /**
   * 批量注册：全部落账后只重算一次。依赖方因此在同一次重算里按拓扑序排在它 required 服务的
   * 全部提供者之后激活，不会先挂到先登记的后备提供者上——宿主冷启动与热扫描都走这里。
   * resolve 语义同 {@link plugin}；返回值与 items 逐项对应。
   *
   * 合并优先级: 宿主派生的默认配置 ← 配置文件 ← 代码传入，**逐层深合并**：
   * 同一路径上双方都是纯对象则递归，否则后者整体覆盖（数组与非纯对象是原子值）。
   * 与宿主层（runtime/config-sync.ts）落盘回填默认值时的合并语义一致——顶层浅合并会让
   * 配置文件里只写了半块的嵌套组（只写 server.port）把派生默认值整块顶掉，
   * 插件首次 apply 就拿到缺 server.host 的配置。
   */
  async pluginAll(
    items: ReadonlyArray<{ definition: PluginDefinition; config?: Record<string, unknown>; instanceId?: string }>,
  ): Promise<boolean[]> {
    // 逐项合并：一项的默认值派生或配置读取抛错只让该项记 false，不拖累整批
    const prepared = items.map(({ definition, config, instanceId }) => {
      try {
        const id = instanceId ?? definition.name;
        const defaults = this.pluginDefaults?.(definition) ?? {};
        const merged = mergeConfigLayers(mergeConfigLayers(defaults, this.config.getPluginConfig(id)), config ?? {});
        return { definition, config: merged, instanceId: id };
      } catch (err) {
        this.logger.error(`插件 "${instanceId ?? definition?.name}" 的配置合并失败，未注册:`, err);
        return undefined;
      }
    });
    const registered = await this.#plugins.registerAll(prepared.filter(item => item !== undefined));
    let next = 0;
    return prepared.map(item => item !== undefined && registered[next++]);
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
    await this.#events.emit('app:starting');

    // 注：消息路由由网关插件承担，不在 core。
    await this.#events.emit('app:ready');

    this.logger.info('启动完成');
    await this.#events.emit('app:started');
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
    this.#events.clearSticky();
    this.#events
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
    this.#plugins.beginShutdown();
    await this.#plugins.idle();
    await this.#events.emit('app:stopping');
    await this.#plugins.idle();
    // 全部 active 插件与根激活进同一张关停计划——beginShutdown 已冻，这里执行 drain/close。
    await this.#plugins.stopAll();
    // 清掉全部 sticky 缓存（'app:ready' + 'app:started'），防止后续 restart
    // 复用过时的"已启动"标记
    this.#events.clearSticky();
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
