import { awaitWithTimeout, type CleanupReporter, DisposableChain } from './disposable-chain.js';

interface LifecycleOptions {
  /** 收尾之后、清理链开始前，撤回宿主对外暴露的资源。 */
  beforeCleanup?: () => void;
  /** 清理链结束后执行宿主收尾；两个阶段回调均为同步操作。 */
  afterCleanup?: () => void;
  /** 清理链每排空一段后调用：返回该段内发起、尚未落定的异步清理，链会等它（见 DisposableChain）。 */
  settlePhase?: (timeoutMs?: number) => Promise<unknown> | undefined;
  onTimeout?: (phase: 'initialization' | 'disposal', timeoutMs: number) => void;
}

/**
 * 内部资源生命周期。不了解服务、事件、配置或插件调度。
 * disposed 表示已开始关闭；disposables.disposed 表示清理链已被取走。
 * 两者之间仍允许登记清理，以接住初始化期间迟到的资源。
 */
export class Lifecycle {
  readonly disposables: DisposableChain;
  /** 收尾段：默认在宿主撤回前执行；编排者可用 drain() 提前执行。 */
  readonly draining: DisposableChain;
  private closing = false;
  private drained?: Promise<void>;
  private completion?: Promise<void>;
  private initialization?: Promise<void>;

  constructor(
    private readonly options: LifecycleOptions = {},
    reporter?: CleanupReporter,
  ) {
    this.disposables = new DisposableChain(reporter, options.settlePhase);
    this.draining = new DisposableChain(reporter, options.settlePhase);
  }

  get disposed(): boolean {
    return this.closing;
  }

  /**
   * 跟踪宿主的一次初始化。失败由宿主处理，关闭只等待它落定。
   * 每个 Lifecycle 至多 track 一次：再次调用会覆盖前一次，前一次不再被等待——调用方保证。
   */
  trackInitialization(initializing: Promise<unknown>): void {
    const settled = initializing.then(
      () => {},
      () => {},
    );
    this.initialization = settled;
    settled.then(() => {
      if (this.initialization === settled) this.initialization = undefined;
    });
  }

  /** 只置关闭位：此后宿主不再接新登记；收尾、撤回与清理由后续调用执行。 */
  markClosing(): void {
    this.closing = true;
  }

  /**
   * 提前执行收尾段（幂等）：置关闭位、等初始化落定、排空收尾链。撤回与清理不在此列——
   * 调用方（编排层）据此把「谁先收尾」与「谁先撤回」分开安排；不调用它时 disposeAsync 照旧
   * 自己收尾。没有待等的东西时同栈完成、返回 undefined。
   */
  drain(timeoutMs?: number): Promise<void> | undefined {
    if (this.drained) return this.drained;
    this.closing = true;
    if (!this.initialization && this.draining.size === 0) {
      this.draining.dispose();
      return undefined;
    }
    this.drained = (async () => {
      if (this.initialization) {
        await awaitWithTimeout(this.initialization, timeoutMs, limit =>
          this.options.onTimeout?.('initialization', limit),
        );
      }
      await this.draining.disposeAsync(timeoutMs);
    })();
    return this.drained;
  }

  async disposeAsync(timeoutMs?: number): Promise<void> {
    if (this.completion) {
      await awaitWithTimeout(this.completion, timeoutMs, limit => this.options.onTimeout?.('disposal', limit));
      return;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    // 必须先发布完成对象，再同栈执行 teardown：清理回调可以重入关闭并注册观察者。
    this.completion = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.teardown(timeoutMs).then(resolve, reject);
    await this.completion;
  }

  private async teardown(timeoutMs?: number): Promise<void> {
    this.closing = true;
    if (this.initialization) {
      await awaitWithTimeout(this.initialization, timeoutMs, limit =>
        this.options.onTimeout?.('initialization', limit),
      );
    }
    // 没有收尾项时不得多让出一拍：撤回与清理的首个回调一向与 disposeAsync() 同栈发起
    if (this.drained) await this.drained;
    else if (this.draining.size > 0) await this.draining.disposeAsync(timeoutMs);
    else this.draining.dispose();

    this.options.beforeCleanup?.();
    await this.disposables.disposeAsync(timeoutMs);
    this.options.afterCleanup?.();
  }
}
