import type { AalisEvents, EventArgs } from '../types/events.js';

import { reportQuietly } from '../kernel/disposable-chain.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

interface EventEntry {
  // biome-ignore lint/suspicious/noExplicitAny: 泛型擦除场景，同一集合持有不同事件类型的 handler
  handler: EventHandler<any>;
  /** 清理归属（见 ServiceEntry.owner）；无则不被拆卸自动清理 */
  owner?: symbol;
}

/** 宿主（App）在构造时注入的回调；EventBus 自身不持有 Logger（保持环境无关） */
interface EventBusOptions {
  /**
   * handler 抛错时的上报回调。未设置时错误被静默丢弃——但无论是否设置，单个 handler 抛错都**不会**中断同事件的其余
   * handler，也不会使 emit reject。第三参点名注册者的逻辑身份（owner symbol 的 description，events 能力注册时即激活 id；
   * 不经门面、无 owner 的登记为 undefined）。
   */
  onHandlerError?: (event: string, error: unknown, contextId?: string) => void;
}

/**
 * 类型安全的事件总线
 *
 * 事件名须先经 TS declaration merging 并入 AalisEvents（未声明的事件名编译报错）；
 * 运行时动态生成的事件名在自己的命名空间内合并模板字面量签名（见 docs/core/events.md）。
 */
export class EventBus {
  // 事件名 → 登记集合。每次 on 一条登记：同一函数被两个激活（或同一激活两次）登记
  // 互不相干，各自退订、各自清理——按函数去重会让后登记者顶掉先登记者的归属，先登记者的退订
  // 再删掉后登记者。归属是注册方本次激活的 symbol，让拆卸的注销段能与
  // services 同点整体切断（unregisterByOwner）；直接使用总线的无主
  // handler（owner=undefined）不受切断影响，由调用方自管。
  #handlers = new Map<string, Set<EventEntry>>();
  readonly #options: EventBusOptions;

  constructor(options: EventBusOptions = {}) {
    this.#options = options;
  }

  #reportHandlerError(event: string, error: unknown, owner?: symbol): void {
    reportQuietly(() => this.#options.onHandlerError?.(event, error, owner?.description));
  }

  /**
   * 监听事件，返回 dispose 函数。
   * @param owner 清理归属（events 能力传入）；省略则不被拆卸自动清理，用返回的 dispose 自管。
   */
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<EventArgs<E>>, owner?: symbol): () => void {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    const entry: EventEntry = { handler, owner };
    set.add(entry);

    return () => {
      set!.delete(entry);
      // 身份卫：本闭包捕获的是注册时刻的那张表。若事件键已被整体清掉又被
      // 他人重建（unregisterByOwner 扫空 → 新注册进新表），按键盲删会误杀
      // 新注册者的整张表——只有当前挂的仍是自己那张时才清空键。
      if (set!.size === 0 && this.#handlers.get(event) === set) this.#handlers.delete(event);
    };
  }

  /**
   * 整体移除某激活归属的全部监听——ActivationHost 接入拆卸的注销段调用，
   * 与 services 及归属表同点切断（半拆状态不外露：异步排空窗口内本插件
   * 的 handler 不得再响应事件）。链上残留的退订闭包迟到执行时靠 off 的
   * 身份卫保持无害。
   * @internal
   */
  unregisterByOwner(owner: symbol): void {
    for (const [event, set] of this.#handlers) {
      for (const entry of set) {
        if (entry.owner === owner) set.delete(entry);
      }
      if (set.size === 0) this.#handlers.delete(event);
    }
  }

  /**
   * 触发事件，按注册顺序依次调用，支持异步 handler。
   *
   * Per-handler 隔离：单个 handler 抛错（同步或异步）只影响它自己——
   * 错误经 onHandlerError 上报，其余 handler 照常执行，emit 始终 resolve。
   * 事件是"通知多方"语义，一个旁观者失败不该连坐其他订阅者，更不该反向把失败传染给发射方。
   */
  async emit<E extends string & keyof AalisEvents>(event: E, ...args: EventArgs<E>): Promise<void> {
    const set = this.#handlers.get(event);
    if (!set) return;
    // 只送达派发开始时已登记的：途中新登记的不收这一次，处理时退订又重登的不会被这次 emit 一直再调；途中退订的跳过
    for (const entry of [...set]) {
      if (!set.has(entry)) continue;
      try {
        await entry.handler(...args);
      } catch (err) {
        this.#reportHandlerError(event, err, entry.owner);
      }
    }
  }
}
