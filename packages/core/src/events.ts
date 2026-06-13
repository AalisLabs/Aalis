import type { AalisEvents } from './types/index.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/**
 * 类型安全的事件总线
 *
 * 内置事件使用 AalisEvents 接口提供类型推导。
 * 第三方插件可以通过 TS declaration merging 扩展 AalisEvents，
 * 也可以使用任意字符串 key 注册/触发自定义事件（运行时安全）。
 */
export class EventBus {
  // biome-ignore lint/suspicious/noExplicitAny: 泛型擦除场景，handlers 容器持有不同事件类型，运行时按事件名分发
  private handlers = new Map<string, Set<EventHandler<any>>>();

  /**
   * handler 抛错时的上报回调（含 sticky 补发路径的同步/异步抛错）。
   *
   * EventBus 自身不依赖 Logger（保持环境无关）；宿主（App）在构造后
   * 注入一个指向自己 logger 的上报器。未设置时错误被静默丢弃——
   * 但无论是否设置，单个 handler 抛错都**不会**中断同事件的其余 handler，
   * 也不会使 emit reject。
   */
  onHandlerError?: (event: string, error: unknown) => void;

  private reportHandlerError(event: string, error: unknown): void {
    try {
      // onHandlerError 签名为 void，但运行时可能返回 promise（如异步 logger 实现）。
      // 同步抛错被 catch；异步 rejection 单独吞掉，避免逃逸成 unhandledRejection（审计 #4）。
      const ret = this.onHandlerError?.(event, error) as unknown;
      if (ret && typeof (ret as { then?: unknown }).then === 'function') {
        (ret as Promise<unknown>).catch(() => {});
      }
    } catch {
      /* 上报器自身抛错不再向外传播 */
    }
  }

  /**
   * 一次性事件（sticky）：emit 后保留最近一次参数；后续 on/once 监听该事件时
   * 立即用缓存参数同步触发回调。用于"应用生命周期里只发一次的里程碑事件"，
   * 让被热重载的插件在 reactivate 后仍能拿到启动通知。
   * 当前标记为 sticky 的事件：'ready'、'app:started'。
   *
   * - 注册：`markSticky(event)` 由 App 在构造时调用
   * - 清除：`clearSticky(event)` 由 App.restart()/stop() 在复用实例时调用，
   *   避免下一轮启动时被旧的 sticky 参数误触发
   */
  // biome-ignore lint/suspicious/noExplicitAny: 同上
  private stickyArgs = new Map<string, any[]>();
  private stickyEvents = new Set<string>();

  markSticky(event: string): void {
    this.stickyEvents.add(event);
  }

  clearSticky(event?: string): void {
    if (event) {
      this.stickyArgs.delete(event);
    } else {
      this.stickyArgs.clear();
    }
  }

  /**
   * 监听事件，返回 dispose 函数
   *
   * 若该事件已被标记为 sticky 且历史上 emit 过，则在下一个微任务里
   * 立即用缓存的参数调用 handler 一次（保证语义同步：调用方注册完返回后
   * 再触发，避免 handler 内部的 await 影响调用方流程）。
   */
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);

    if (this.stickyEvents.has(event) && this.stickyArgs.has(event)) {
      const args = this.stickyArgs.get(event) as AalisEvents[E];
      queueMicrotask(() => {
        // 注册可能在微任务执行前被立即 dispose；此时跳过补发
        if (!set?.has(handler)) return;
        // 补发没有 emit 调用方兜底——handler 同步抛错会直达 uncaughtException
        // 崩进程，异步抛错变 unhandledRejection，必须就地捕获。
        try {
          const ret = handler(...args);
          if (ret && typeof (ret as Promise<void>).then === 'function') {
            (ret as Promise<void>).catch(err => this.reportHandlerError(event, err));
          }
        } catch (err) {
          this.reportHandlerError(event, err);
        }
      });
    }

    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(event);
    };
  }

  /**
   * 监听事件一次
   */
  once<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void {
    const wrapper: EventHandler<AalisEvents[E]> = (...args) => {
      dispose();
      return handler(...args);
    };
    const dispose = this.on(event, wrapper);
    return dispose;
  }

  /**
   * 触发事件，按注册顺序依次调用，支持异步 handler。
   *
   * Per-handler 隔离：单个 handler 抛错（同步或异步）只影响它自己——
   * 错误经 {@link onHandlerError} 上报，其余 handler 照常执行，emit 始终 resolve。
   * 事件是"通知多方"语义，一个旁观者失败不该连坐其他订阅者，更不该
   * 反向把失败传染给发射方（如 plugin:loaded 的 emit 不能把刚激活成功的
   * 插件打成 error 终态）。
   */
  async emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void> {
    if (this.stickyEvents.has(event)) {
      this.stickyArgs.set(event, args);
    }
    const set = this.handlers.get(event);
    if (!set) return;
    // 直接迭代活 Set：handler 中 dispose 尚未访问的条目会被正确跳过（Set 迭代语义）
    for (const handler of set) {
      try {
        await handler(...args);
      } catch (err) {
        this.reportHandlerError(event, err);
      }
    }
  }

  /**
   * 移除指定事件的所有监听器
   */
  removeAll(event?: string): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}
