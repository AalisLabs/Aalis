import type { PluginManagerService } from '../types/app.js';

import { EventBus } from '../primitives/events.js';
import { ServiceContainer } from '../primitives/services.js';

import { ActivationHost, notify } from './activation-host.js';
import { appService, narrow, pluginsService } from './host-services.js';
import { PluginManager, type PluginRegistration } from './plugin.js';
import type { RestartStrategy } from './providers.js';
import { provide } from '../composition/core-services.js';
import type { BoundOf, Uses } from '../composition/descriptors.js';
import type { PluginDefinition } from '../composition/plugin-definition.js';
import { DefaultLogger, type Logger, LogHub, type LogLevel, quietLogger } from '../infrastructure/logger.js';

// ----- 应用配置选项 -----

/**
 * App 构造选项
 *
 * core 不感知"文件系统 / 进程 / 终端"等任何 I/O 概念，也不持有配置文档：插件从哪里来、
 * 配置存在哪里都是宿主的事，core 只接收注册时交来的插件定义、配置与禁用标记。
 * 选项全部可省：`restartStrategy` 省略则 `restart()` 抛错。
 */
export interface AppOptions {
  /** 应用名，只用于启动横幅；缺省 'Aalis' */
  name?: string;
  /** 默认 Logger 的级别；缺省 'info'。注入了 `logger` 时不用 */
  logLevel?: LogLevel;
  /** 重启策略；缺省=`restart()` 抛错 */
  restartStrategy?: RestartStrategy;
  /**
   * 单个异步清理项（onDispose 返回的 promise）的等待上限（毫秒），默认 5000。
   * 用于插件 unload / bounce / 停机路径的 disposeAsync——网络类关闭（数据库/
   * 浏览器/MCP 连接）卡死时放弃等待该项、继续后续清理并 warn 点名。
   * 也是停用、卸载、重启、停机撞上仍在初始化的插件，或后台激活的 required 依赖下线时的宽限：abort 它的
   * `lifecycle.signal` 后，自其收尾段开始至多再等这么久，到期仍未落定即不再等待。关完仍有工作没落定的旧实例停下之前，
   * 同一 id 不起新实例（`getStatus()` 的 `lingering`）。该值不是整个停机的期限。
   * 传 0 表示不设限；超过 2³¹−1（定时器的最大延迟）按 2³¹−1 计。
   */
  disposeTimeoutMs?: number;
  /**
   * 慢操作阈值（毫秒），默认 60000。插件激活超过它仍未完成：记一条 warn 点名，转入后台继续（它提供的服务在激活
   * 完成前不对依赖方开放），重算接着处理后面的插件，此后不再提醒（后台状态看 `getStatus()` 的 `slow`）；`app:*`
   * 屏障事件的单个监听器超过它仍未返回：记 warn 点名，不再等它。传 0 表示不设限；超过 2³¹−1 按 2³¹−1 计。
   */
  slowThresholdMs?: number;
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
   * 注入的与缺省的都由 App 包一层再用：日志方法抛错或返回被拒的 Promise 不传进 core 与插件，`child` 派生失败时沿用上一层，`app.logger` 也是包过的这层。
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
 * // 浏览器/嵌入式：插件与各自的配置由宿主直接交给 core
 * const app = createApp({ name: 'embedded' });
 * await app.pluginAll([{ definition: memoryPlugin, config: { maxItems: 100 } }, { definition: agentPlugin }]);
 *
 * // Node 宿主由 @aalis/runtime 提供插件发现、配置文档与 fs/yaml/spawn 实现
 */
export function createApp(options: AppOptions): App {
  return new App(options);
}

/**
 * Aalis 应用主容器
 *
 * core 的"内核"——只持有内存中的抽象（events / services / plugins 与各实例的运行配置），
 * 不接触任何外部 I/O。宿主需要的环境能力经 `AppOptions` 注入。
 */
export class App {
  /** 激活装配。根激活（host.root）是宿主绑定（{@link bind}）与核心服务的归属，不对外：宿主经 bind 取能力 */
  readonly #host: ActivationHost;
  /** 插件管理面（契约类型）；停机编排用的内部方法经 #plugins */
  readonly plugins: PluginManagerService;
  readonly #plugins: PluginManager;
  readonly logger: Logger;
  /** 屏障事件（app:*）由 App 自己发；原语注册表不外露，插件与宿主都经描述符取用 */
  readonly #events: EventBus;

  readonly #restartStrategy?: RestartStrategy;
  /** 启动单飞：重入返回同一 Promise */
  #starting?: Promise<void>;
  /** 已受理过重启：再调 restart() 静默返回 */
  #restartAccepted = false;
  /** 停机单飞：重入返回同一 Promise；完成后仍保留，再调 stop() 立即落定 */
  #stopping?: Promise<void>;

  constructor(options: AppOptions) {
    this.logger = quietLogger(
      options.logger ??
        new DefaultLogger('aalis', options.logLevel ?? 'info', options.logHub ?? LogHub.default, options.now),
    );
    this.#restartStrategy = options.restartStrategy;
    // 定时器的最大延迟是 2³¹−1ms，更大的值（含 Infinity）会被运行时当成 1ms
    const cap = (ms: number): number => Math.min(ms, 2 ** 31 - 1);
    const disposeTimeoutMs = cap(options.disposeTimeoutMs ?? 5000);
    const slowMs = cap(options.slowThresholdMs ?? 60_000);
    this.#events = new EventBus({
      // 'app:ready' / 'app:started' 只在 start() 发一次，但热重载 bounce 出来的新实例在 apply 里登记的监听器也要拿到，
      // 否则 adapter、CLI 终端界面等「启动后才建立」的逻辑在 bounce 后不再执行
      sticky: ['app:ready', 'app:started'],
      onHandlerError: (event, err, contextId) => {
        this.logger.warn(`事件 "${event}" 的监听器抛错（已隔离${contextId ? `，来自 ${contextId}` : ''}）:`, err);
      },
      // 屏障（app:*，与 types/events.ts 的分节同一判据）的单个监听器至多等 slowMs
      handlerLimit: event => (event.startsWith('app:') ? slowMs : undefined),
      onHandlerSlow: (event, limit, contextId) => {
        this.logger.warn(`事件 "${event}" 的监听器超过 ${limit}ms 未返回（来自 ${contextId}），不再等待，继续后续步骤`);
      },
    });
    const container = new ServiceContainer();

    // 1. 根激活
    const runtime = {
      events: this.#events,
      services: container,
      devMode: options.devMode ?? true,
      notify: notify({ events: this.#events }, this.logger),
    };
    this.#host = new ActivationHost(runtime, this.logger);
    const caps = this.#host.bind(this.#host.root, { provide });

    // 2. 插件管理器
    this.#plugins = new PluginManager(this.#host, this.logger, disposeTimeoutMs, slowMs);
    this.plugins = this.#plugins;

    // 3. 宿主服务：与内置六项同一登记规则（根激活、独占），只交出契约列出的方法
    caps.provide.use(appService, narrow(this, ['stop', 'restart']), { exclusive: true });
    caps.provide.use(
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

    // 版本由宿主注入（core 不自读 package.json）；未注入时省略版本段。
    const versionSeg = options.version ? ` Core ${options.version}` : ' Core';
    this.logger.info(`Aalis${versionSeg} - ${options.name ?? 'Aalis'}`);
  }

  /**
   * 宿主取根激活绑定的服务接口：与插件同一套描述符与装配，登记归属根激活、随 App 停止撤回。
   * 插件拿的是自己激活的绑定，不复用这里的。
   */
  bind<U extends Uses>(uses: U): BoundOf<U> {
    return this.#host.bind(this.#host.root, uses);
  }

  /**
   * 注册插件
   *
   * **resolve 语义 = 注册落账 + 尽力即时激活**：完全静置时激活在返回前同步收敛；
   * 有在飞 recompute（反应式级联/另一插件正在激活）**或挂起段在途**
   * （unload/disable/bounce 的拆卸窗口）时，本次请求排队并入其收尾，
   * resolve 时激活可能尚未发生（排队不丢失——单飞排队见 recompute）。需要
   * 「激活已落定」的确定时机，调用后 `await app.plugins.idle()`（不得在插件
   * apply/onDispose 内这样做——自等死锁，见 idle）。激活超过 `slowThresholdMs` 仍未完成的
   * 插件转入后台（`activating`、`slow: true`），本方法与 idle 在阈值处返回，它落定后另触发一次重算。
   *
   * @param definition 插件定义（definePlugin 的产物）
   * @param config     实例配置，原样生效：core 不合并默认值，也不读配置文档（那是宿主的事）
   * @param instanceId 实例 ID（多实例时为 `name:suffix`，留空则使用 definition.name）
   * @param options.disabled 以禁用态登记（宿主按配置文档的禁用名单传入）
   * @returns 同 `plugins.register`：false = 重名或未声明 reusable 的多实例，已记 warn
   */
  plugin(
    definition: PluginDefinition,
    config?: Record<string, unknown>,
    instanceId?: string,
    options?: { disabled?: boolean },
  ): Promise<boolean> {
    return this.#plugins.register(definition, config, instanceId, options);
  }

  /**
   * 批量注册：全部落账后只重算一次。依赖方因此在同一次重算里按拓扑序排在它 required 服务的
   * 全部提供者之后激活，不会先挂到先登记的后备提供者上——宿主冷启动与热扫描都走这里。
   * 条目各字段同 {@link plugin} 的参数；resolve 语义同 {@link plugin}，返回值与 items 逐项对应。
   */
  pluginAll(items: ReadonlyArray<PluginRegistration>): Promise<boolean[]> {
    return this.#plugins.registerAll(items);
  }

  /**
   * 启动应用：依次发 `app:ready`、`app:started`。单飞：重入返回同一 Promise。停机开始后（含停机完成后）调用记 warn
   * 后直接返回；启动途中停机开始，进行中的 start 照常落定，不再发后续事件。
   *
   * 配置外部变更的热重载编排（diff + bounce）属宿主政策，由宿主自行接管。
   */
  start(): Promise<void> {
    if (this.#stopping) {
      this.logger.warn('应用已开始停机，忽略 start()');
      return Promise.resolve();
    }
    this.#starting ??= this.#runStart();
    return this.#starting;
  }

  async #runStart(): Promise<void> {
    this.logger.info('正在启动...');
    // 注：消息路由由网关插件承担，不在 core。
    await this.#events.emit('app:ready');
    if (this.#stopping) return;
    this.logger.info('启动完成');
    await this.#events.emit('app:started');
  }

  /**
   * 重启应用——委托给 `restartStrategy`。
   *
   * core 只负责发出 `app:restarting` 事件并把 `stop` 回调交给策略；
   * **任何"等响应返回"的延迟、stop 与 restart 的顺序都由策略决定**。
   *
   * 只受理一次：已受理过的再调静默返回（策略交出的 stop 已开始也是）；未受理过而停机已开始时抛错。
   * 未注入策略时抛错（明确暴露"嵌入式宿主没声明重启能力"的事实）。
   */
  restart(opts?: { rollback?: unknown }): void {
    if (!this.#restartStrategy) {
      throw new Error('App.restart() 不可用：未注入 restartStrategy。');
    }
    if (this.#restartAccepted) return;
    if (this.#stopping) throw new Error('App.restart() 不可用：应用已开始停机。');
    this.#restartAccepted = true;
    const strategy = this.#restartStrategy;
    this.#events
      .emit('app:restarting')
      .then(() => strategy.restart({ stop: () => this.stop(), rollback: opts?.rollback }))
      .catch(err => this.logger.error('restart 失败:', err));
  }

  /**
   * 停止应用。单飞：重入返回同一 Promise。
   *
   * 先 `beginShutdown()` 置 `#shuttingDown`（新 bounce/register 被拒），再 `idle()` 排干在飞者，
   * 然后发 `app:stopping`，最后 stopAll。已静置时 `idle()` 仍让出一轮微任务——必须先冻闸，
   * 否则同轮排队的 bounce 会在置位前过闸、停机后留下 pending 幽灵。
   *
   * 每次调用都返回完整停机的同一 Promise，包括屏障监听器与清理期间的调用。
   * `app:stopping` 监听器与清理回调不得 await 或返回该 Promise，否则会等待自身（监听器至多等到
   * `slowThresholdMs`、清理项至多等到 `disposeTimeoutMs` 后被放弃）。
   * 仍在初始化的插件在 `beginShutdown()` 冻结时即 abort，flight 不再等它；两个上限都非 0 时停机总能结束。
   */
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    // 在调用宿主 logger 前发布完成对象，同步重入也只能加入本次停机。
    this.#stopping = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // 同步启动：不能延后一轮微任务，否则 bounce 可能抢在 beginShutdown 前过闸。
    void this.#runStop().then(resolve, reject);
    return this.#stopping;
  }

  async #runStop(): Promise<void> {
    this.logger.info('正在停止...');
    this.#plugins.beginShutdown();
    await this.#plugins.idle();
    await this.#events.emit('app:stopping');
    // 全部插件激活与根激活进 beginShutdown 冻好的同一张关停计划，这里执行 drain/close，返回时都已关完
    await this.#plugins.stopAll();
    this.logger.info('已停止');
  }
}
