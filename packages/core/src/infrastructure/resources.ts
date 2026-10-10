import { awaitWithTimeout, DisposableChain, isThenable } from '../kernel/disposable-chain.js';

import type { Logger } from './logger.js';

/**
 * afterCut：切断之后、撤回链之前等下游对已切断资源的交接落定（返回待等的 Promise，没有则 undefined）；
 * afterCleanup：清理链之后收尾（同步）。
 */
interface ResourceHooks {
  afterCut?: () => Promise<unknown> | undefined;
  afterCleanup?: () => void;
}

/**
 * 一次激活的资源账与关闭过程；不了解服务、事件或插件调度。
 * disposed 表示已开始关闭；disposables.disposed 表示清理链已被取走。两者之间仍允许登记，
 * 以接住初始化期间迟到的资源。
 */
export class Resources {
  /** 收尾段：默认在撤回前执行；编排者可用 drain() 提前执行。 */
  readonly draining: DisposableChain;
  /** 撤回段：交到别人手里的登记（follow 的清理、track），整体先于清理段 */
  readonly withdrawals: DisposableChain;
  /** 清理段：onDispose，释放自有资源 */
  readonly disposables: DisposableChain;
  /** 本激活发起、尚未落定的异步工作（落定自删），值是诊断名：每段收口等它们 */
  readonly #inflight = new Map<Promise<void>, string>();
  /** 其中超过宽限、收口不再等的；关完仍有未落定的工作，旧实例就还没停下（见 lingering） */
  readonly #abandoned = new Set<Promise<void>>();
  #closing = false;
  #drained?: Promise<void>;
  #completion?: Promise<void>;
  #initialization?: Promise<void>;
  readonly #cuts = new Set<() => void>();
  readonly #abort = new AbortController();
  /** 取消信号：收尾段开始时 abort；初始化尚未落定的，编排者在冻结关闭计划后提前 abort（见 {@link abort}） */
  readonly signal: AbortSignal = this.#abort.signal;
  readonly #id: string;
  readonly #logger: Logger;
  readonly #hooks: ResourceHooks;

  constructor(id: string, logger: Logger, hooks: ResourceHooks = {}) {
    this.#id = id;
    this.#logger = logger;
    this.#hooks = hooks;
    const hold = (work: Promise<void>, what: string, abandoned: boolean): void => {
      const held = this.holdInflight(work, what);
      if (abandoned) this.#abandoned.add(held);
    };
    this.draining = new DisposableChain(logger, hold);
    this.withdrawals = new DisposableChain(logger, hold);
    this.disposables = new DisposableChain(logger, hold);
  }

  /** 已开始关闭 */
  get disposed(): boolean {
    return this.#closing;
  }

  /** 跟踪中的初始化尚未落定 */
  get initializing(): boolean {
    return this.#initialization !== undefined;
  }

  /**
   * 断开取消信号（幂等）。reason 为 `AbortError` 的 DOMException。监听器同步执行、属于宿主代码，
   * 调用方不得在需要保持不变量的遍历途中调用。
   */
  abort(): void {
    this.#abort.abort(new DOMException(`激活 "${this.#id}" 已开始关闭`, 'AbortError'));
  }

  #timeout(what: string): (limit: number) => void {
    return limit => this.#logger.warn(`Resources "${this.#id}": ${what}超过 ${limit}ms，放弃等待`);
  }

  /**
   * 跟踪宿主的一次初始化。失败由宿主处理，关闭只等待它落定。
   * 至多 track 一次，调用方保证。
   * 已开始关闭时（初始化的同步段里就被接手）立即 abort：与「冻结后对在飞初始化 abort」同一规则。
   */
  trackInitialization(initializing: Promise<unknown>): void {
    // 落定的第一拍就清：宿主随后的收尾（含失败回滚里的关闭）看到的已是「初始化已落定」
    const done = (): void => {
      this.#initialization = undefined;
    };
    this.#initialization = initializing.then(done, done);
    if (this.#closing) this.abort();
  }

  /**
   * 登记一个切断项：收尾之后、等下游交接之前按登记序同步执行，用于撤掉本激活登记到别处、
   * 对外可见的条目。异步部分由执行方自行记账，本段不等。返回摘除（登记方先退役时用）。
   */
  onCut(cut: () => void): () => void {
    this.#cuts.add(cut);
    return () => this.#cuts.delete(cut);
  }

  /** 只置关闭位：此后不再接新登记；收尾、撤回与清理由后续调用执行。 */
  markClosing(): void {
    this.#closing = true;
  }

  /**
   * 提前执行收尾段（幂等）：置关闭位、断开取消信号、等初始化落定、排空收尾链。撤回与清理不在此列——
   * 编排层据此把「谁先收尾」与「谁先撤回」分开安排；不调用它时 disposeAsync 照旧自己收尾。
   * 关闭位与取消信号同步设置；收尾回调至少晚一拍，不在调用方的栈上执行。先发布本次收尾再断信号：
   * abort 监听重入拿到的是同一个 Promise。
   */
  drain(timeoutMs?: number): Promise<void> {
    if (this.#drained) return this.#drained;
    this.#closing = true;
    this.#drained = Promise.resolve().then(async () => {
      if (this.#initialization)
        await awaitWithTimeout(this.#initialization, timeoutMs, this.#timeout('等待初始化落定'));
      await this.draining.disposeAsync(timeoutMs);
      await this.#settle(timeoutMs);
    });
    this.abort();
    return this.#drained;
  }

  /**
   * 关闭并等它关完（幂等：重复调用拿到同一个 Promise）。关停编排在本激活的收尾段之后才调它，此刻 abort 早已发出，
   * 完成对象发布之前没有插件代码运行；等别人的在飞关闭在激活一层（Activation.disposeAsync）。
   */
  disposeAsync(timeoutMs?: number): Promise<void> {
    this.#completion ??= this.#teardown(timeoutMs);
    return this.#completion;
  }

  async #teardown(timeoutMs?: number): Promise<void> {
    // 收尾段（等初始化、排空收尾链）已由编排者提前执行时只等它，不再等第二遍初始化
    await this.drain(timeoutMs);
    for (const cut of this.#cuts) cut();
    const handover = this.#hooks.afterCut?.();
    if (handover) await awaitWithTimeout(handover, timeoutMs, this.#timeout('等待下游交接'));
    // 撤回段整体先于清理段，段内逆序；每段收口等本段发起、还没落定的异步工作
    for (const chain of [this.withdrawals, this.disposables]) {
      await chain.disposeAsync(timeoutMs);
      await this.#settle(timeoutMs);
    }
    this.#hooks.afterCleanup?.();
  }

  /**
   * 关闭之后仍未落定的工作（超过宽限被放弃的初始化与清理，以及关闭后就地执行的清理）全部落定时兑现，期间新起的
   * 一并等；没有时 undefined。旧实例在它兑现之前还没停下。
   */
  lingering(): Promise<unknown> | undefined {
    const rest: Promise<unknown>[] = [...this.#inflight.keys()];
    if (this.#initialization) rest.push(this.#initialization);
    return rest.length === 0 ? undefined : Promise.all(rest).then(() => this.lingering());
  }

  /** 记一项在飞工作、就地接住拒绝。关闭不在调用方的栈上收口：同步段途中发起了关闭，拿到的句柄也来得及补登 */
  holdInflight(work: PromiseLike<unknown>, what: string): Promise<void> {
    const settled: Promise<void> = Promise.resolve(work)
      .then(
        () => undefined,
        error => this.#logger.warn(`${what} 撤回拒绝（已忽略）:`, error),
      )
      .then(() => {
        this.#inflight.delete(settled);
        this.#abandoned.delete(settled);
      });
    this.#inflight.set(settled, what);
    return settled;
  }

  async #settle(timeoutMs?: number): Promise<void> {
    for (;;) {
      const batch = [...this.#inflight].filter(([work]) => !this.#abandoned.has(work));
      if (batch.length === 0) return;
      await awaitWithTimeout(Promise.all(batch.map(([work]) => work)), timeoutMs, limit => {
        for (const [work, what] of batch) {
          if (!this.#inflight.has(work)) continue;
          this.#abandoned.add(work);
          this.#logger.warn(`Resources "${this.#id}": 等待 ${what} 超过 ${limit}ms，放弃等待`);
        }
      });
    }
  }

  /** 一次性撤回；异步部分与 follow / registrar 一样只进在飞账，在段收口等一次（手动开始的也纳入这次激活的关闭） */
  track(off: () => unknown, label: string): () => void {
    let started = false;
    return this.trackWithdrawal(() => {
      if (started) return;
      started = true;
      this.withdraw(off, label);
    }, label);
  }

  /** 清理异常就地隔离；异步拒绝被观察，并在段收口等待。 */
  withdraw(off: () => unknown, label: string): PromiseLike<unknown> | undefined {
    try {
      const result = off();
      if (!isThenable(result)) return undefined;
      const pending = Promise.resolve(result);
      this.holdInflight(pending, label);
      return pending;
    } catch (error) {
      this.#logger.warn(`${label} 撤回抛错（已忽略）:`, error);
      return undefined;
    }
  }

  /** 绑定撤回排在用户清理之前（撤回段）；返回值原样交给撤回链等待。 */
  trackWithdrawal(off: () => unknown, label?: string): () => unknown {
    const dispose = (): unknown => {
      this.withdrawals.remove(dispose);
      return off();
    };
    this.withdrawals.push(dispose, label);
    return dispose;
  }

  onDispose(fn: () => void | Promise<void>, label?: string): () => void {
    if (this.disposables.disposed) {
      this.#logger.warn(`Resources "${this.#id}" 已 dispose，onDispose${label ? `("${label}")` : ''} 将就地执行`);
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
