import type { ConfigManager } from './config.js';
import type { ContributionHandle, ContributionRegistry, ContributionSpec } from './contributions.js';
import type { EventBus } from './events.js';
import type { HookRegistry } from './hooks.js';
import { Lifecycle } from './lifecycle.js';
import type { Logger } from './logger.js';
import type { ServiceContainer } from './services.js';
import { emitServiceRegistered, validateProvide } from './services-helpers.js';
import type {
  AalisEvents,
  ContributionPointMap,
  HookContextMap,
  MiddlewareFn,
  ServiceOf,
  ServiceTypeMap,
} from './types/index.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/**
 * 上下文 (Context)
 *
 * 每个插件获得一个子 Context。所有通过子 Context 注册的副作用
 * (事件监听、服务注册、工具注册) 在 dispose 时自动清理。
 *
 * 采用 fork / inject / provide / middleware 等术语，
 * 但 Aalis 在此之上引入若干差异化机制：
 * - **多提供者**：`getService` / `getAllServices` 支持同名多实现并存（偏好 > 优先级 > 注册顺序）
 * - **`whenService(name, cb)`**：服务就绪即触发的延迟订阅，回调可返回 cleanup
 *   纳入 dispose 链
 */
export class Context {
  readonly id: string;
  readonly logger: Logger;
  readonly config: ConfigManager;
  /**
   * 开发模式开关——由 App 注入，子 Context 通过 fork 继承。
   *
   * - `true`（默认）：`provide` 时跑注册校验（entryId 前缀 / 重复 provide，见
   *   validateProvide），激活后做 provides 反向一致性 warn
   * - `false`（生产）：跳过上述校验
   *
   * core 不读 `process.env`——是否 dev 由宿主决定。
   */
  readonly devMode: boolean;

  private _events: EventBus;
  private _services: ServiceContainer;
  /** 完整钩子注册表——仅 Context 内部（middleware / runHook / dispose / fork）使用。 */
  private readonly _hooks: HookRegistry;
  /** 完整贡献点注册表——仅 Context 内部（contribute / collect / dispose / fork）使用。 */
  private readonly _contributions: ContributionRegistry;
  /**
   * 本 ctx 已登记的贡献退订函数（键 = point + '\u0000' + 局部 id，与
   * contribute 内 mapKey 的构造保持一致；NUL 不会出现在合法键名中）。
   *
   * 用于同键重注册时先摘旧登记：注册表本身是替换语义，但门面每次 contribute
   * 都会往清理链压一个闭包——不摘旧的，反复刷新贡献（文档明示的合法
   * 用法）会让 dispose 链无界增长且旧 build 闭包无法 GC。
   * 条目数有界于**当前存活**的贡献数：退订时由 off 的自移除逻辑摘掉本条。
   */
  private readonly _contributionDisposers = new Map<string, () => void>();
  /** 贡献登记表 mapKey 分隔符：NUL 是唯一保证不出现在 point 名与贡献 id 里的字符（id 只禁 '/'，空格等均合法）。 */
  private static readonly CONTRIB_KEY_SEP = '\u0000';
  /** 活跃沙盒子上下文 id（useModule）——用于同名重复挂载时唯一化 childId。 */
  private readonly _moduleIds = new Set<string>();
  /**
   * 清理归属：本 Context 本次激活的身份，每次 fork 新鲜。四原语注册时带上它，拆卸按它清。
   * 与 `id`（逻辑身份：贡献键、排序、模型引用、偏好、显示）分开——同名 Context 互不误清，
   * 拆卸在飞时同名新激活的注册也不会被迟到的清理误删。
   */
  private readonly _owner: symbol;
  /**
   * 资源寿命交给内部 Lifecycle；四原语的注册与撤回政策留在 Context。
   * 关闭后订阅类入口 warn + no-op，fork/useModule 抛错；onDispose 始终接收清理。
   */
  private readonly _lifecycle: Lifecycle;

  constructor(options: {
    id: string;
    events: EventBus;
    services: ServiceContainer;
    hooks: HookRegistry;
    contributions: ContributionRegistry;
    logger: Logger;
    config: ConfigManager;
    parent?: Context;
    devMode?: boolean;
  }) {
    this.id = options.id;
    this._owner = Symbol(this.id);
    this._events = options.events;
    this._services = options.services;
    this._hooks = options.hooks;
    this._contributions = options.contributions;
    this.logger = options.logger;
    this.config = options.config;
    this.devMode = options.devMode ?? options.parent?.devMode ?? true;
    let removedServices: string[] = [];
    this._lifecycle = new Lifecycle(
      {
        beforeCleanup: () => {
          // 先撤回对外注册，再执行用户清理，避免清理期间继续接收新调用。
          removedServices = this._services.unregisterByOwner(this._owner);
          this._hooks.unregisterByOwner(this._owner);
          this._contributions.unregisterByOwner(this._owner);
          this._events.unregisterByOwner(this._owner);
        },
        afterCleanup: () => {
          for (const svc of removedServices) {
            this._events.emit('service:unregistered', svc).catch(err => {
              this.logger.warn(`emit service:unregistered 失败 (${svc}): ${err}`);
            });
          }
          removedServices = [];
          this._contributionDisposers.clear();
          this._moduleIds.clear();

          // 枢纽服务的旧清扫协议属于 Core，不下沉资源生命周期层。
          // 同名多 entry 按实例去重，未被选中的提供者也可能持有登记。
          for (const name of this._services.getServiceNames()) {
            const seen = new Set<unknown>();
            for (const entry of this._services.getEntries(name)) {
              if (seen.has(entry.instance)) continue;
              seen.add(entry.instance);
              const svc = entry.instance as { unregisterByPlugin?: (id: string) => void };
              try {
                svc?.unregisterByPlugin?.(this.id);
              } catch (err) {
                this.logger.warn(`服务 "${name}" 的 unregisterByPlugin 抛错:`, err);
              }
            }
          }
        },
        onTimeout: (phase, timeoutMs) => {
          if (phase === 'initialization') {
            this.logger.warn(
              `Context "${this.id}": 等待初始化落定超过 ${timeoutMs}ms，放弃等待并继续拆卸` +
                `（该插件 apply 中在飞的资源获取，其 onDispose 可能赶不上本次清理链）`,
            );
          } else {
            this.logger.warn(`Context "${this.id}": 等待在飞拆卸超过 ${timeoutMs}ms，放弃等待`);
          }
        },
        onError: err => this.logger.error('dispose 收尾异常:', err),
      },
      this.logger,
    );
  }

  // ---- 子系统访问（供高级插件检查/包装用） ----

  /**
   * 底层服务容器实例。
   *
   * ⚠️ **@internal** —— 仅供 host 级巡视代码（如 plugin-activation 检查 provides
   * 完整性）使用。
   *
   * **插件请勿直接使用**：
   * - 枚举某服务的所有 entry（含 contextId / priority / label）：
   *   → 用公开 API `ctx.getAllServices(name)`
   * - 获取服务实例：用 `ctx.getService()` / `ctx.getAllServices()`
   * - 注册服务：用 `ctx.provide()`（会自动登记到清理链、带上清理归属）；直接 `register`
   *   的条目无 owner，不被拆卸自动清理，得用返回值自管
   */
  get serviceContainer(): ServiceContainer {
    return this._services;
  }

  /**
   * 创建子上下文（通常为每个插件创建一个）
   */
  fork(id: string): Context {
    if (this._lifecycle.disposed) {
      throw new Error(`Context "${this.id}" 已 dispose，无法 fork("${id}")`);
    }
    const child = new Context({
      id,
      events: this._events,
      services: this._services,
      hooks: this._hooks,
      contributions: this._contributions,
      logger: this.logger.child(id),
      config: this.config,
      parent: this,
      devMode: this.devMode,
    });
    this._lifecycle.adopt(child._lifecycle);
    return child;
  }

  // ---- 事件 ----

  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void {
    if (this._lifecycle.disposed) {
      this.logger.warn(`Context "${this.id}" 已 dispose，忽略 on("${event}")`);
      return () => {};
    }
    const off = this._events.on(event, handler, this._owner);
    return this.trackDisposable(off, `on:${event}`);
  }

  /**
   * 把一个底层退订原语登记到 disposable 链，并返回**自移除**的退订函数：
   * 调用方手动退订时，闭包不再滞留清理链（否则它持有 handler 引用直到
   * ctx.dispose 才释放——故所有注册 API 的退订都统一走此路径，杜绝该类泄漏）。
   *
   * label 进入链条目：泄漏排查与超时/抛错告警按它点名（`前缀:名字` 约定）。
   */
  private trackDisposable(off: () => void, label?: string): () => void {
    const dispose = (): void => {
      this._lifecycle.disposables.remove(dispose);
      off();
    };
    this._lifecycle.disposables.push(dispose, label);
    return dispose;
  }

  emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void> {
    return this._events.emit(event, ...args);
  }

  // ---- 服务 (IoC) ----

  /**
   * 注册服务，返回 dispose 函数用于精确卸载该服务
   *
   * 已知服务名（ServiceTypeMap 里有的）按契约类型约束实现，错误实现在编译期被拒；
   * 未知名与动态字符串放行为 unknown。单签名条件类型而非重载：string 兜底重载会让
   * 已知名的错误实现落到宽签名照样通过（已实测）。
   *
   * `entryId` 选项：覆盖默认 contextId（默认 = `this.id`）。用于一个 plugin 实例
   * 需要按某种语义子粒度拆出多个 entry 的场景（典型：per-model LLM、per-path storage）。
   * 约定：`entryId` 必须以 `this.id` 为前缀（以 `/` 分隔）——它是逻辑身份，`hasByContext`
   * 的前缀查询与 api-llm 按 `provider/model` 解析引用都靠它；清理不依赖它（按 owner 走），
   * dev 模式下验证只为避免 "entryId 与拥有者 plugin 脱联" 的 footgun。
   */
  provide<K extends string>(
    name: K,
    instance: ServiceOf<K>,
    options?: { priority?: number; label?: string; entryId?: string },
  ): () => void {
    if (this._lifecycle.disposed) {
      this.logger.warn(`Context "${this.id}" 已 dispose，忽略 provide("${name}")`);
      return () => {};
    }
    const entryId = options?.entryId ?? this.id;

    if (this.devMode) {
      validateProvide({
        ctxId: this.id,
        name,
        entryId,
        explicitEntryId: options?.entryId !== undefined,
        services: this._services,
        logger: this.logger,
      });
    }

    const entry = this._services.register(name, instance, options?.priority ?? 0, entryId, options?.label, this._owner);

    const dispose = () => {
      // 自移除：调用方手动 dispose 后，闭包不再滞留清理链（否则它持有
      // entry 引用，instance 无法 GC，多实例热替换场景累积僵尸）。
      // ctx.dispose 经 DisposableChain.dispose 调用本函数时 remove 返回 false，无害。
      this._lifecycle.disposables.remove(dispose);
      const removed = this._services.unregisterEntry(name, entry);
      if (removed) {
        this._events.emit('service:unregistered', name).catch(err => {
          this.logger.warn(`emit service:unregistered 失败 (${name}): ${err}`);
        });
      }
    };
    // 显式 entryId（一 plugin 多 entry，如 LLM 多模型）时用它点名，否则服务名已够定位
    this._lifecycle.disposables.push(dispose, `provide:${options?.entryId ?? name}`);

    emitServiceRegistered(this._events, this.logger, name);
    this.logger.debug(`服务已注册: ${name}`);

    return dispose;
  }

  /**
   * 按名字拿服务当前最佳提供者（偏好 > 优先级 > 注册顺序）。
   *
   * 返回的是**当时点的裸实例**，调用后 provider 发生换跳不会跟随。
   * 需要跟随切换的场景请听 `service:registered` / `service:unregistered`
   * 事件重新拉取；常规场景推荐在函数作用域内即取即用，不要长期存入类字段。
   *
   * 重载行为：
   * - 传入字面量服务名（如 `'memory'`）→ 命中 `ServiceTypeMap` 自动推断为 `MemoryService | undefined`；
   * - 传入字符串变量或未登记服务名 → 退回 `<T = unknown>`，调用方需自行 narrow，
   *   仍可显式传 `<T>` 兼容旧写法。
   */
  getService<TName extends keyof ServiceTypeMap>(name: TName): ServiceTypeMap[TName] | undefined;
  getService<T = unknown>(name: string): T | undefined;
  getService<T>(name: string): T | undefined {
    return this._services.get<T>(name);
  }

  /**
   * 列出所有已注册的服务名
   */
  getServiceNames(): string[] {
    return this._services.getServiceNames();
  }

  /**
   * 获取某个服务的所有实例（带提供者信息与优先级），按「偏好 > 优先级 > 注册顺序」排序。
   *
   * 业务消费（遍历所有 provider）与管控展示（WebUI / CLI 枚举视图）共用此一个读口。
   *
   * @example
   * const allLLMs = ctx.getAllServices('llm');
   */
  getAllServices<TName extends keyof ServiceTypeMap>(
    name: TName,
  ): Array<{ instance: ServiceTypeMap[TName]; contextId: string; priority: number; label?: string }>;
  getAllServices<T = unknown>(
    name: string,
  ): Array<{ instance: T; contextId: string; priority: number; label?: string }>;
  getAllServices<T>(name: string): Array<{ instance: T; contextId: string; priority: number; label?: string }> {
    return this._services.getAll<T>(name);
  }

  /**
   * 设置某服务的偏好 provider（按 contextId）
   *
   * 语义：「偏好 > 优先级 > 注册顺序」。偏好者总是 `getService(name)` 的第一返回值，
   * 即使其 priority 数值低于其它 entry。
   *
   * 注：偏好可以提前于 entry 注册前设置——一旦目标 contextId 注册即刻生效。
   * @returns 始终返回 true（偏好已记录）
   */
  preferService(name: string, contextId: string): boolean {
    const ok = this._services.prefer(name, contextId);
    if (ok) {
      this.logger.debug(`服务偏好已设置: ${name} -> ${contextId}`);
      this._events.emit('service:preference-changed', name).catch(err => {
        this.logger.warn(`emit service:preference-changed 失败 (${name}): ${err}`);
      });
    }
    return ok;
  }

  /**
   * 清除某服务的偏好（恢复 priority + 注册顺序解析）
   */
  unpreferService(name: string): boolean {
    const ok = this._services.unprefer(name);
    if (ok) {
      this.logger.debug(`服务偏好已清除: ${name}`);
      this._events.emit('service:preference-changed', name).catch(err => {
        this.logger.warn(`emit service:preference-changed 失败 (${name}): ${err}`);
      });
    }
    return ok;
  }

  /**
   * 读取某服务当前的偏好 contextId（无偏好返回 undefined）
   */
  getPreferredService(name: string): string | undefined {
    return this._services.getPreferred(name);
  }

  /**
   * 持续订阅一个服务：每当 provider 上线就调一次 `cb(svc)`，下线则自动执行
   * 上一次 cb 返回的 cleanup。
   *
   * 适用场景：把"向某个 hub 服务注册副作用"封装成一行；当 hub 服务被 bounce
   * 或换提供者时，下游注册会自动重挂——无需作者自己监听 service:registered。
   *
   * 语义细则：
   * - 调用时若服务已就绪，立即触发首次 `cb`。
   * - provider 重新 provide（unregister → register）会先调上次 cleanup、
   *   再用新 svc 调一次 cb；保证不持有失效引用。
   * - `cb` 可返回 cleanup 函数；返回的 dispose 与 `ctx.dispose()` 都会调它。
   * - 返回的 dispose 函数 idempotent，可手动调（多次安全）。
   * - 同名 provider 仅取 `getService(name)` 的胜者，多 entry 并存场景按容器优先级。
   *   **胜者不变则不动**：败者 entry 上下线不会触发重挂；胜者换人（含
   *   `preferService` 偏好切换、胜者注销后由次优顶上）才 cleanup + 重挂。
   *
   * @example 注册到 hub 服务：
   * ctx.whenService('tools', svc => svc.register(myTool, ctx.id));
   *
   * @example 监听 provider 切换：
   * ctx.whenService('llm', llm => {
   *   const handle = llm.onModelChange(updateUI);
   *   return () => handle.dispose();
   * });
   */
  whenService<TName extends keyof ServiceTypeMap>(
    name: TName,
    // biome-ignore lint/suspicious/noConfusingVoidType: cb 可隐式返回 void 或显式返回 cleanup
    cb: (svc: ServiceTypeMap[TName]) => void | (() => void),
  ): () => void;
  // biome-ignore lint/suspicious/noConfusingVoidType: cb 可隐式返回 void 或显式返回 cleanup
  whenService<T = unknown>(name: string, cb: (svc: T) => void | (() => void)): () => void;
  // biome-ignore lint/suspicious/noConfusingVoidType: cb 可隐式返回 void 或显式返回 cleanup
  whenService<T>(name: string, cb: (svc: T) => void | (() => void)): () => void {
    if (this._lifecycle.disposed) {
      this.logger.warn(`Context "${this.id}" 已 dispose，忽略 whenService("${name}")`);
      return () => {};
    }
    let cleanup: (() => void) | undefined;
    let disposed = false;
    let syncing = false;
    /** 当前已挂载的胜者实例；undefined = 未挂载 */
    let attached: T | undefined;

    const runCleanup = (): void => {
      const previous = cleanup;
      cleanup = undefined;
      if (!previous) return;
      try {
        previous();
      } catch (err) {
        this.logger.warn(`whenService('${name}') cleanup 抛错（已忽略）:`, err);
      }
    };

    /**
     * 对齐到容器当前胜者（核心不变量：attached === getService(name)）：
     * - 胜者未变（如败者 entry 上下线、同胜者重复事件）→ 不动，避免无谓 bounce
     * - 胜者变了 → 先 cleanup 再用新实例重挂
     * - 没有胜者了 → 只 cleanup 脱挂
     * 重入只改变容器状态，由当前调用串行对齐；先接住 cleanup 再处理下一次切换，
     * 避免 A → B → A 时外层回调覆盖内层清理函数。持续振荡的用户回调不保证收敛。
     */
    const sync = (): void => {
      if (disposed || syncing) return;
      syncing = true;
      try {
        while (!disposed) {
          if (this._services.get<T>(name) === attached) return;
          attached = undefined;
          runCleanup();
          if (disposed) return;
          // cleanup 自身也可能切换偏好、注销 provider；不能复用清理前的胜者。
          const winner = this._services.get<T>(name);
          attached = winner;
          if (winner === undefined) return;
          try {
            const ret = cb(winner);
            if (typeof ret === 'function') cleanup = ret;
          } catch (err) {
            // 首挂和重挂采用同一错误政策；同一胜者不自动重试。
            this.logger.warn(`whenService('${name}') 回调抛错（订阅保持，等下次服务变更）:`, err);
          }
          // 回调中已退订时，刚返回的 cleanup 仍需立即执行。
          if (disposed) runCleanup();
        }
      } finally {
        syncing = false;
      }
    };

    // 持续订阅 provider 上下线 + 偏好切换（不退订），ctx.dispose 时由 disposable 链清理。
    const offReg = this.on('service:registered', (svcName: string) => {
      if (svcName === name) sync();
    });
    const offUnreg = this.on('service:unregistered', (svcName: string) => {
      if (svcName === name) sync();
    });
    const offPref = this.on('service:preference-changed', (svcName: string) => {
      if (svcName === name) sync();
    });

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      this._lifecycle.disposables.remove(dispose); // 自移除，不滞留闭包（对称 provide）
      offReg();
      offUnreg();
      offPref();
      runCleanup();
      attached = undefined;
    };

    this._lifecycle.disposables.push(dispose, `whenService:${name}`);
    // 首挂前先登记：回调销毁 ctx 时，复合订阅已能随清理链一起退订。
    sync();
    return dispose;
  }

  // ---- 中间件/钩子 ----

  /**
   * 注册命名生命周期事件 handler（中间件管道）
   *
   * 同一钩子键内的多个 handler 按 **注册顺序** 执行洋葱模型 (next 语义)，
   * 不再使用数字优先级。相位间的次序由调度方（如 plugin-gateway 的入站
   * 多相位调度）显式表达。
   *
   * @example
   * // 在消息发送给 LLM 前添加额外指令
   * ctx.middleware('agent:llm:before', async (data, next) => {
   *   data.messages.unshift({ role: 'system', content: '额外指令...' });
   *   await next();
   * });
   *
   * // 命令命中后中断后续处理
   * ctx.middleware('inbound:command', async (data, next) => {
   *   if (handled(data.message)) return; // 不调用 next = 中断
   *   await next();
   * });
   */
  middleware<K extends string & keyof HookContextMap>(hook: K, fn: MiddlewareFn<HookContextMap[K]>): () => void {
    if (this._lifecycle.disposed) {
      this.logger.warn(`Context "${this.id}" 已 dispose，忽略 middleware("${hook}")`);
      return () => {};
    }
    return this.trackDisposable(this._hooks.register(hook, fn, this.id, this._owner), `middleware:${hook}`);
  }

  /**
   * 执行钩子链（语义见 {@link HookRegistry.run}）。
   *
   * 任何插件都可驱动自己定义的钩子链——对称钩子系统的立身之本，地位等价于
   * `ctx.emit`。注册 handler 请用 `ctx.middleware(hook, fn)`。完整 HookRegistry
   * （register / unregisterByOwner / onStall）不对插件暴露，与 `_events` /
   * `_services` 同一门面纪律。
   *
   * @returns `true` = 链路完整走完（执行了 defaultAction，或本就没有 handler）；
   *          `false` = 被某个 handler swallow（不调 next 中断）
   */
  runHook<K extends string & keyof HookContextMap>(
    hook: K,
    data: HookContextMap[K],
    defaultAction?: () => Promise<void>,
    opts?: { warnOnStall?: boolean },
  ): Promise<boolean> {
    return this._hooks.run(hook, data, defaultAction, opts);
  }

  // ---- 贡献点 ----

  /**
   * 向贡献点交付一份 spec，返回 dispose 函数（并挂 dispose 链，卸载自动清扫）。
   *
   * spec.id 是**局部名**，注册时自动冠 `${ctx.id}/` 前缀成全局键——同一 ctx 内
   * 同 id 重复注册为替换（幂等）；spec.id 侧无法顶替他人贡献（信任边界的
   * 如实声明见 {@link ContributionSpec}）。贡献者不掌握任何控制流：无排序
   * 影响力（顺序是全局键的纯函数）、无短路、不可见其他贡献——排布与执行
   * 策略全归贡献点 owner（{@link collect} 的调用方）。
   *
   * 贡献点的键与 spec 类型由各 -api 包 declaration merging 扩展
   * ContributionPointMap 定义。
   */
  contribute<K extends string & keyof ContributionPointMap>(
    point: K,
    spec: ContributionPointMap[K] & ContributionSpec,
  ): () => void {
    // 窄化取 id：core 内 ContributionPointMap 是空接口，`ContributionPointMap[K]`
    // 索引不出成员，但交叉的 ContributionSpec 保证 id 存在。
    // 已 dispose 的 ctx 不得再注册：注册表是键控替换语义，死 ctx 写进去会顶掉
    // 同 id 活实例（如 bounce 后的新实例）的条目，随即又被立即执行的 disposer
    // 连带删除——活实例的贡献静默消失。与 useModule 同为拒绝，但取 warn+no-op
    // 而非抛错：调用方常是插件的异步续段，不该在清理路径上再抛。
    if (this._lifecycle.disposed) {
      this.logger.warn(`Context "${this.id}" 已 dispose，忽略 contribute("${point}")`);
      return () => {};
    }
    const mapKey = `${point}${Context.CONTRIB_KEY_SEP}${(spec as ContributionSpec).id}`;
    // 同键重注册 = 替换：先撤旧登记（自移除出 dispose 链 + 撤注册表旧条目），
    // 再写新的——先删后写，避免旧闭包滞留（见 _contributionDisposers）。
    this._contributionDisposers.get(mapKey)?.();
    const rawOff = this.trackDisposable(
      this._contributions.register(point, spec, this.id, this._owner),
      `contribute:${point}:${(spec as ContributionSpec).id}`,
    );
    // 包一层做自移除：不删登记表条目的话，`Map → dispose 闭包 → off 闭包 →
    // entry → spec（及其 build 捕获的数据）` 这条持有链会让退订过的贡献一直
    // 活到 ctx.dispose（动态 id 场景下无界增长）。恒等卫防误删同键新注册。
    const off = (): void => {
      if (this._contributionDisposers.get(mapKey) === off) this._contributionDisposers.delete(mapKey);
      rawOff();
    };
    this._contributionDisposers.set(mapKey, off);
    return off;
  }

  /**
   * 枚举某贡献点的全部条目（语义见 {@link ContributionRegistry.collect}）。
   *
   * 驱动公开——任何插件都可拥有并收集自己定义的贡献点，地位等价于
   * `ctx.emit` / `ctx.runHook`。返回数组快照，每项是 `{ key, spec }`：
   * `key` 是全局键（含贡献方 ctx.id 前缀）供归属标注与统计，`spec` 是注册
   * 方交付的本体（引用，`spec.id` 仍是其局部名）。如何执行 spec（并行 /
   * 隔离 / 超时）是收集方的策略，内核不执行任何插件代码。
   */
  collect<K extends string & keyof ContributionPointMap>(
    point: K,
  ): ReadonlyArray<ContributionHandle<ContributionPointMap[K] & ContributionSpec>> {
    return this._contributions.collect(point) as ReadonlyArray<
      ContributionHandle<ContributionPointMap[K] & ContributionSpec>
    >;
  }

  // ---- 生命周期 ----

  get disposed(): boolean {
    return this._lifecycle.disposed;
  }

  /**
   * 在当前 Context 内动态加载一个插件 module 作为"沙盒插件"。
   *
   * 与 `App.plugin(...)` / `PluginManager.register(...)` 的区别：
   * - 不进入全局 `PluginManager`（不参与依赖追踪、softReload）
   * - fork 一个子上下文，调用 `module.apply(child, config)`
   * - 返回 dispose：调用即销毁该子上下文，对应子上下文里所有副作用一并清理
   * - 父 ctx dispose 时也会级联销毁
   *
   * 典型场景：
   * - 会话级动态工具/中间件
   * - 单元测试里组装最小可运行单元
   *
   * @param module 任意符合 `{ name, apply(ctx, config) }` 的对象
   * @param config 传给 apply 的配置（默认 `{}`）
   * @returns dispose 函数；返回的 Promise 在 apply 完成后 resolve
   *
   * @example
   * const off = await ctx.useModule({
   *   name: 'temp-mw',
   *   apply(c) {
   *     c.middleware('agent:input:before', async (data, next) => {
   *       data.message.content += ' [临时标记]';
   *       await next();
   *     });
   *   }
   * });
   * // ...
   * off(); // 卸载临时中间件
   */
  async useModule(
    module: {
      name: string;
      apply(ctx: Context, config: Record<string, unknown>): void | Promise<void>;
    },
    config: Record<string, unknown> = {},
  ): Promise<() => void> {
    if (this._lifecycle.disposed) {
      throw new Error(`Context "${this.id}" 已 dispose，无法 useModule`);
    }
    // 同一父 ctx 重复挂载同名 module（文档背书的"每会话一实例"用法）必须拿到
    // 互不相同的 ctx.id：id 是 contributions 全局键的前半，重复 id 会让后挂载者静默顶替
    // 先挂载者的贡献。活跃集合随 dispose 收缩，长期反复挂载不会无界增长。
    const baseId = `${this.id}#${module.name}`;
    let childId = baseId;
    for (let n = 2; this._moduleIds.has(childId); n++) childId = `${baseId}~${n}`;
    this._moduleIds.add(childId);

    const child = this.fork(childId);
    try {
      // 登记后再 await，让父 ctx 级联拆卸时能先等子 ctx 初始化落定（见 {@link trackActivation}）
      const applying = Promise.resolve(module.apply(child, config));
      child.trackActivation(applying);
      await applying;
    } catch (err) {
      this._moduleIds.delete(childId);
      child.dispose();
      throw err;
    }
    return () => {
      this._moduleIds.delete(childId);
      child.dispose();
    };
  }

  /**
   * 注册一个在本 Context dispose 时执行的清理回调。
   *
   * 插件清理副作用的**唯一正确 API**：
   * - 登记到生命周期的清理链，保证逆序执行
   * - 在 `ctx.dispose()` 的任何路径上都会触发（app 停机 / bounce / unload /
   *   updatePluginConfig / softReload 级联 evict）
   * - 沙盒 / fork 子上下文同样适用
   *
   * ⚠． 不要用 `ctx.on('app:stopping', ...)` 做资源清理——那只在 app 全局停机
   *    时触发一次，**不会**在插件 bounce / hot reload 时触发，会造成旧连接、
   *    旧定时器泄漏。全局停机不需要特别处理——`onDispose` 也会被触发。
   *
   * @example
   * const conn = await connectExternal();
   * ctx.onDispose(() => conn.close());
   *
   * @param label 可选来源标注，仅用于诊断日志——清理超时/抛错时点名是哪一项。
   * @returns 取消该清理回调的函数（在 dispose 前调用可阻止执行）
   */
  onDispose(fn: () => void | Promise<void>, label?: string): () => void {
    if (this._lifecycle.disposed) {
      // 判据必须用链的 disposed，不是生命周期的 disposed——后者在清理**开始前**就置位，
      // 中间隔着等 activation / 级联子 ctx 两段窗口；落在窗口里的迟到 disposer 仍进链、
      // 被本次清理正常等待，只有链已排空才真是就地执行。
      if (this._lifecycle.disposables.disposed) {
        this.logger.warn(
          `Context "${this.id}" 已 dispose，onDispose${label ? `("${label}")` : ''} 将就地执行（异步返回值不被等待）`,
        );
      } else {
        this.logger.debug(`Context "${this.id}" 拆卸进行中，onDispose${label ? `("${label}")` : ''} 纳入本次清理链`);
      }
    }
    // 错误兜底（同步抛出 / 异步拒绝 / 超时）全部由清理链负责，这里不套守卫：
    // 内核必须自足才能脱离 Context 使用，Context 再包一层就是跨层重复守卫。
    // 异步返回值原样交还给链，disposeAsync 路径会等待它。
    // 薄闭包只为给**本次登记**一个独立身份：链按引用首匹配移除，同一函数登记两次时直接
    // remove(fn) 会撤销错项、翻转余下条目的逆序（与其它门面经 trackDisposable 各自独立闭包对齐）。
    const entry = () => fn();
    this._lifecycle.disposables.push(entry, label);
    return () => this._lifecycle.disposables.remove(entry);
  }

  /** @internal 当前 disposable 链长度（诊断 / 测试用：检测 provide/whenService 的闭包是否如期自移除）。 */
  get disposableCount(): number {
    return this._lifecycle.disposables.size;
  }

  /**
   * @internal 链序标签名单（诊断 / 测试用）：把「卸载后还剩几个」升级为「剩的是谁」。
   * 内核门面注册按 `前缀:名字` 约定自动点名（on:/middleware:/contribute:/provide:/whenService:），
   * onDispose 用作者传的 label；未命名项以 undefined 占位——占位本身是信息
   * （说明有未传 label 的 onDispose，排查时按链序号对照 `[#i]` 告警）。
   */
  listDisposables(): ReadonlyArray<string | undefined> {
    return this._lifecycle.disposables.labels();
  }

  /**
   * @internal 贡献登记表条目名单（诊断 / 测试用）。与 {@link listDisposables} 是
   * 两本独立的账（同 {@link contributionDisposerCount} 的注释）——登记表泄漏
   * 只有这里看得见。key 天然携带贡献点与贡献 id，直接拆给调用方。
   */
  listContributions(): ReadonlyArray<{ point: string; id: string }> {
    return [...this._contributionDisposers.keys()].map(k => {
      const sep = k.indexOf(Context.CONTRIB_KEY_SEP);
      return { point: k.slice(0, sep), id: k.slice(sep + 1) };
    });
  }

  /**
   * @internal 登记本 ctx 的初始化在飞 promise（由内部 Lifecycle 跟踪）。
   *
   * 仅由激活路径（`activatePlugin`）与 `Context.useModule` 调用，传入 `module.apply(...)`
   * 的返回值；插件侧不得调用（非契约面）。
   * 调用方仍要自行 await 该 promise 并处理其失败——本方法只负责让拆卸路径
   * 知道「初始化还没跑完」，不改变激活语义。
   *
   * ⚠． 被登记的 apply **不得** await 任何最终落到本 ctx 或其祖先拆卸上的调用
   *    （`disposeAsync` / `plugins.unload|bouncePlugin|disablePlugin` / `app.stop`
   *    / `plugins.idle`）——拆卸正等着它返回，await 它即自等自。与 `onDispose`
   *    回调的约束同源。`disposeAsync(timeoutMs)` 的超时是这条的兜底而非豁免。
   */
  trackActivation(applying: Promise<unknown>): void {
    this._lifecycle.trackInitialization(applying);
  }

  /**
   * @internal 当前贡献登记表条目数（诊断 / 测试用）。
   *
   * 它与 {@link disposableCount} 是**两条独立的账**：贡献的退订闭包由
   * trackDisposable 自摘出 dispose 链，而登记表条目由 contribute 返回的包装
   * 另行摘除。只看 dispose 链长度看不见登记表泄漏，故单开这个口子。
   */
  get contributionDisposerCount(): number {
    return this._contributionDisposers.size;
  }

  /**
   * 销毁此上下文，清理所有副作用（同步；异步清理不等待）。
   *
   * 需要等待落盘类异步清理完成时用 {@link disposeAsync}——编排层
   * （PluginManager 的 unload / bounce / 停机路径与 App.stop）走的是它。
   */
  dispose(): void {
    this._lifecycle.dispose();
  }

  /**
   * 可等待的销毁：语义与 {@link dispose} 相同，但逆序**串行等待**每个异步
   * 清理（`onDispose` 返回的 promise）完成后才返回——bounce / unload / 停机
   * 路径上落盘类清理从此真正落地，而非只是"开始执行"。
   *
   * 幂等且**可 join**：已有拆卸在飞时等待它完成再返回，而不是看到 `disposed`
   * 就早退（`disposed` 在清理开始前置位，早退会让调用方拿到"已完成"的假象——
   * 父级联撞上半拆的子 ctx、并发 stop、unload 撞 bounce 都会走到这条路）。
   *
   * ⚠． **`onDispose` 回调里不得 await 任何最终落到本 ctx 或其祖先 ctx 拆卸上的
   *    调用**——在飞的拆卸正等着那个回调返回，await 它即自等自。除直接调用本方法
   *    外，还包括 `plugins.unload/disablePlugin/bouncePlugin`（它们内部 await
   *    `entry.context.disposeAsync`）、`app.stop()`、`plugins.idle()`。清理回调
   *    只做自己的收尾，拆卸由编排层驱动。（与 `PluginManagerService.idle()` 同类约束。）
   *
   * @param timeoutMs 单个异步清理项的等待上限；超时放弃该项、继续后续清理
   *        并 warn 点名（防网络类关闭卡死整个停机）。**join 已有在飞拆卸时同样
   *        以本值为上限**——在飞方可能是用更松（甚至不设限）的 timeout 启动的，
   *        无护栏地 join 会让调用方（如 `App.stop`）的停机上限失效。缺省不设限。
   */
  disposeAsync(timeoutMs?: number): Promise<void> {
    return this._lifecycle.disposeAsync(timeoutMs);
  }
}
