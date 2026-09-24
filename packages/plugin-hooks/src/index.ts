// ============================================================
// @aalis/plugin-hooks — hooks 服务的默认提供者
//
// 归属与撤回由绑定门面的账本负责：激活关闭时账本与事件、服务登记同一拍撤回，本表只按条目身份删除。
// ============================================================

import { type HookRegistry, hooks, type MiddlewareFn, type MiddlewareNext, type RunOptions } from '@aalis/api-hooks';
import { definePlugin, logger, provide } from '@aalis/core';

interface Entry {
  readonly fn: MiddlewareFn<unknown>;
  /** 逻辑身份，供卡链诊断点名 */
  readonly contextId: string;
  /** 登记序，链按它升序排列 */
  readonly order: number;
}

export class Registry implements HookRegistry {
  readonly #chains = new Map<string, Entry[]>();

  /** @param onStall 广播型相位的卡链上报；缺省不报 */
  constructor(private readonly onStall?: (hook: string, contextId: string, skipped: number) => void) {}

  register(hook: string, fn: MiddlewareFn<unknown>, contextId: string, order: number): () => void {
    let list = this.#chains.get(hook);
    if (!list) {
      list = [];
      this.#chains.set(hook, list);
    }
    const entry: Entry = { fn, contextId, order };
    // 按登记序插入：平常是新号追加到链尾；换提供者时账本整批重挂，靠它还原原来的交错次序
    let at = list.length;
    while (at > 0 && list[at - 1].order > order) at--;
    list.splice(at, 0, entry);
    return () => {
      // 查当前数组而非闭包捕获的 list：链清空时表项被删，再登记会新建数组
      const current = this.#chains.get(hook);
      const index = current?.indexOf(entry) ?? -1;
      if (!current || index < 0) return;
      current.splice(index, 1);
      if (current.length === 0) this.#chains.delete(hook);
    };
  }

  async run(hook: string, data: unknown, defaultAction?: () => Promise<void>, opts?: RunOptions): Promise<boolean> {
    // 快照：handler 执行中登记 / 退订不扰动本次遍历的游标
    const snapshot = [...(this.#chains.get(hook) ?? [])];
    let index = 0;
    let reachedEnd = false;
    const next: MiddlewareNext = async () => {
      while (index < snapshot.length) {
        const entry = snapshot[index++];
        // 运行途中已撤回的 handler 跳过
        if (!this.#chains.get(hook)?.includes(entry)) continue;
        const before = index;
        await entry.fn(data, next);
        // 游标没动过 = 它没调 next()，其后的 handler 被静默跳过——广播型相位点名肇事者
        if (opts?.warnOnStall && index === before && index < snapshot.length) {
          try {
            this.onStall?.(hook, entry.contextId, snapshot.length - index);
          } catch {
            // 上报失败不影响主流程
          }
        }
        return;
      }
      reachedEnd = true;
      if (defaultAction) await defaultAction();
    };
    await next();
    return reachedEnd;
  }
}

export default definePlugin({
  name: '@aalis/plugin-hooks',
  displayName: '钩子',
  subsystem: 'core',
  provides: [hooks],
  uses: { provide, logger },
  apply({ provide, logger }) {
    provide(
      hooks,
      new Registry((hook, contextId, skipped) =>
        logger.warn(`钩子 ${hook}: handler(来自 ${contextId}) 未调用 next()，其后 ${skipped} 个 handler 被跳过`),
      ),
    );
  },
});
