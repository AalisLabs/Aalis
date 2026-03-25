import { EventBus } from './events.js';
import { ServiceContainer } from './service.js';
import { ToolRegistry } from './tools.js';
import { HookRegistry } from './hooks.js';
import { CommandRegistry } from './commands.js';
import { AuthorityManager } from './authority.js';
import { Logger } from './logger.js';
import { ConfigManager } from './config.js';
import type { AalisEvents, RegisteredTool, HookContextMap, MiddlewareFn, CommandContext, CommandDefinition, SafetyLevel, PlatformAdapter, PlatformConnection } from './types.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/** mixin 记录：哪些方法代理到哪个服务 */
interface MixinEntry {
  service: string;
  methods: string[];
  contextId: string;
}

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
  private _disposables: (() => void)[] = [];
  private _children: Set<Context> = new Set();
  private _parent?: Context;
  private _disposed = false;

  /** 全局 mixin 注册表（所有 Context 实例共享） */
  private static _mixins: MixinEntry[] = [];

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
  }

  // ---- 子系统访问（供高级插件检查/包装用） ----

  /** 底层事件总线实例 */
  get eventBus(): EventBus { return this._events; }

  /** 底层服务容器实例 */
  get serviceContainer(): ServiceContainer { return this._services; }

  // ---- 内置服务 getter（由 builtin 插件注册，通过服务容器延迟查找） ----

  get tools(): ToolRegistry {
    const svc = this._services.get<ToolRegistry>('tools');
    if (!svc) throw new Error('ToolRegistry 服务不可用，请确保 @aalis/builtin-tools 已加载');
    return svc;
  }

  get commands(): CommandRegistry {
    const svc = this._services.get<CommandRegistry>('commands');
    if (!svc) throw new Error('CommandRegistry 服务不可用，请确保 @aalis/builtin-commands 已加载');
    return svc;
  }

  get authority(): AuthorityManager {
    const svc = this._services.get<AuthorityManager>('authority');
    if (!svc) throw new Error('AuthorityManager 服务不可用，请确保 @aalis/builtin-authority 已加载');
    return svc;
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
   */
  provide(
    name: string,
    instance: unknown,
    options?: { capabilities?: string[]; priority?: number },
  ): () => void {
    this._services.register(
      name,
      instance,
      options?.capabilities ?? [],
      options?.priority ?? 0,
      this.id,
    );

    const dispose = () => {
      const removed = this._services.unregister(name, this.id);
      if (removed) {
        this._events.emit('service:unregistered', name).catch(() => {});
      }
    };
    this._disposables.push(dispose);

    const caps = options?.capabilities ?? [];
    this._events.emit('service:registered', name, caps).catch(() => {});
    this.logger.debug(`服务已注册: ${name}${caps.length ? ` [${caps.join(', ')}]` : ''}`);

    return dispose;
  }

  /**
   * 获取服务 (支持能力匹配)
   */
  getService<T>(name: string, requiredCapabilities?: string[]): T | undefined {
    return this._services.get<T>(name, requiredCapabilities);
  }

  /**
   * 检查服务是否可用
   */
  hasService(name: string, requiredCapabilities?: string[]): boolean {
    return this._services.has(name, requiredCapabilities);
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
   * 切换服务的偏好提供者
   */
  preferService(name: string, contextId: string): boolean {
    return this._services.prefer(name, contextId);
  }

  // ---- 平台 ----

  /**
   * 获取所有已注册的平台适配器
   *
   * 每个平台插件通过 `ctx.provide('platform', adapter, { capabilities: ['<平台名>'] })`
   * 注册自身，claim 即为平台标识（如 'onebot', 'cli', 'webui'）。
   */
  getPlatforms(): PlatformAdapter[] {
    return this._services.getEntries('platform')
      .map(e => e.instance as PlatformAdapter)
      .filter(a => a && typeof a.getConnections === 'function');
  }

  /**
   * 获取所有已注册的平台名称（去重）
   *
   * 基于各 platform 服务的 capabilities 收集，而非 adapter.platform 字段。
   */
  getPlatformNames(): string[] {
    const names = new Set<string>();
    for (const entry of this._services.getEntries('platform')) {
      for (const cap of entry.capabilities) names.add(cap);
    }
    return [...names];
  }

  /**
   * 获取所有平台适配器及其连接详情
   */
  getPlatformDetails(): Array<{
    adapterName: string;
    platform: string;
    contextId: string;
    capabilities: string[];
    connections: PlatformConnection[];
  }> {
    return this._services.getEntries('platform').map(entry => {
      const adapter = entry.instance as PlatformAdapter;
      return {
        adapterName: adapter.adapterName,
        platform: adapter.platform,
        contextId: entry.contextId,
        capabilities: [...entry.capabilities],
        connections: adapter.getConnections(),
      };
    });
  }

  // ---- 工具 ----

  /**
   * 注册 AI 工具（便捷方法）
   */
  registerTool(tool: Omit<RegisteredTool, 'pluginName'>): () => void {
    const dispose = this.tools.register(tool, this.id);
    this._disposables.push(dispose);
    return dispose;
  }

  // ---- 指令 ----

  /**
   * 注册斜杠指令（便捷方法）
   *
   * @example
   * // 插件注册自定义指令
   * ctx.command('ping', '测试连通性', async () => 'pong!');
   *
   * // 带参数的指令
   * ctx.command('echo', '回显消息', async (cmdCtx) => {
   *   return cmdCtx.args.join(' ') || '(空)';
   * });
   */
  command(
    name: string,
    description: string,
    action: (ctx: CommandContext) => Promise<string | void>,
    options?: { authority?: number; safety?: SafetyLevel; asTools?: boolean },
  ): () => void {
    const def: CommandDefinition = {
      name,
      description,
      action,
      authority: options?.authority,
      safety: options?.safety,
      asTools: options?.asTools,
    };
    const dispose = this.commands.register(def, this.id);
    this._disposables.push(dispose);
    return dispose;
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
    const entry: MixinEntry = { service: serviceName, methods, contextId: this.id };
    Context._mixins.push(entry);

    // 在 Context prototype 上定义 getter，代理到服务
    for (const method of methods) {
      if (method in Context.prototype) {
        this.logger.warn(`mixin: 方法 "${method}" 已存在于 Context，跳过`);
        continue;
      }
      Object.defineProperty(Context.prototype, method, {
        configurable: true,
        enumerable: false,
        get(this: Context) {
          const svc = this.getService<Record<string, unknown>>(serviceName);
          if (!svc) return undefined;
          const val = svc[method];
          if (typeof val === 'function') return val.bind(svc);
          return val;
        },
      });
    }

    const dispose = () => {
      const idx = Context._mixins.indexOf(entry);
      if (idx >= 0) Context._mixins.splice(idx, 1);
      for (const method of methods) {
        // 只有当没有其他 mixin 注册了同名方法时才删除
        const stillUsed = Context._mixins.some(e => e.methods.includes(method));
        if (!stillUsed) {
          delete (Context.prototype as unknown as Record<string, unknown>)[method];
        }
      }
    };
    this._disposables.push(dispose);
    this.logger.debug(`mixin: ${methods.join(', ')} → ${serviceName}`);
    return dispose;
  }

  /**
   * 获取当前所有 mixin 注册信息
   */
  static getMixins(): Array<{ service: string; methods: string[]; contextId: string }> {
    return Context._mixins.map(e => ({ ...e }));
  }

  // ---- 中间件/钩子 ----

  /**
   * 注册中间件，拦截核心流程
   *
   * @example
   * // 在消息发送给 LLM 前添加额外指令
   * ctx.middleware('llm-call:before', async (data, next) => {
   *   data.messages.unshift({ role: 'system', content: '额外指令...' });
   *   await next();
   * });
   *
   * // 过滤掉某些用户消息
   * ctx.middleware('message:before', async (data, next) => {
   *   if (data.message.content.includes('spam')) return; // 不调用 next = 中断
   *   await next();
   * });
   */
  middleware<K extends string & keyof HookContextMap>(
    hook: K,
    fn: MiddlewareFn<HookContextMap[K]>,
    priority?: number,
  ): () => void {
    const dispose = this.hooks.register(hook, fn, priority, this.id);
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

    // 先销毁子上下文
    for (const child of this._children) {
      child.dispose();
    }
    this._children.clear();

    // 记录此上下文注册的服务名，以便 dispose 后发射事件
    const removedServices = this._services.unregisterByContext(this.id);

    // 逆序执行清理（unregisterByContext 已整体移除服务，provide 的 dispose 会安全跳过）
    for (let i = this._disposables.length - 1; i >= 0; i--) {
      try {
        this._disposables[i]();
      } catch {
        // 忽略清理错误
      }
    }
    this._disposables = [];

    // 发射服务注销事件，让 App 的自动恢复监听器能响应
    for (const svc of removedServices) {
      this._events.emit('service:unregistered', svc).catch(() => {});
    }

    // 清理该上下文注册的钩子
    this.hooks.unregisterByContext(this.id);

    // 清理该上下文注册的指令（安全访问，服务可能已卸载）
    this._services.get<CommandRegistry>('commands')?.unregisterByPlugin(this.id);

    // 从父上下文中移除
    if (this._parent) {
      this._parent._children.delete(this);
    }
  }
}
