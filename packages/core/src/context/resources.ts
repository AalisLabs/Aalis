import { awaitWithTimeout, reportQuietly } from '../kernel/disposable-chain.js';
import { Lifecycle } from '../kernel/lifecycle.js';

import type { Logger } from './logger.js';

/** Resource ownership for one activation; it has no knowledge of services or plugin scheduling. */
export class Resources {
  readonly lifecycle: Lifecycle;
  readonly #inflight = new Map<Promise<void>, string>();
  #operations = 0;
  #operationsDone?: Promise<void>;
  #finishOperations?: () => void;

  constructor(
    private readonly id: string,
    private readonly logger: Logger,
    options: { beforeCleanup?: () => void; afterCleanup?: () => void } = {},
  ) {
    this.lifecycle = new Lifecycle(
      {
        ...options,
        settlePhase: timeoutMs =>
          this.#operations === 0 && this.#inflight.size === 0 ? undefined : this.#settle(timeoutMs),
        onTimeout: (phase, timeoutMs) =>
          reportQuietly(() =>
            logger.warn(
              phase === 'initialization'
                ? `Resources "${id}": 等待初始化落定超过 ${timeoutMs}ms，放弃等待并继续拆卸`
                : `Resources "${id}": 等待在飞拆卸超过 ${timeoutMs}ms，放弃等待`,
            ),
          ),
        onError: error => reportQuietly(() => logger.error('dispose 收尾异常:', error)),
      },
      logger,
    );
  }

  /**
   * Cover the synchronous acquisition and receipt of its cleanup handle. A callback can start closing
   * before returning that handle; phase completion must then wait for this stack to unwind. Normal
   * operations only adjust a counter. A wait signal is allocated only when closing overlaps a run.
   * This does not track a Promise returned by fn: asynchronous work must use holdInflight explicitly.
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

  /** Already-started asynchronous cleanup is observed once and awaited at the next phase boundary. */
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
      this.lifecycle.disposables.remove(dispose);
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

  /** Binding withdrawal belongs before user cleanup. Its return value is passed through to Lifecycle. */
  trackWithdrawal(off: () => unknown, label?: string): () => unknown {
    const dispose = (): unknown => {
      this.lifecycle.disposables.remove(dispose);
      return off();
    };
    this.lifecycle.disposables.push(dispose, label, 'withdraw');
    return dispose;
  }

  onDispose(fn: () => void | Promise<void>, label?: string): () => void {
    if (this.lifecycle.disposed) {
      if (this.lifecycle.disposables.disposed) {
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
    // A distinct wrapper per registration makes cancellation independent even for the same callback.
    const entry = () => fn();
    this.lifecycle.disposables.push(entry, label);
    return () => this.lifecycle.disposables.remove(entry);
  }

  onDrain(fn: () => void | Promise<void>, label?: string): () => void {
    const entry = () => fn();
    this.lifecycle.draining.push(entry, label);
    return () => this.lifecycle.draining.remove(entry);
  }
}
