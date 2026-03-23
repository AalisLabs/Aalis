import { EventBus } from './events.js';
import { ServiceContainer } from './service.js';
import { ToolRegistry } from './tools.js';
import { HookRegistry } from './hooks.js';
import { Logger } from './logger.js';
import { ConfigManager } from './config.js';
import type { AalisEvents, RegisteredTool, HookContextMap, MiddlewareFn } from './types.js';

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
  readonly tools: ToolRegistry;
  readonly hooks: HookRegistry;

  private _events: EventBus;
  private _services: ServiceContainer;
  private _disposables: (() => void)[] = [];
  private _children: Set<Context> = new Set();
  private _parent?: Context;
  private _disposed = false;

  constructor(options: {
    id: string;
    events: EventBus;
    services: ServiceContainer;
    tools: ToolRegistry;
    hooks: HookRegistry;
    logger: Logger;
    config: ConfigManager;
    parent?: Context;
  }) {
    this.id = options.id;
    this._events = options.events;
    this._services = options.services;
    this.tools = options.tools;
    this.hooks = options.hooks;
    this.logger = options.logger;
    this.config = options.config;
    this._parent = options.parent;
  }

  /**
   * 创建子上下文（通常为每个插件创建一个）
   */
  fork(id: string): Context {
    const child = new Context({
      id,
      events: this._events,
      services: this._services,
      tools: this.tools,
      hooks: this.hooks,
      logger: this.logger.child(id),
      config: this.config,
      parent: this,
    });
    this._children.add(child);
    return child;
  }

  // ---- 事件 ----

  on<E extends keyof AalisEvents>(
    event: E,
    handler: EventHandler<AalisEvents[E]>,
  ): () => void {
    const dispose = this._events.on(event, handler);
    this._disposables.push(dispose);
    return dispose;
  }

  once<E extends keyof AalisEvents>(
    event: E,
    handler: EventHandler<AalisEvents[E]>,
  ): () => void {
    const dispose = this._events.once(event, handler);
    this._disposables.push(dispose);
    return dispose;
  }

  emit<E extends keyof AalisEvents>(
    event: E,
    ...args: AalisEvents[E]
  ): Promise<void> {
    return this._events.emit(event, ...args);
  }

  // ---- 服务 (IoC + 能力声明) ----

  /**
   * 注册服务
   */
  provide(
    name: string,
    instance: unknown,
    options?: { capabilities?: string[]; priority?: number },
  ): void {
    this._services.register(
      name,
      instance,
      options?.capabilities ?? [],
      options?.priority ?? 0,
      this.id,
    );
    this._disposables.push(() => {
      // 清理时按 contextId 移除
      this._services.unregisterByContext(this.id);
    });

    const caps = options?.capabilities ?? [];
    this._events.emit('service:registered', name, caps).catch(() => {});
    this.logger.debug(`服务已注册: ${name}${caps.length ? ` [${caps.join(', ')}]` : ''}`);
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

  // ---- 工具 ----

  /**
   * 注册 AI 工具（便捷方法）
   */
  registerTool(tool: Omit<RegisteredTool, 'pluginName'>): () => void {
    const dispose = this.tools.register(tool, this.id);
    this._disposables.push(dispose);
    return dispose;
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
  middleware<K extends keyof HookContextMap>(
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

    // 逆序执行清理
    for (let i = this._disposables.length - 1; i >= 0; i--) {
      try {
        this._disposables[i]();
      } catch {
        // 忽略清理错误
      }
    }
    this._disposables = [];

    // 清理该上下文注册的钩子
    this.hooks.unregisterByContext(this.id);

    // 从父上下文中移除
    if (this._parent) {
      this._parent._children.delete(this);
    }
  }
}
