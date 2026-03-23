import type { AalisEvents } from './types.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/**
 * 类型安全的事件总线
 * 支持注册/移除监听器，以及返回 dispose 函数用于自动清理
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler<any>>>();

  /**
   * 监听事件，返回 dispose 函数
   */
  on<E extends keyof AalisEvents>(
    event: E,
    handler: EventHandler<AalisEvents[E]>,
  ): () => void {
    let set = this.handlers.get(event as string);
    if (!set) {
      set = new Set();
      this.handlers.set(event as string, set);
    }
    set.add(handler);

    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(event as string);
    };
  }

  /**
   * 监听事件一次
   */
  once<E extends keyof AalisEvents>(
    event: E,
    handler: EventHandler<AalisEvents[E]>,
  ): () => void {
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
  async emit<E extends keyof AalisEvents>(
    event: E,
    ...args: AalisEvents[E]
  ): Promise<void> {
    const set = this.handlers.get(event as string);
    if (!set) return;
    for (const handler of set) {
      await handler(...args);
    }
  }

  /**
   * 移除指定事件的所有监听器
   */
  removeAll(event?: keyof AalisEvents): void {
    if (event) {
      this.handlers.delete(event as string);
    } else {
      this.handlers.clear();
    }
  }
}
