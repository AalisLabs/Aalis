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
  private handlers = new Map<string, Set<EventHandler<any>>>();

  /**
   * 监听事件，返回 dispose 函数
   */
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);

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
