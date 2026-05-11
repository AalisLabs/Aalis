import { type ConfigManager, ScopedConfigManager } from './config.js';
import { DisposableChain } from './disposable-chain.js';
import type { EventBus } from './events.js';
import type { HookRegistry } from './hooks.js';
import type { Logger } from './logger.js';
import type { ServiceContainer } from './service.js';
import { probeCapability } from './types/capabilities.js';
import type { AalisEvents, CapabilityList, HookContextMap, MiddlewareFn } from './types/index.js';

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
 * - **`Context.extend(name, impl)`**：进程级方法注入，重名抛错避免静默覆盖
 */
export class Context {
  readonly id: string;
  readonly logger: Logger;
  readonly config: ConfigManager;
  readonly hooks: HookRegistry;

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
  }) {
    this.id = options.id;
    this._events = options.events;
    this._services = options.services;
    this.hooks = options.hooks;
    this.logger = options.logger;
    this.config = options.config;
    this._parent = options.parent;
    this._disposables = new DisposableChain(this.logger);
  }

  // ---- 子系统访问（供高级插件检查/包装用） ----

  /** 底层事件总线实例 */
  get eventBus(): EventBus {
    return this._events;
  }

  /** 底层服务容器实例 */
  get serviceContainer(): ServiceContainer {
    return this._services;
  }

  // ---- 内置服务 getter 已移除 ----
  // 请使用 ctx.getService<ToolService>('tools') / ctx.getService<CommandService>('commands')，
  // 类型分别来自 @aalis/plugin-tools-api / @aalis/plugin-commands-api。

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
   */
  provide<TName extends string>(
    name: TName,
    instance: unknown,
    options?: { capabilities?: CapabilityList<TName>; priority?: number; label?: string },
  ): () => void {
    const caps = options?.capabilities ?? [];

    // dev 模式下按声明的能力探测实例方法，暴露「声明与实现不符」
    if (process.env.NODE_ENV !== 'production') {
      const failures: string[] = [];
      for (const cap of caps) {
        const result = probeCapability(name, cap as string, instance);
        if (typeof result === 'string') failures.push(`  - [${cap}] ${result}`);
      }
      if (failures.length > 0) {
        throw new Error(`服务 "${name}" 声明的能力与实例实现不符（provide 拒绝注册）:\n${failures.join('\n')}`);
      }
    }

    const entry = this._services.register(
      name,
      instance,
      caps as readonly string[] as string[],
      options?.priority ?? 0,
      this.id,
      options?.label,
    );

    const dispose = () => {
      const removed = this._services.unregisterEntry(name, entry);
      if (removed) {
        this._events.emit('service:unregistered', name).catch(() => {});
      }
    };
    this._disposables.push(dispose);

    this._events.emit('service:registered', name, [...caps]).catch(err => {
      this.logger.warn(`服务注册事件发射失败 [${name}]:`, err);
    });
    this.logger.debug(`服务已注册: ${name}${caps.length ? ` [${caps.join(', ')}]` : ''}`);

    return dispose;
  }

  /**
   * 获取服务 (支持能力匹配)
   *
   * `requiredCapabilities` 按服务名获得强类型约束（同 `provide()`）。
   */
  getService<T, TName extends string = string>(
    name: TName,
    requiredCapabilities?: CapabilityList<TName>,
  ): T | undefined {
    return this._services.get<T>(name, requiredCapabilities as readonly string[] as string[] | undefined);
  }

  /**
   * 检查服务是否可用
   */
  hasService<TName extends string>(name: TName, requiredCapabilities?: CapabilityList<TName>): boolean {
    return this._services.has(name, requiredCapabilities as readonly string[] as string[] | undefined);
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
   * const visionLLMs = ctx.getAllServices<LLMService>('llm', ['vision']);
   *
   * // 获取所有 LLM 并聚合模型列表
   * const allLLMs = ctx.getAllServices<LLMService>('llm');
   */
  getAllServices<T, TName extends string = string>(
    name: TName,
    requiredCapabilities?: CapabilityList<TName>,
  ): Array<{ instance: T; contextId: string; capabilities: string[]; label?: string }> {
    return this._services.getAll<T>(name, requiredCapabilities as readonly string[] as string[] | undefined);
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
   * ctx.whenService<ToolService>('tools', svc => {
   *   const off = svc.register(myTool, ctx.id);
   *   return off; // 自动纳入 dispose 链
   * });
   */
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

  /**
   * 给 Context.prototype 添加一个方法（进程级共享）。
   *
   * 用于插件向使用者暴露便捷方法，例如 plugin-tools 注入
   * `ctx.registerTool()`、plugin-commands 注入 `ctx.command()`。
   *
   * **同名方法存在时抛错**，避免静默覆盖。
   *
   * @returns 卸载函数：从 prototype 上移除该方法。
   * @example
   * Context.extend('registerTool', function(this: Context, tool) {
   *   return this.whenService<ToolService>('tools', svc => svc.register(tool, this.id));
   * });
   */
  static extend(name: string, impl: (this: Context, ...args: never[]) => unknown): () => void {
    if (name in Context.prototype) {
      throw new Error(`Context.extend: 方法 "${name}" 已存在，拒绝覆盖`);
    }
    Object.defineProperty(Context.prototype, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: impl,
    });
    return () => {
      delete (Context.prototype as unknown as Record<string, unknown>)[name];
    };
  }

  // ---- 业务便捷方法已迁出 ----
  //
  // ctx.registerTool / registerToolGroup —— 见 @aalis/plugin-tools-api +
  //   @aalis/plugin-tools（通过 Context.extend 注入到 prototype）
  // ctx.command —— 见 @aalis/plugin-commands-api + @aalis/plugin-commands
  //
  // core 不再直接知晓 tools / commands 概念。

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
