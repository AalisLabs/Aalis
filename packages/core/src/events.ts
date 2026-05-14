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
   * 一次性事件（sticky）：emit 后保留最近一次参数；后续 on/once 监听该事件时
   * 立即用缓存参数同步触发回调。用于"应用生命周期里只发一次的里程碑事件"
   * （目前是 'ready'），让被热重载的插件在 reactivate 后仍能拿到 ready 通知。
   *
   * - 注册：`markSticky('ready')` 由 App 在构造时调用
   * - 清除：`clearSticky('ready')` 由 App 在 dispose / 重启时调用
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
        if (set?.has(handler)) {
          void handler(...args);
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
   * 触发事件，按注册顺序依次调用，支持异步 handler
   */
  async emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void> {
    if (this.stickyEvents.has(event)) {
      this.stickyArgs.set(event, args);
    }
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      await handler(...args);
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
