import { EventBus } from './events.js';
import { ServiceContainer } from './service.js';
import { HookRegistry } from './hooks.js';
import { Logger } from './logger.js';
import { ConfigManager } from './config.js';
import { DisposableChain } from './disposable-chain.js';
import { MixinRegistry } from './mixin-registry.js';
import { PendingRegistrationBuffer } from './pending-buffer.js';
import { probeCapability } from './types/capabilities.js';
import type { AalisEvents, RegisteredTool, ToolGroupInfo, HookContextMap, MiddlewareFn, CommandContext, CommandDefinition, SubcommandDefinition, SafetyLevel, PlatformAdapter, PlatformConnection, ToolService, CommandService, CapabilityList } from './types/index.js';

type Maybe<T> = T | undefined;

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/**
 * 上下文 (Context)
 *
 * 每个插件获得一个子 Context。所有通过子 Context 注册的副作用
 * (事件监听、服务注册、工具注册) 在 dispose 时自动清理。
 *
 * 设计参考 internal-framework 的 Context 模型，但增加了能力声明的支持。
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

  /** 注册缓冲：服务尚不可用时暂存，待服务就绪后自动刷入 */
  private _pending: PendingRegistrationBuffer;

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
    this._pending = new PendingRegistrationBuffer(
      this.id,
      this._services,
      this.logger,
      this._disposables,
      (event, handler) => this.on(event, handler),
    );
  }

  // ---- 子系统访问（供高级插件检查/包装用） ----

  /** 底层事件总线实例 */
  get eventBus(): EventBus { return this._events; }

  /** 底层服务容器实例 */
  get serviceContainer(): ServiceContainer { return this._services; }

  // ---- 内置服务 getter（由 builtin 插件注册，通过服务容器延迟查找） ----

  get tools(): Maybe<ToolService> {
    return this._services.get<ToolService>('tools');
  }

  get commands(): Maybe<CommandService> {
    return this._services.get<CommandService>('commands');
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
    });
    this._children.add(child);
    return child;
  }

  /**
   * 创建隔离作用域的子上下文
   *
   * 与 fork() 的区别：fork() 共享同一个 ServiceContainer；
   * createScope() 创建一个 **ScopedServiceContainer**（子容器），
   * 读取 fallback 到父容器，写入仅影响子容器自身。
   *
   * 适用于沙盒/会话隔离场景：
   * - 沙盒内 `ctx.provide('agent', sandboxAgent)` 不会污染全局
   * - 沙盒内 `ctx.getService('authority')` 仍能 fallback 到全局服务
   *
   * @example
   * const sandbox = ctx.createScope('sandbox-group-123');
   * sandbox.provide('agent', myCustomAgent); // 仅此作用域可见
   * sandbox.getService('authority'); // fallback 到父级全局服务
   */
  createScope(id: string): Context {
    const scopedServices = this._services.createScope();
    const child = new Context({
      id,
      events: this._events,
      services: scopedServices,
      hooks: this.hooks,
      logger: this.logger.child(id),
      config: this.config,
      parent: this,
    });
    this._children.add(child);
    return child;
  }

  // ---- 事件 ----

  on<E extends string & keyof AalisEvents>(
    event: E,
    handler: EventHandler<AalisEvents[E]>,
  ): () => void {
    const dispose = this._events.on(event, handler);
    this._disposables.push(dispose);
    return dispose;
  }

  once<E extends string & keyof AalisEvents>(
    event: E,
    handler: EventHandler<AalisEvents[E]>,
  ): () => void {
    const dispose = this._events.once(event, handler);
    this._disposables.push(dispose);
    return dispose;
  }

  emit<E extends string & keyof AalisEvents>(
    event: E,
    ...args: AalisEvents[E]
  ): Promise<void> {
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
        throw new Error(
          `服务 "${name}" 声明的能力与实例实现不符（provide 拒绝注册）:\n${failures.join('\n')}`,
        );
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
  hasService<TName extends string>(
    name: TName,
    requiredCapabilities?: CapabilityList<TName>,
  ): boolean {
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
  listServices(): string[] {
    return this._services.listServices();
  }

  /**
   * 获取某个服务的所有 entry
   */
  getServiceEntries(name: string) {
    return this._services.getEntries(name);
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
  getAllServices<T, TName extends string = string>(name: TName, requiredCapabilities?: CapabilityList<TName>): Array<{ instance: T; contextId: string; capabilities: string[]; label?: string }> {
    return this._services.getAll<T>(name, requiredCapabilities as readonly string[] as string[] | undefined);
  }

  /**
   * 切换服务的偏好提供者
   */
  preferService(name: string, contextId: string): boolean {
    return this._services.prefer(name, contextId);
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
  whenService<T>(name: string, cb: (svc: T) => void | (() => void)): () => void {
    let cleanup: (() => void) | void;
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
        try { cleanup(); } catch (err) { this.logger.warn('whenService cleanup 异常:', err); }
        cleanup = undefined;
      }
    };
  }

  /**
   * 给 Context.prototype 添加一个方法（进程级共享）。
   *
   * 用于插件向使用者暴露便捷方法，例如 plugin-tools-system 注入
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

  // ---- 注册缓冲（服务延迟就绪支持，逻辑已抽到 PendingRegistrationBuffer） ----

  // ---- 工具 ----

  /**
   * 注册 AI 工具（便捷方法）
   * 若 tools 服务尚不可用，注册将被缓冲并在服务就绪后自动刷入。
   */
  registerTool(tool: Omit<RegisteredTool, 'pluginName'>): () => void {
    return this._pending.registerTool(tool);
  }

  /**
   * 注册工具分组（便捷方法）
   * 若 tools 服务尚不可用，注册将被缓冲并在服务就绪后自动刷入。
   */
  registerToolGroup(group: Omit<ToolGroupInfo, 'pluginName'>): () => void {
    return this._pending.registerToolGroup(group);
  }

  // ---- 指令 ----

  /**
   * 注册斜杠指令（便捷方法）
   * 若 commands 服务尚不可用，注册将被缓冲并在服务就绪后自动刷入。
   *
   * @example
   * ctx.command('ping', '测试连通性', async () => 'pong!');
   *
   * ctx.command('echo', '回显消息', async (cmdCtx) => {
   *   return cmdCtx.args.join(' ') || '(空)';
   * });
   */
  command(
    name: string,
    description: string,
    action: (ctx: CommandContext) => Promise<string | void>,
    options?: {
      authority?: number;
      safety?: SafetyLevel;
      permissions?: string[];
      /** 位置参数声明 */
      arguments?: CommandDefinition['arguments'];
      /** 选项声明 */
      options?: CommandDefinition['options'];
      /** 自定义用法文本 */
      usage?: string;
      /** 示例 */
      examples?: string[];
      /** 子指令树（递归）。详见 CommandDefinition.subcommands */
      subcommands?: SubcommandDefinition[];
    },
  ): () => void {
    const def: CommandDefinition = {
      name,
      description,
      action,
      authority: options?.authority,
      safety: options?.safety,
      permissions: options?.permissions,
      arguments: options?.arguments,
      options: options?.options,
      usage: options?.usage,
      examples: options?.examples,
      subcommands: options?.subcommands,
    };
    return this._pending.registerCommand(def);
  }

  // ---- Mixin ----

  /**
   * 将服务的方法代理到 Context 上
   *
   * 调用后，所有 Context 实例都可以直接调用这些方法，
   * 实际执行时会通过 getService 获取当前活跃的服务实例。
   *
   * @example
   * // 插件注册一个 scheduler 服务并 mixin 到 context
   * ctx.provide('scheduler', schedulerImpl);
   * ctx.mixin('scheduler', ['schedule', 'cron', 'interval']);
   *
   * // 其他插件可以直接使用:
   * (ctx as any).schedule('daily', callback);
   *
   * // 配合 declare module 获得类型支持:
   * // declare module '@aalis/core' {
   * //   interface Context { schedule(name: string, cb: () => void): void; }
   * // }
   */
  mixin(serviceName: string, methods: string[]): () => void {
    const dispose = MixinRegistry.register(Context.prototype, serviceName, methods, this.id, this.logger);
    this._disposables.push(dispose);
    return dispose;
  }

  /**
   * 获取当前所有 mixin 注册信息
   */
  static getMixins(): Array<{ service: string; methods: string[]; contextId: string }> {
    return MixinRegistry.list();
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
  middleware<K extends string & keyof HookContextMap>(
    hook: K,
    fn: MiddlewareFn<HookContextMap[K]>,
  ): () => void {
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
    this._pending.clear();

    // 发射服务注销事件，让 App 的自动恢复监听器能响应
    for (const svc of removedServices) {
      this._events.emit('service:unregistered', svc).catch(() => {});
    }

    // 清理该上下文注册的钩子
    this.hooks.unregisterByContext(this.id);

    // 清理该上下文注册的工具（安全访问，服务可能已卸载）
    this._services.get<ToolService>('tools')?.unregisterByPlugin(this.id);

    // 清理该上下文注册的指令（安全访问，服务可能已卸载）
    this._services.get<CommandService>('commands')?.unregisterByPlugin(this.id);

    // 从父上下文中移除
    if (this._parent) {
      this._parent._children.delete(this);
    }
  }
}
