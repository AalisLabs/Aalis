import type { HookContextMap, MiddlewareFn, MiddlewareNext } from './types/index.js';

interface HookEntry<T> {
  fn: MiddlewareFn<T>;
  contextId: string;
}

/**
 * 钩子注册表 —— 命名生命周期事件的 handler 总线
 *
 * 设计哲学：每个钩子键代表一个 **语义清晰的生命周期事件**（例如
 * `inbound:command` / `inbound:flow` / `agent:llm:before`），handler
 * 在事件内部按 **注册顺序** 串行执行洋葱模型 (Koa-style next)。
 *
 * 不再使用数字 priority：相位之间的次序由调度方（plugin-gateway 等）
 * 显式表达；相位内部的 handler 应顺序无关，或由相位拥有方约定。
 *
 * 插件通过 `ctx.middleware(hook, fn)` 注册 handler。
 * 服务在关键流程点执行 `hooks.run(hook, data, defaultAction)`。
 *
 * Handler 可以：
 * - 修改 data 对象（引用传递）
 * - 调用 next() 继续管道
 * - 不调用 next() 来中断流程（包括 defaultAction）—— 标准的"已处理"信号
 *
 * 第三方插件可通过 TS declaration merging 扩展 HookContextMap。
 */
export class HookRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: 泛型擦除场景，hooks 容器持有不同钩子键的 entry，运行时按 key 分发
  private hooks = new Map<string, HookEntry<any>[]>();

  /**
   * 注册 handler，返回 dispose 函数。
   * 同一钩子键内的多个 handler 按注册顺序执行。
   */
  register<K extends string & keyof HookContextMap>(
    hook: K,
    fn: MiddlewareFn<HookContextMap[K]>,
    contextId: string = 'root',
  ): () => void {
    let list = this.hooks.get(hook);
    if (!list) {
      list = [];
      this.hooks.set(hook, list);
    }
    const entry: HookEntry<HookContextMap[K]> = { fn, contextId };
    list.push(entry);

    return () => {
      const idx = list!.indexOf(entry);
      if (idx >= 0) list!.splice(idx, 1);
    };
  }

  /**
   * 执行钩子链
   *
   * Handler 不调用 next() 即可中断整个管道（包括 defaultAction）。
   * 这是拦截/跳过的标准手段，无需额外的 skip 标志。
   *
   * 返回 `true` 表示链路完整走完（执行了 defaultAction，或本就没有 handler）；
   * 返回 `false` 表示被某个 handler swallow。
   * 调度方（如 plugin-gateway 多相位调度）可据此决定是否进入后续相位。
   *
   * @param hook - 钩子键（命名生命周期事件）
   * @param data - 传递给 handler 的数据对象（会被 handler 修改）
   * @param defaultAction - 所有 handler 都 next() 通过后的默认操作
   */
  async run<K extends string & keyof HookContextMap>(
    hook: K,
    data: HookContextMap[K],
    defaultAction?: () => Promise<void>,
  ): Promise<boolean> {
    const list = this.hooks.get(hook) ?? [];
    let index = 0;
    let reachedEnd = false;

    const next: MiddlewareNext = async () => {
      if (index < list.length) {
        const entry = list[index++];
        await entry.fn(data, next);
      } else {
        reachedEnd = true;
        if (defaultAction) await defaultAction();
      }
    };

    await next();
    return reachedEnd;
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
