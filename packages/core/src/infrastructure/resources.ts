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
 * 一次激活的资源记录、就绪回调与关闭过程；不了解服务或插件调度。
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
  /** onReady 登记的就绪回调，跑过即摘掉 */
  readonly #readyHooks = new Set<() => unknown>();
  /** 已就绪（见 {@link ready}）：此后登记的回调各自另跑 */
  #ready = false;
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
      const held = this.#holdInflight(work, what);
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

  /** 关闭后拒收的统一出口：已开始关闭就告警「已关闭，忽略 <what>」并回 true，调用方据此不收这次登记 */
  refuses(what: string): boolean {
    if (this.#closing) this.#logger.warn(`激活 "${this.#id}" 已关闭，忽略 ${what}`);
    return this.#closing;
  }

  /** 登记就绪回调：{@link ready} 时跑一次；已就绪之后登记的，下一个微任务另跑。返回退订 */
  onReady(fn: () => void | Promise<void>): () => void {
    if (this.refuses('onReady')) return () => {};
    // 每次登记一个独立包装：同一个回调登记两次各算一条
    const hook = () => fn();
    this.#readyHooks.add(hook);
    if (this.#ready) void this.#runReady(hook);
    return () => void this.#readyHooks.delete(hook);
  }

  /**
   * 就绪（由编排者在整体装好、本激活已激活时调用）：此刻已登记的回调按登记序逐个跑，单个至多等 limitMs（非正数不设限），
   * 超过记 warn、转向下一个。返回时这些回调都已落定或已放弃等待。回调跑过即摘掉，再调一次不会重跑。
   */
  async ready(limitMs: number): Promise<void> {
    this.#ready = true;
    for (const hook of [...this.#readyHooks])
      await awaitWithTimeout(this.#runReady(hook), limitMs, this.#timeout('等待 onReady 回调'));
  }

  /**
   * 跑一个就绪回调，晚一拍、执行时才核对：排上之后被退订的、已开始关闭的不跑。记进在飞工作：关闭在每段收口等它落定，
   * 超过宽限仍没落定的由 lingering 看到。
   */
  #runReady(hook: () => unknown): Promise<void> {
    const run = Promise.resolve()
      .then(() => (this.#readyHooks.delete(hook) && !this.#closing ? hook() : undefined))
      .catch(error => this.#logger.warn(`Resources "${this.#id}": onReady 回调抛错，已忽略:`, error));
    return this.#holdInflight(run, 'onReady 回调');
  }

  /**
   * 订阅「可能变了，请重读」：source 把 poke 接到变更来源上、交回摘除。每次 poke 在下一个微任务里调一次 fn，期间的多次
   * 合并成一次；已退订、已开始关闭的不调，抛错与拒绝记 warn。订阅随撤回段摘除；返回退订。what 是被看的东西，诊断用。
   */
  watch(what: string, source: (poke: () => void) => () => unknown, fn: () => unknown): () => void {
    if (this.refuses(`${what} 的 watch`)) return () => {};
    let queued = false;
    let live = true;
    const unhook = source(() => {
      if (queued) return;
      queued = true;
      void Promise.resolve()
        .then(() => {
          queued = false;
          return live && !this.#closing ? fn() : undefined;
        })
        .catch(error => this.#logger.warn(`Resources "${this.#id}": ${what} 的 watch 回调抛错，已忽略:`, error));
    });
    const off = this.trackWithdrawal(() => {
      live = false;
      unhook();
    }, `watch:${what}`);
    return () => void off();
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
   * 对外可见的条目。异步部分由执行方自行记录，本段不等。返回摘除（登记方先退役时用）。
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
   * 关闭之后仍未落定的工作（超过宽限被放弃的初始化与清理，以及关闭后就地执行的清理）全部落定时兑现，期间新增的
   * 一并等；没有时 undefined。旧实例在它兑现之前还没停下。
   */
  lingering(): Promise<unknown> | undefined {
    const rest: Promise<unknown>[] = [...this.#inflight.keys()];
    if (this.#initialization) rest.push(this.#initialization);
    return rest.length === 0 ? undefined : Promise.all(rest).then(() => this.lingering());
  }

  /** 记一项在飞工作、就地接住拒绝。关闭不在调用方的栈上收口：同步段途中发起了关闭，拿到的句柄也来得及补登 */
  #holdInflight(work: PromiseLike<unknown>, what: string): Promise<void> {
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

  /**
   * 段收口：等在飞记录落定，期间新记的一并等。整次收口共用一个 timeoutMs 的时限：落定时又记进新工作的（清理里再登记、
   * 关不掉的定时器一直往里登记）不会让收口一轮接一轮永不结束；到点没落定的放弃等待并记 warn，仍由 lingering 看到；
   * 到点之后不再追新记的工作，等待的循环随之结束。没有未落定的工作时直接返回，不设时限、不设定时器
   */
  async #settle(timeoutMs?: number): Promise<void> {
    const unsettled = () => [...this.#inflight.keys()].filter(work => !this.#abandoned.has(work));
    let batch = unsettled();
    if (batch.length === 0) return;
    let expired = false;
    const settling = (async () => {
      for (; batch.length > 0 && !expired; batch = unsettled()) await Promise.all(batch);
    })();
    await awaitWithTimeout(settling, timeoutMs, limit => {
      expired = true;
      for (const work of unsettled()) {
        this.#abandoned.add(work);
        this.#logger.warn(`Resources "${this.#id}": 等待 ${this.#inflight.get(work)} 超过 ${limit}ms，放弃等待`);
      }
    });
  }

  /** 一次性撤回；异步部分与 follow / registrar 一样只进在飞记录，在段收口等一次（手动开始的也纳入这次激活的关闭） */
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
      this.#holdInflight(pending, label);
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
