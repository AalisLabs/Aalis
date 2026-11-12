// ============================================================
// @aalis/plugin-events — events 服务的默认提供者
//
// 归属与撤回由绑定门面的归属表负责：激活关闭时归属表与服务登记同一拍撤回，本表只按条目身份删除。
// ============================================================

import { type EventBus, type EventHandler, events } from '@aalis/api-events';
import { definePlugin, type Logger, logger, provide } from '@aalis/core';
import { t } from './texts.js';

interface Entry {
  readonly handler: EventHandler<unknown[]>;
  /** 逻辑身份，监听器抛错时点名 */
  readonly contextId: string;
  /** 登记序 */
  readonly order: number;
  /** 登记方的位次：监听器表先按它的码元序排，同一位次按登记序 */
  readonly seat: string;
}

export class Bus implements EventBus {
  readonly #listeners = new Map<string, Entry[]>();

  /** @param logger 监听器抛错记在它上面，点名事件与登记方；缺省不记 */
  constructor(private readonly logger?: Pick<Logger, 'warn'>) {}

  on(event: string, handler: EventHandler<unknown[]>, contextId: string, order: number, seat: string): () => void {
    const existing = this.#listeners.get(event);
    const list = existing ?? [];
    if (!existing) this.#listeners.set(event, list);
    const entry: Entry = { handler, contextId, order, seat };
    // 按（位次，登记序）插入：插件重启后新号落回它自己的位次里；换提供者时归属表整批重挂，靠它还原原来的次序
    let at = list.length;
    while (at > 0 && (list[at - 1].seat > seat || (list[at - 1].seat === seat && list[at - 1].order > order))) at--;
    list.splice(at, 0, entry);
    return () => {
      // 一张表只在清空的那一刻离开 #listeners：entry 还在 list 里时，list 就是该事件当前的那张表
      const index = list.indexOf(entry);
      if (index < 0) return;
      list.splice(index, 1);
      // 清空即删表项：动态生成的事件名不留空表
      if (list.length === 0) this.#listeners.delete(event);
    };
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    // 快照：只送达派发开始时已登记的。途中新登记的不收这一次，处理时退订又重登的不会被这次 emit 一直再调
    for (const entry of [...(this.#listeners.get(event) ?? [])]) {
      // 途中已退订的跳过
      if (!this.#listeners.get(event)?.includes(entry)) continue;
      try {
        await entry.handler(...args);
      } catch (error) {
        // 事件是通知多方：一个监听器失败不连带其他监听器，也不传给发射方
        try {
          this.logger?.warn(`事件 "${event}" 的监听器抛错（已隔离，来自 ${entry.contextId}）:`, error);
        } catch {
          // 记录失败不影响派发
        }
      }
    }
  }
}

export default definePlugin({
  name: '@aalis/plugin-events',
  displayName: t('displayName'),
  subsystem: 'core',
  provides: [events],
  uses: { provide, logger },
  apply({ provide, logger }) {
    provide.use(events, new Bus(logger.use));
  },
});
