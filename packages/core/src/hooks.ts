import type { HookContextMap, MiddlewareFn, MiddlewareNext } from './types.js';

interface HookEntry<T> {
  fn: MiddlewareFn<T>;
  priority: number;
  contextId: string;
}

/**
 * 钩子注册表 —— 管理中间件管道
 *
 * 插件通过 ctx.middleware(hook, fn) 注册中间件。
 * Agent 在关键流程点执行 hooks.run(hook, data, defaultAction)。
 *
 * 中间件按优先级排序（数字越大越先执行），可以：
 * - 修改 data 对象（引用传递）
 * - 调用 next() 继续管道
 * - 不调用 next() 来中断流程（包括 defaultAction）
 *
 * 第三方插件可通过 TS declaration merging 扩展 HookContextMap，
 * 也可以使用任意字符串 key（运行时安全）。
 */
export class HookRegistry {
  private hooks = new Map<string, HookEntry<any>[]>();

  /**
   * 注册中间件，返回 dispose 函数
   */
  register<K extends string & keyof HookContextMap>(
    hook: K,
    fn: MiddlewareFn<HookContextMap[K]>,
    priority: number = 0,
    contextId: string = 'root',
  ): () => void {
    let list = this.hooks.get(hook);
    if (!list) {
      list = [];
      this.hooks.set(hook, list);
    }
    const entry: HookEntry<HookContextMap[K]> = { fn, priority, contextId };
    list.push(entry);
    // 按优先级降序排列
    list.sort((a, b) => b.priority - a.priority);

    return () => {
      const idx = list!.indexOf(entry);
      if (idx >= 0) list!.splice(idx, 1);
    };
  }

  /**
   * 执行中间件管道
   *
   * 中间件不调用 next() 即可中断整个管道（包括 defaultAction）。
   * 这是拦截/跳过的标准手段，无需额外的 skip 标志。
   *
   * @param hook - 钩子名称
   * @param data - 传递给中间件的数据对象（会被中间件修改）
   * @param defaultAction - 所有中间件通过后的默认操作
   */
  async run<K extends string & keyof HookContextMap>(
    hook: K,
    data: HookContextMap[K],
    defaultAction?: () => Promise<void>,
  ): Promise<void> {
    const list = this.hooks.get(hook) ?? [];
    let index = 0;

    const next: MiddlewareNext = async () => {
      if (index < list.length) {
        const entry = list[index++];
        await entry.fn(data, next);
      } else if (defaultAction) {
        await defaultAction();
      }
    };

    await next();
  }

  /**
   * 按 contextId 移除所有中间件
   */
  unregisterByContext(contextId: string): void {
    for (const [hook, list] of this.hooks) {
      const filtered = list.filter(e => e.contextId !== contextId);
      if (filtered.length === 0) {
        this.hooks.delete(hook);
      } else {
        this.hooks.set(hook, filtered);
      }
    }
  }
}
