import { type ConfigManager, ScopedConfigManager } from './config.js';
import { DisposableChain } from './disposable-chain.js';
import type { EventBus } from './events.js';
import type { HookRegistry } from './hooks.js';
import type { Logger } from './logger.js';
import type { ServiceContainer } from './service.js';
import { emitServiceRegistered, validateProvide } from './service-helpers.js';
import type { AalisEvents, CapabilityList, HookContextMap, MiddlewareFn, ServiceTypeMap } from './types/index.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/**
 * 上下文 (Context)
 *
 * 每个插件获得一个子 Context。所有通过子 Context 注册的副作用
 * (事件监听、服务注册、工具注册) 在 dispose 时自动清理。
 *
 * 采用 fork / inject / provide / middleware 等术语，
 * 但 Aalis 在此之上引入若干差异化机制：
 * - **能力声明框架**：`provide` 时声明 `capabilities`，编译期类型字面量收敛 +
 *   dev 期 `probeCapability` 运行时校验声明与实现是否一致
 * - **多提供者 + 能力匹配**：`getService` / `getAllServices` 支持按能力过滤，
 *   服务可以并存多个实现
 * - **`ScopedServiceContainer` + `ScopedConfigManager`**：`createScope()` 创建
 *   读取 fallback、写入隔离的子作用域，用于会话/沙盒
 * - **`whenService(name, cb)`**：服务就绪即触发的延迟订阅，回调可返回 cleanup
 *   纳入 dispose 链
 */
export class Context {
  readonly id: string;
  readonly logger: Logger;
  readonly config: ConfigManager;
  readonly hooks: HookRegistry;
  /**
   * 开发模式开关——由 App 注入，子 Context 通过 fork/createScope 继承。
   *
   * - `true`（默认）：`provide` 时按声明的能力跑探测器，暴露"声明与实现不符"
   * - `false`（生产）：跳过探测，节省热路径开销
   *
   * core 不读 `process.env`——是否 dev 由宿主决定。
   */
  readonly devMode: boolean;

  private _events: EventBus;
  private _services: ServiceContainer;
  private _disposables: DisposableChain;
  private _children: Set<Context> = new Set();
  private _parent?: Context;
  private _disposed = false;

  constructor(options: {
    id: string;
    events: EventBus;
    services: ServiceContainer;
    hooks: HookRegistry;
    logger: Logger;
    config: ConfigManager;
    parent?: Context;
    devMode?: boolean;
  }) {
    this.id = options.id;
    this._events = options.events;
    this._services = options.services;
    this.hooks = options.hooks;
    this.logger = options.logger;
    this.config = options.config;
    this._parent = options.parent;
    this.devMode = options.devMode ?? options.parent?.devMode ?? true;
    this._disposables = new DisposableChain(this.logger);
  }

  // ---- 子系统访问（供高级插件检查/包装用） ----

  /**
   * 底层事件总线实例。
   *
   * ⚠️ **@internal** —— 仅供需要自定义生命周期的高级插件使用（如桥接外部资源、
   * 在 dispose 后还需监听的场景）。普通插件请使用 `ctx.on()`，监听器会自动
   * 在本 Context dispose 时清理。
   *
   * 直接调用 `ctx.eventBus.on(...)` **不会**进入 `_disposables` 链；
   * 若需要"dispose 时清理外部资源"，请改用 `ctx.onDispose(cb)`。
   */
  get eventBus(): EventBus {
    return this._events;
  }

  /**
   * 底层服务容器实例。
   *
   * ⚠️ **@internal** —— 仅供高级巡视/诊断使用（如 plugin-authority 枚举所有
   * provider）。普通插件请使用 `ctx.provide()` / `ctx.getService()`，副作用
   * 会自动登记到 `_disposables` 链。
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
      hooks: this.hooks,
      logger: this.logger.child(id),
      config: this.config,
      parent: this,
      devMode: this.devMode,
    });
    this._children.add(child);
    return child;
  }

  /**
   * 创建隔离作用域的子上下文
   *
   * 与 fork() 的区别：fork() 共享同一个 ServiceContainer / ConfigManager；
   * createScope() 同时创建：
   * - **ScopedServiceContainer**（子容器）：读 fallback、写不影响父级
   * - **ScopedConfigManager**（cleanup-7 新增）：同样 fallback + overlay 语义
   *
   * 适用于沙盒/会话隔离场景：
   * - 沙盒内 `ctx.provide('agent', sandboxAgent)` 不会污染全局
   * - 沙盒内 `ctx.getService('authority')` 仍能 fallback 到全局服务
   * - 沙盒内 `ctx.config.set('logLevel', 'debug')` 仅作用于沙盒
   * - 沙盒内 `ctx.config.setPluginConfig('llm.openai', { ... })` 给当前沙盒一份
   *   临时 LLM 配置，dispose 后随作用域消失（save() 抛错保证不污染磁盘）
   *
   * @example
   * const sandbox = ctx.createScope('sandbox-group-123');
   * sandbox.provide('agent', myCustomAgent); // 仅此作用域可见
   * sandbox.config.setPluginConfig('llm.openai', { temperature: 0.1 }); // 临时配置
   * sandbox.getService('authority'); // fallback 到父级全局服务
   */
  createScope(id: string): Context {
    const scopedServices = this._services.createScope();
    const scopedConfig = new ScopedConfigManager(this.config);
    const child = new Context({
      id,
      events: this._events,
      services: scopedServices,
      hooks: this.hooks,
      logger: this.logger.child(id),
      config: scopedConfig,
      parent: this,
      devMode: this.devMode,
    });
    this._children.add(child);
    return child;
  }

  // ---- 事件 ----

  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void {
    const dispose = this._events.on(event, handler);
    this._disposables.push(dispose);
    return dispose;
  }

  once<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void {
    const dispose = this._events.once(event, handler);
    this._disposables.push(dispose);
    return dispose;
  }

  emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void> {
    return this._events.emit(event, ...args);
  }

  // ---- 服务 (IoC + 能力声明) ----

  /**
   * 注册服务，返回 dispose 函数用于精确卸载该服务
   *
   * `capabilities` 参数按服务名获得强类型约束：
   * - 已注册服务名（如 `'llm'`, `'memory'`）→ 仅允许对应 union 中的字面量
   * - 未注册服务名 → 退回 `string`，保留动态扩展空间
   *
   * @example
   * ctx.provide('llm', service, { capabilities: ['chat', 'tool_calling'] });
   * //                                            ^^^^^^  ^^^^^^^^^^^^^^
   * //                                            类型安全，拼错 'tool_call' 会编译报错
   *
   * `entryId` 选项：覆盖默认 contextId（默认 = `this.id`）。用于一个 plugin 实例
   * 需要按某种语义子粒度拆出多个 entry 的场景（典型：per-model LLM、per-path storage）。
   * 约定：`entryId` 必须以 `this.id` 为前缀（以 `/` 分隔），以保证 plugin 卸载时
   * `unregisterByContext(this.id)` 如需清理仍可多次调用；dispose 函数并不依赖这个约定，
   * 但 dev 模式下会验证以避免 "entryId 与拥有者 plugin 脱联" 的 footgun。
   */
  provide<TName extends string>(
    name: TName,
    instance: unknown,
    options?: { capabilities?: CapabilityList<TName>; priority?: number; label?: string; entryId?: string },
  ): () => void {
    const caps = (options?.capabilities ?? []) as readonly string[];
    const entryId = options?.entryId ?? this.id;

    if (this.devMode) {
      validateProvide({
        ctxId: this.id,
        name,
        instance,
        capabilities: caps,
        entryId,
        explicitEntryId: options?.entryId !== undefined,
        priority: options?.priority,
        services: this._services,
        logger: this.logger,
      });
    }

    const entry = this._services.register(
      name,
      instance,
      caps as string[],
      options?.priority ?? 0,
      entryId,
      options?.label,
    );

    const dispose = () => {
      const removed = this._services.unregisterEntry(name, entry);
      if (removed) {
        this._events.emit('service:unregistered', name).catch(() => {});
      }
    };
    this._disposables.push(dispose);

    emitServiceRegistered(this._events, this.logger, name, caps);
    this.logger.debug(`服务已注册: ${name}${caps.length ? ` [${caps.join(', ')}]` : ''}`);

    return dispose;
  }

  /**
   * 按名字 + 能力过滤拿服务当前最佳提供者。
   *
   * 返回的是**当时点的裸实例**，调用后 provider 发生换跳不会跟随。
   * 需要跟随切换的场景请听 `service:registered` / `service:unregistered`
   * 事件重新拉取；常规场景推荐在函数作用域内即取即用，不要长期存入类字段。
   *
   * `requiredCapabilities` 按服务名获得强类型约束（同 `provide()`）。
   * 如果当前没有任何匹配的 entry，返回 `undefined`（保留 null-check 语义）。
   *
   * 重载行为：
   * - 传入字面量服务名（如 `'memory'`）→ 命中 `ServiceTypeMap` 自动推断为 `MemoryService | undefined`；
   * - 传入字符串变量或未登记服务名 → 退回 `<T = unknown>`，调用方需自行 narrow，
   *   仍可显式传 `<T>` 兼容旧写法。
   */
  getService<TName extends keyof ServiceTypeMap>(
    name: TName,
    requiredCapabilities?: CapabilityList<TName>,
  ): ServiceTypeMap[TName] | undefined;
  getService<T = unknown>(name: string, requiredCapabilities?: readonly string[]): T | undefined;
  getService<T>(name: string, requiredCapabilities?: readonly string[]): T | undefined {
    return this._services.get<T>(name, requiredCapabilities);
  }

  /**
   * 检查服务是否可用
   */
  hasService<TName extends string>(name: TName, requiredCapabilities?: CapabilityList<TName>): boolean {
    return this._services.has(name, requiredCapabilities as readonly string[] | undefined);
  }

  /**
   * 获取服务的能力列表
   */
  getServiceCapabilities(name: string): string[] {
    return this._services.getCapabilities(name);
  }

  /**
   * 列出所有已注册的服务名
   */
  getServiceNames(): string[] {
    return this._services.getServiceNames();
  }

  /**
   * 获取某个服务的所有实例（带提供者信息）
   *
   * 可选 requiredCapabilities 过滤：只返回满足所有所需能力的提供者。
   *
   * @example
   * // 获取所有支持 vision 的 LLM
   * const visionLLMs = ctx.getAllServices('llm', ['vision']);
   *
   * // 获取所有 LLM 并聚合模型列表
   * const allLLMs = ctx.getAllServices('llm');
   */
  getAllServices<TName extends keyof ServiceTypeMap>(
    name: TName,
    requiredCapabilities?: CapabilityList<TName>,
  ): Array<{ instance: ServiceTypeMap[TName]; contextId: string; capabilities: string[]; label?: string }>;
  getAllServices<T = unknown>(
    name: string,
    requiredCapabilities?: readonly string[],
  ): Array<{ instance: T; contextId: string; capabilities: string[]; label?: string }>;
  getAllServices<T>(
    name: string,
    requiredCapabilities?: readonly string[],
  ): Array<{ instance: T; contextId: string; capabilities: string[]; label?: string }> {
    return this._services.getAll<T>(name, requiredCapabilities);
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
    if (ok) this.logger.debug(`服务偏好已设置: ${name} -> ${contextId}`);
    return ok;
  }

  /**
   * 清除某服务的偏好（恢复 priority + 注册顺序解析）
   */
  unpreferService(name: string): boolean {
    const ok = this._services.unprefer(name);
    if (ok) this.logger.debug(`服务偏好已清除: ${name}`);
    return ok;
  }

  /**
   * 读取某服务当前的偏好 contextId（无偏好返回 undefined）
   */
  getPreferredService(name: string): string | undefined {
    return this._services.getPreferred(name);
  }

  /**
   * 获取某服务的全部 entry（含 priority），按「偏好 > 优先级 > 注册顺序」排序。
   *
   * 主要给管控类消费者（如 WebUI / CLI status 视图）枚举展示用。
   * 业务消费者应优先使用 `getService` / `getAllServices`。
   */
  getServiceEntries(name: string): ReadonlyArray<{
    instance: unknown;
    contextId: string;
    capabilities: ReadonlySet<string>;
    priority: number;
    label?: string;
  }> {
    return this._services.getEntries(name);
  }

  /**
   * 当服务就绪时执行回调。若已就绪则立即调用；否则订阅 `service:registered`
   * 事件并在匹配名称时调用一次。
   *
   * 回调可返回清理函数，将在 `ctx.dispose()` 时自动调用。
   *
   * 返回的 dispose 函数：调用即移除监听并执行已注册的清理函数（若有）。
   * 多用于把"对服务的注册"行为缓冲到服务就绪后：
   *
   * @example
   * ctx.whenService('tools', svc => {
   *   const off = svc.register(myTool, ctx.id);
   *   return off; // 自动纳入 dispose 链
   * });
   */
  whenService<TName extends keyof ServiceTypeMap>(
    name: TName,
    cb: (svc: ServiceTypeMap[TName]) => undefined | (() => void),
  ): () => void;
  whenService<T = unknown>(name: string, cb: (svc: T) => undefined | (() => void)): () => void;
  whenService<T>(name: string, cb: (svc: T) => undefined | (() => void)): () => void {
    let cleanup: (() => void) | undefined;
    let invoked = false;
    let offSubscription: (() => void) | null = null;

    const run = (svc: T): void => {
      if (invoked) return;
      invoked = true;
      offSubscription?.();
      offSubscription = null;
      cleanup = cb(svc);
      if (typeof cleanup === 'function') this._disposables.push(cleanup);
    };

    const existing = this._services.get<T>(name);
    if (existing !== undefined) {
      run(existing);
    } else {
      offSubscription = this.on('service:registered', (svcName: string) => {
        if (svcName !== name) return;
        const svc = this._services.get<T>(name);
        if (svc !== undefined) run(svc);
      });
    }

    return () => {
      offSubscription?.();
      offSubscription = null;
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch (err) {
          this.logger.warn('whenService cleanup 异常:', err);
        }
        cleanup = undefined;
      }
    };
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
    const dispose = this.hooks.register(hook, fn, this.id);
    this._disposables.push(dispose);
    return dispose;
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
   * - 创建一个 fork/createScope 子上下文，调用 `module.apply(child, config)`
   * - 返回 dispose：调用即销毁该子上下文，对应子上下文里所有副作用一并清理
   * - 父 ctx dispose 时也会级联销毁
   *
   * 典型场景：
   * - 会话级动态工具/中间件
   * - 沙盒（`createScope`）内挂载临时 mini 插件
   * - 单元测试里组装最小可运行单元
   *
   * @param module 任意符合 `{ name, apply(ctx, config) }` 的对象
   * @param config 传给 apply 的配置（默认 `{}`）
   * @param options.scoped 是否使用 `createScope`（服务/配置隔离），默认 false 用 `fork`
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
    options?: { scoped?: boolean },
  ): Promise<() => void> {
    if (this._disposed) {
      throw new Error(`Context "${this.id}" 已 dispose，无法 useModule`);
    }
    const childId = `${this.id}#${module.name}`;
    const child = options?.scoped ? this.createScope(childId) : this.fork(childId);
    try {
      await module.apply(child, config);
    } catch (err) {
      child.dispose();
      throw err;
    }
    return () => child.dispose();
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
          (ret as Promise<void>).catch(err => {
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

  /**
   * 销毁此上下文，清理所有副作用
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // 先销毁子上下文（复制避免迭代中修改 Set）
    const children = [...this._children];
    for (const child of children) {
      child.dispose();
    }
    this._children.clear();

    // 记录此上下文注册的服务名，以便 dispose 后发射事件
    const removedServices = this._services.unregisterByContext(this.id);

    // 逆序执行清理（unregisterByContext 已整体移除服务，provide 的 dispose 会安全跳过）
    this._disposables.dispose();

    // 发射服务注销事件，让 App 的自动恢复监听器能响应
    for (const svc of removedServices) {
      this._events.emit('service:unregistered', svc).catch(() => {});
    }

    // 清理该上下文注册的钩子
    this.hooks.unregisterByContext(this.id);

    // 服务自清理协议：任何服务实例若实现 `unregisterByPlugin(contextId)`，
    // dispose 时统一通知它清理本上下文相关的注册项（如 plugin-tools 的
    // ToolService、plugin-commands 的 CommandService）。
    // core 不再硬编码任何具体服务名。
    for (const name of this._services.getServiceNames()) {
      const svc = this._services.get(name) as { unregisterByPlugin?: (id: string) => void } | undefined;
      try {
        svc?.unregisterByPlugin?.(this.id);
      } catch (err) {
        this.logger.warn(`服务 "${name}" 的 unregisterByPlugin 抛错:`, err);
      }
    }

    // 从父上下文中移除
    if (this._parent) {
      this._parent._children.delete(this);
    }
  }
}
