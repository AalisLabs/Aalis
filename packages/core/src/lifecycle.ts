import { awaitWithTimeout, type CleanupReporter, DisposableChain } from './disposable-chain.js';

interface LifecycleOptions {
  /** 子节点关闭后、清理链开始前，撤回宿主对外暴露的资源。 */
  beforeCleanup?: () => void;
  /** 清理链结束后执行宿主收尾；两个阶段回调均为同步操作。 */
  afterCleanup?: () => void;
  onTimeout?: (phase: 'initialization' | 'disposal', timeoutMs: number) => void;
  onError?: (error: unknown) => void;
}

/**
 * 内部资源生命周期。不了解服务、事件、配置或插件调度。
 * disposed 表示已开始关闭；disposables.disposed 表示清理链已被取走。
 * 两者之间仍允许登记清理，以接住初始化或子节点关闭期间迟到的资源。
 */
export class Lifecycle {
  readonly disposables: DisposableChain;
  private readonly children = new Set<Lifecycle>();
  private parent?: Lifecycle;
  private closing = false;
  private completion?: Promise<void>;
  private initialization?: Promise<void>;

  constructor(
    private readonly options: LifecycleOptions = {},
    reporter?: CleanupReporter,
  ) {
    this.disposables = new DisposableChain(reporter);
  }

  get disposed(): boolean {
    return this.closing;
  }

  /** 收养尚未关闭的独立节点；每个节点只有一个父节点。 */
  adopt(child: Lifecycle): void {
    if (this.closing || child.closing || child.parent) {
      throw new Error('Lifecycle: cannot adopt a closing or already owned node');
    }
    for (let ancestor: Lifecycle | undefined = this; ancestor; ancestor = ancestor.parent) {
      if (ancestor === child) throw new Error('Lifecycle: ownership must not form a cycle');
    }
    this.children.add(child);
    child.parent = this;
  }

  /** 跟踪宿主的一次初始化。失败由宿主处理，关闭只等待它落定。 */
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

  /** 同栈发起并执行同步清理；保留不等待异步清理的语义。 */
  dispose(): void {
    this.beginDisposal(false).catch(error => this.options.onError?.(error));
  }

  async disposeAsync(timeoutMs?: number): Promise<void> {
    if (this.completion) {
      await awaitWithTimeout(this.completion, timeoutMs, limit => this.options.onTimeout?.('disposal', limit));
      return;
    }
    await this.beginDisposal(true, timeoutMs);
  }

  private beginDisposal(wait: boolean, timeoutMs?: number): Promise<void> {
    if (this.completion) return this.completion;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    // 必须先发布完成对象，再同栈执行 teardown：清理回调可以重入关闭并注册观察者。
    // 把 teardown 延后到微任务会改变同步 dispose 的退订时序。
    this.completion = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.teardown(wait, timeoutMs).then(resolve, reject);
    return this.completion;
  }

  private async teardown(wait: boolean, timeoutMs?: number): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    if (wait && this.initialization) {
      await awaitWithTimeout(this.initialization, timeoutMs, limit =>
        this.options.onTimeout?.('initialization', limit),
      );
    }

    // 父节点在关闭子节点期间仍持有清理链；顺序与原 Context 级联一致。
    for (const child of [...this.children]) {
      if (wait) await child.disposeAsync(timeoutMs);
      else child.dispose();
    }
    this.children.clear();

    this.options.beforeCleanup?.();
    if (wait) await this.disposables.disposeAsync(timeoutMs);
    else this.disposables.dispose();
    this.options.afterCleanup?.();

    this.parent?.children.delete(this);
    this.parent = undefined;
  }
}
