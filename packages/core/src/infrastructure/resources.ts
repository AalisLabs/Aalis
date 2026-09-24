import { awaitWithTimeout, DisposableChain, reportQuietly } from '../kernel/disposable-chain.js';

import type { Logger } from './logger.js';

/**
 * 一次激活的资源账与关闭过程；不了解服务、事件或插件调度。
 * disposed 表示已开始关闭；disposables.disposed 表示清理链已被取走。两者之间仍允许登记，
 * 以接住初始化期间迟到的资源。
 */
export class Resources {
  readonly disposables: DisposableChain;
  /** 收尾段：默认在撤回前执行；编排者可用 drain() 提前执行。 */
  readonly draining: DisposableChain;
  readonly #inflight = new Map<Promise<void>, string>();
  #operations = 0;
  #operationsDone?: Promise<void>;
  #finishOperations?: () => void;
  #closing = false;
  #drained?: Promise<void>;
  #completion?: Promise<void>;
  #initialization?: Promise<void>;
  readonly #cuts = new Set<() => void>();

  constructor(
    private readonly id: string,
    private readonly logger: Logger,
    /**
     * beforeCleanup：收尾之后、清理链之前撤回宿主对外暴露的资源（同步）；afterWithdraw：撤回之后、清理链
     * 之前等下游对已撤回资源的交接落定（返回待等的 Promise，没有则 undefined）；afterCleanup：清理链之后收尾（同步）。
     */
    private readonly hooks: {
      beforeCleanup?: () => void;
      afterWithdraw?: () => Promise<unknown> | undefined;
      afterCleanup?: () => void;
    } = {},
  ) {
    const settle = (timeoutMs?: number) =>
      this.#operations === 0 && this.#inflight.size === 0 ? undefined : this.#settle(timeoutMs);
    this.disposables = new DisposableChain(logger, settle);
    this.draining = new DisposableChain(logger, settle);
  }

  /** 已开始关闭 */
  get disposed(): boolean {
    return this.#closing;
  }

  #timeout(what: string): (limit: number) => void {
    return limit => reportQuietly(() => this.logger.warn(`Resources "${this.id}": ${what}超过 ${limit}ms，放弃等待`));
  }

  /**
   * 跟踪宿主的一次初始化。失败由宿主处理，关闭只等待它落定。
   * 至多 track 一次：再次调用会覆盖前一次，前一次不再被等待——调用方保证。
   */
  trackInitialization(initializing: Promise<unknown>): void {
    const settled = initializing.then(
      () => {},
      () => {},
    );
    this.#initialization = settled;
    settled.then(() => {
      if (this.#initialization === settled) this.#initialization = undefined;
    });
  }

  /**
   * 登记一个切断项：与 beforeCleanup 同栈、在等下游交接之前同步执行，用于撤掉本激活登记到别处、
   * 对外可见的条目。异步部分由执行方自行记账，本段不等。
   */
  onCut(cut: () => void): void {
    this.#cuts.add(cut);
  }

  /** 只置关闭位：此后不再接新登记；收尾、撤回与清理由后续调用执行。 */
  markClosing(): void {
    this.#closing = true;
  }

  /**
   * 提前执行收尾段（幂等）：置关闭位、等初始化落定、排空收尾链。撤回与清理不在此列——
   * 编排层据此把「谁先收尾」与「谁先撤回」分开安排；不调用它时 disposeAsync 照旧自己收尾。
   * 没有待等的东西时同栈完成、返回 undefined。
   */
  drain(timeoutMs?: number): Promise<void> | undefined {
    if (this.#drained) return this.#drained;
    this.#closing = true;
    if (!this.#initialization && this.draining.size === 0) {
      this.draining.dispose();
      return undefined;
    }
    this.#drained = (async () => {
      if (this.#initialization)
        await awaitWithTimeout(this.#initialization, timeoutMs, this.#timeout('等待初始化落定'));
      await this.draining.disposeAsync(timeoutMs);
    })();
    return this.#drained;
  }

  async disposeAsync(timeoutMs?: number): Promise<void> {
    if (this.#completion) {
      await awaitWithTimeout(this.#completion, timeoutMs, this.#timeout('等待在飞拆卸'));
      return;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    // 必须先发布完成对象，再同栈执行 teardown：清理回调可以重入关闭并注册观察者。
    this.#completion = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.#teardown(timeoutMs).then(resolve, reject);
    await this.#completion;
  }

  async #teardown(timeoutMs?: number): Promise<void> {
    // 收尾段（等初始化、排空收尾链）已由编排者提前执行时只等它，不再等第二遍初始化。
    // 没有收尾项时不得多让出一拍：撤回一向与 disposeAsync() 同栈发起；没有待等的下游交接时，清理的首个回调也同栈
    const drained = this.drain(timeoutMs);
    if (drained) await drained;
    this.hooks.beforeCleanup?.();
    for (const cut of this.#cuts) cut();
    const handover = this.hooks.afterWithdraw?.();
    if (handover) await awaitWithTimeout(handover, timeoutMs, this.#timeout('等待下游交接'));
    await this.disposables.disposeAsync(timeoutMs);
    this.hooks.afterCleanup?.();
  }

  /**
   * 覆盖「同步取得资源并拿到它的清理句柄」这一段：回调可以在返回句柄之前就开始关闭，段收口须等本栈
   * 展开。平时只计数；关闭与 run 重叠时才分配等待信号。不追踪 fn 返回的 Promise：异步工作须显式
   * holdInflight。
   */
  run<T>(fn: () => T): T {
    this.#operations++;
    try {
      return fn();
    } finally {
      if (--this.#operations === 0) {
        const finish = this.#finishOperations;
        this.#finishOperations = undefined;
        this.#operationsDone = undefined;
        finish?.();
      }
    }
  }

  /** 已发起的异步清理只观察一次，在下一段收口时等待。 */
  holdInflight(work: PromiseLike<unknown>, what: string): void {
    const settled: Promise<void> = Promise.resolve(work)
      .then(
        () => undefined,
        error => reportQuietly(() => this.logger.warn(`${what} 撤回拒绝（已忽略）:`, error)),
      )
      .then(() => {
        this.#inflight.delete(settled);
      });
    this.#inflight.set(settled, what);
  }

  async #settle(timeoutMs?: number): Promise<void> {
    while (this.#operations > 0 || this.#inflight.size > 0) {
      if (this.#operations > 0) {
        this.#operationsDone ??= new Promise<void>(resolve => {
          this.#finishOperations = resolve;
        });
        await this.#operationsDone;
      }
      const batch = [...this.#inflight];
      if (batch.length === 0) continue;
      await awaitWithTimeout(Promise.all(batch.map(([work]) => work)), timeoutMs, limit => {
        for (const [work, what] of batch) {
          if (!this.#inflight.delete(work)) continue;
          reportQuietly(() => this.logger.warn(`Resources "${this.id}": 等待 ${what} 的撤回超过 ${limit}ms，放弃等待`));
        }
      });
    }
  }

  /** 一次性撤回；手动开始的异步清理也纳入这次激活的关闭。 */
  track(off: () => unknown, label = 'resource'): () => void {
    let started = false;
    let result: PromiseLike<unknown> | undefined;
    const run = (): PromiseLike<unknown> | undefined => {
      if (!started) {
        started = true;
        result = this.withdraw(off, label);
      }
      return result;
    };
    const dispose = this.trackWithdrawal(run, label);
    return () => {
      if (started) return;
      this.disposables.remove(dispose);
      run();
    };
  }

  /** 清理异常就地隔离；异步拒绝被观察，并在相位边界等待。 */
  withdraw(off: () => unknown, label: string): PromiseLike<unknown> | undefined {
    return this.run(() => {
      try {
        const result = off();
        if (typeof (result as PromiseLike<unknown> | undefined)?.then !== 'function') return undefined;
        const pending = Promise.resolve(result);
        this.holdInflight(pending, label);
        return pending;
      } catch (error) {
        reportQuietly(() => this.logger.warn(`${label} 撤回抛错（已忽略）:`, error));
        return undefined;
      }
    });
  }

  /** 绑定撤回排在用户清理之前（撤回段）；返回值原样交给清理链等待。 */
  trackWithdrawal(off: () => unknown, label?: string): () => unknown {
    const dispose = (): unknown => {
      this.disposables.remove(dispose);
      return off();
    };
    this.disposables.push(dispose, label, 'withdraw');
    return dispose;
  }

  onDispose(fn: () => void | Promise<void>, label?: string): () => void {
    if (this.disposed) {
      if (this.disposables.disposed) {
        reportQuietly(() =>
          this.logger.warn(`Resources "${this.id}" 已 dispose，onDispose${label ? `("${label}")` : ''} 将就地执行`),
        );
      } else {
        reportQuietly(() =>
          this.logger.debug(
            `Resources "${this.id}" 拆卸进行中，onDispose${label ? `("${label}")` : ''} 纳入本次清理链`,
          ),
        );
      }
    }
    // 每次登记一个独立包装：同一个回调登记两次也能各自取消
    const entry = () => fn();
    this.disposables.push(entry, label);
    return () => this.disposables.remove(entry);
  }

  onDrain(fn: () => void | Promise<void>, label?: string): () => void {
    const entry = () => fn();
    this.draining.push(entry, label);
    return () => this.draining.remove(entry);
  }
}
