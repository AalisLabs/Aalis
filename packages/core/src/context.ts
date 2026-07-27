import type { ConfigManager } from './config.js';
import type { ContributionHandle, ContributionRegistry, ContributionSpec } from './contributions.js';
import { DisposableChain } from './disposable-chain.js';
import type { EventBus } from './events.js';
import type { HookRegistry } from './hooks.js';
import type { Logger } from './logger.js';
import type { ServiceContainer } from './services.js';
import { emitServiceRegistered, validateProvide } from './services-helpers.js';
import type { AalisEvents, ContributionPointMap, HookContextMap, MiddlewareFn, ServiceTypeMap } from './types/index.js';

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
   * - `true`（默认）：`provide` 时按声明的能力跑探测器，暴露"声明与实现不符"
   * - `false`（生产）：跳过探测，节省热路径开销
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
   * 都会往 _disposables 压一个闭包——不摘旧的，反复刷新贡献（文档明示的合法
   * 用法）会让 dispose 链无界增长且旧 build 闭包无法 GC。
   * 条目数有界于**当前存活**的贡献数：退订时由 off 的自移除逻辑摘掉本条。
   */
  private readonly _contributionDisposers = new Map<string, () => void>();
  /** 活跃沙盒子上下文 id（useModule）——用于同名重复挂载时唯一化 childId。 */
  private readonly _moduleIds = new Set<string>();
  private _disposables: DisposableChain;
  private _children: Set<Context> = new Set();
  private _parent?: Context;
  private _disposed = false;
  /**
   * 在飞的拆卸 promise。`_disposed` 在清理**开始前**置位，仅凭它早退会让后来者
   * 拿到"已完成"的假象（并发 disposeAsync、父级联撞上半拆的子 ctx、unload 撞
   * bounce、并发 app.stop 都会 0ms 返回而清理其实没落）。记住它之后，后来者
   * join 而非早退。
   */
  private _inflightTeardown?: Promise<void>;

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
    this._events = options.events;
    this._services = options.services;
    this._hooks = options.hooks;
    this._contributions = options.contributions;
    this.logger = options.logger;
    this.config = options.config;
    this._parent = options.parent;
    this.devMode = options.devMode ?? options.parent?.devMode ?? true;
    this._disposables = new DisposableChain(this.logger);
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
   * - 注册服务：用 `ctx.provide()`（会自动登记到 _disposables 链）
   */
  get serviceContainer(): ServiceContainer {
    return this._services;
  }

  /**
   * 创建子上下文（通常为每个插件创建一个）
   */
  fork(id: string): Context {
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
    this._children.add(child);
    return child;
  }

  // ---- 事件 ----

  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void {
    const off = this._events.on(event, handler);
    return this.trackDisposable(off);
  }

  /**
   * 把一个底层退订原语登记到 disposable 链，并返回**自移除**的退订函数：
   * 调用方手动退订时，闭包不再滞留 _disposables（否则它持有 handler 引用直到
   * ctx.dispose 才释放——故所有注册 API 的退订都统一走此路径，杜绝该类泄漏）。
   */
  private trackDisposable(off: () => void): () => void {
    const dispose = (): void => {
      this._disposables.remove(dispose);
      off();
    };
    this._disposables.push(dispose);
    return dispose;
  }

  emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void> {
    return this._events.emit(event, ...args);
  }

  // ---- 服务 (IoC) ----

  /**
   * 注册服务，返回 dispose 函数用于精确卸载该服务
   *
   * `entryId` 选项：覆盖默认 contextId（默认 = `this.id`）。用于一个 plugin 实例
   * 需要按某种语义子粒度拆出多个 entry 的场景（典型：per-model LLM、per-path storage）。
   * 约定：`entryId` 必须以 `this.id` 为前缀（以 `/` 分隔），以保证 plugin 卸载时
   * `unregisterByContext(this.id)` 如需清理仍可多次调用；dispose 函数并不依赖这个约定，
   * 但 dev 模式下会验证以避免 "entryId 与拥有者 plugin 脱联" 的 footgun。
   */
  provide(
    name: string,
    instance: unknown,
    options?: { priority?: number; label?: string; entryId?: string },
  ): () => void {
    const entryId = options?.entryId ?? this.id;

    if (this.devMode) {
      validateProvide({
        ctxId: this.id,
        name,
        entryId,
        explicitEntryId: options?.entryId !== undefined,
        priority: options?.priority,
        services: this._services,
        logger: this.logger,
      });
    }

    const entry = this._services.register(name, instance, options?.priority ?? 0, entryId, options?.label);

    const dispose = () => {
      // 自移除：调用方手动 dispose 后，闭包不再滞留 _disposables（否则它持有
      // entry 引用，instance 无法 GC，多实例热替换场景累积僵尸）。
      // ctx.dispose 经 DisposableChain.dispose 调用本函数时 remove 返回 false，无害。
      this._disposables.remove(dispose);
      const removed = this._services.unregisterEntry(name, entry);
      if (removed) {
        this._events.emit('service:unregistered', name).catch(err => {
          this.logger.warn(`emit service:unregistered 失败 (${name}): ${err}`);
        });
      }
    };
    this._disposables.push(dispose);

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
   * 即使其 priority 数值低于 router 等其他 entry。
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
    let cleanup: (() => void) | undefined;
    let disposed = false;
    /** 当前已挂载的胜者实例；undefined = 未挂载 */
    let attached: T | undefined;

    const runCleanup = (): void => {
      if (!cleanup) return;
      try {
        cleanup();
      } catch (err) {
        this.logger.warn(`whenService('${name}') cleanup 抛错（已忽略）:`, err);
      }
      cleanup = undefined;
    };

    /**
     * 对齐到容器当前胜者（核心不变量：attached === getService(name)）：
     * - 胜者未变（如败者 entry 上下线、同胜者重复事件）→ 不动，避免无谓 bounce
     * - 胜者变了 → 先 cleanup 再用新实例重挂
     * - 没有胜者了 → 只 cleanup 脱挂
     * 不读事件 payload、只看容器当前态，天然对事件乱序/合并免疫。
     */
    const sync = (): void => {
      if (disposed) return;
      const winner = this._services.get<T>(name);
      if (winner === attached) return;
      runCleanup();
      attached = winner;
      if (winner === undefined) return;
      const ret = cb(winner);
      // cb 执行期间可能同步触发了本 whenService 的 dispose（如 cb 内部链式
      // 卸载）。此时不能把新 cleanup 挂上去——dispose 已跑过 runCleanup 且
      // disposed=true，挂上的 cleanup 将永不执行（泄漏）。直接立即执行掉。
      if (disposed) {
        if (typeof ret === 'function') {
          try {
            ret();
          } catch (err) {
            this.logger.warn(`whenService('${name}') cleanup 抛错（dispose 期间，已忽略）:`, err);
          }
        }
        return;
      }
      if (typeof ret === 'function') cleanup = ret;
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

    // 立即检查：若已就绪则首挂。
    sync();

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      this._disposables.remove(dispose); // 自移除，不滞留闭包（对称 provide）
      offReg();
      offUnreg();
      offPref();
      runCleanup();
      attached = undefined;
    };

    this._disposables.push(dispose);
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
    return this.trackDisposable(this._hooks.register(hook, fn, this.id));
  }

  /**
   * 执行钩子链（语义见 {@link HookRegistry.run}）。
   *
   * 任何插件都可驱动自己定义的钩子链——对称钩子系统的立身之本，地位等价于
   * `ctx.emit`。注册 handler 请用 `ctx.middleware(hook, fn)`。完整 HookRegistry
   * （register / unregisterByContext / onStall）不对插件暴露，与 `_events` /
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
    if (this._disposed) {
      this.logger.warn(`Context "${this.id}" 已 dispose，忽略 contribute("${point}")`);
      return () => {};
    }
    const mapKey = `${point}\u0000${(spec as ContributionSpec).id}`;
    // 同键重注册 = 替换：先撤旧登记（自移除出 dispose 链 + 撤注册表旧条目），
    // 再写新的——先删后写，避免旧闭包滞留（见 _contributionDisposers）。
    this._contributionDisposers.get(mapKey)?.();
    const rawOff = this.trackDisposable(this._contributions.register(point, spec, this.id));
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
    return this._disposed;
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
    if (this._disposed) {
      throw new Error(`Context "${this.id}" 已 dispose，无法 useModule`);
    }
    // 同一父 ctx 重复挂载同名 module（文档背书的"每会话一实例"用法）必须拿到
    // 互不相同的 ctx.id：id 是 contributions 全局键与 unregisterByContext 的
    // 归属锚，重复 id 会让后挂载者静默顶替先挂载者的贡献、且任一方 dispose
    // 连带清掉对方的。活跃集合随 dispose 收缩，长期反复挂载不会无界增长。
    const baseId = `${this.id}#${module.name}`;
    let childId = baseId;
    for (let n = 2; this._moduleIds.has(childId); n++) childId = `${baseId}~${n}`;
    this._moduleIds.add(childId);

    const child = this.fork(childId);
    try {
      await module.apply(child, config);
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
   * - 直接挂在 `_disposables` 链上，保证逆序执行
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
   * @returns 取消该清理回调的函数（在 dispose 前调用可阻止执行）
   */
  onDispose(fn: () => void | Promise<void>): () => void {
    const wrapped = () => {
      try {
        const ret = fn();
        if (ret && typeof (ret as Promise<void>).then === 'function') {
          // 把 promise 交还给链：异步拆卸路径（disposeAsync）会等待它完成——
          // 这是 onDispose 异步契约真正兑现的通道。错误就地消化，单个清理
          // 失败不拖垮链上其他清理；同步 dispose() 忽略返回值（不等待）。
          return (ret as Promise<void>).catch(err => {
            this.logger.debug('onDispose 异步清理抛错（已忽略）:', err);
          });
        }
      } catch (err) {
        this.logger.debug('onDispose 清理抛错（已忽略）:', err);
      }
    };
    this._disposables.push(wrapped);
    return () => this._disposables.remove(wrapped);
  }

  /** @internal 当前 disposable 链长度（诊断 / 测试用：检测 provide/whenService 的闭包是否如期自移除）。 */
  get disposableCount(): number {
    return this._disposables.size;
  }

  /**
   * 销毁此上下文，清理所有副作用（同步；异步清理不等待）。
   *
   * 需要等待落盘类异步清理完成时用 {@link disposeAsync}——编排层
   * （PluginManager 的 unload / bounce / 停机路径与 App.stop）走的是它。
   */
  dispose(): void {
    // wait=false 分支不命中任何 await——async 函数体在首个 await 前同步执行，
    // 本方法的可观察时序与纯同步实现一致（有测试以同步副作用守着）。
    // 差异仅在抛错路径：异常成为 rejection 而非同步抛出（体内各步骤均自带
    // 隔离，实际不可达），catch 兜底防 unhandledRejection。
    const p = this._teardown(false);
    this._inflightTeardown ??= p;
    p.catch(err => {
      this.logger.error('dispose 收尾异常:', err);
    });
  }

  /**
   * 可等待的销毁：语义与 {@link dispose} 相同，但逆序**串行等待**每个异步
   * 清理（`onDispose` 返回的 promise）完成后才返回——bounce / unload / 停机
   * 路径上落盘类清理从此真正落地，而非只是"开始执行"。
   *
   * 幂等且**可 join**：已有拆卸在飞时等待它完成再返回，而不是看到 `_disposed`
   * 就早退（`_disposed` 在清理开始前置位，早退会让调用方拿到"已完成"的假象——
   * 父级联撞上半拆的子 ctx、并发 stop、unload 撞 bounce 都会走到这条路）。
   *
   * ⚠． **不得在本 ctx 自己的 `onDispose` 回调里 await 本方法**——在飞的拆卸
   *    正等着那个回调返回，await 它即自等自死锁（与 `PluginManagerService.idle()`
   *    同类约束）。清理回调只需做自己的收尾，拆卸本身由编排层驱动。
   *
   * @param timeoutMs 单个异步清理项的等待上限；超时放弃该项、继续后续清理
   *        并 warn 点名（防网络类关闭卡死整个停机）。缺省不设限。
   */
  async disposeAsync(timeoutMs?: number): Promise<void> {
    this._inflightTeardown ??= this._teardown(true, timeoutMs);
    await this._inflightTeardown;
  }

  private async _teardown(wait: boolean, timeoutMs?: number): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    // 先销毁子上下文（复制避免迭代中修改 Set）
    const children = [...this._children];
    for (const child of children) {
      if (wait) await child.disposeAsync(timeoutMs);
      else child.dispose();
    }
    this._children.clear();

    // 记录此上下文注册的服务名，以便清理后发射事件
    const removedServices = this._services.unregisterByContext(this.id);

    // 钩子与贡献在清理链**之前**注销：异步等待清理的整个窗口内，本插件的
    // 中间件不得再响应消息、贡献不得再被组装器收集——半拆状态不外露。
    // 同步路径同一 tick 内完成，先后不可观察；清理链里两类注册的 disposer
    // 靠各自的存在性检查/恒等卫自然 no-op，不会双删。
    this._hooks.unregisterByContext(this.id);
    this._contributions.unregisterByContext(this.id);

    // 逆序执行清理（unregisterByContext 已整体移除服务，provide 的 dispose 会安全跳过）
    if (wait) await this._disposables.disposeAsync(timeoutMs);
    else this._disposables.dispose();

    // 发射服务注销事件，让 App 的自动恢复监听器能响应
    for (const svc of removedServices) {
      this._events.emit('service:unregistered', svc).catch(err => {
        this.logger.warn(`emit service:unregistered 失败 (${svc}): ${err}`);
      });
    }

    // 释放本 ctx 持有的登记表：闭包会捎带 spec（及其 build 捕获的数据），
    // dispose 后不清则外部若仍持有本 ctx 引用，这些对象就跟着活着。
    this._contributionDisposers.clear();
    this._moduleIds.clear();

    // 服务自清理协议：任何服务实例若实现 `unregisterByPlugin(contextId)`，
    // dispose 时统一通知它清理本上下文相关的注册项（如 plugin-tools 的
    // ToolService、plugin-commands 的 CommandService）。
    // core 不再硬编码任何具体服务名。
    // 遍历该服务名下的**所有** entry 而非只通知胜者——败者实例（低优先级
    // 并存 provider）也可能持有本上下文注册的条目。同名多 entry 可能指向
    // 同一实例（per-model 拆粒度），按实例去重避免重复通知。
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

    // 从父上下文中移除
    if (this._parent) {
      this._parent._children.delete(this);
    }
  }
}
