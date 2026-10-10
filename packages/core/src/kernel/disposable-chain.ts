/** 清理器只需要错误报告能力，不依赖宿主的日志系统。 */
export interface CleanupReporter {
  warn(message: string, ...args: unknown[]): void;
}

/**
 * 链自己等不到的异步清理交给宿主记账（交出的 Promise 不会拒绝，拒绝链已上报）：取走后就地执行的，abandoned 为
 * false，由宿主在下一次收口时等；超过逐项上限、放弃等待的，abandoned 为 true，宿主只记着它直到落定。
 */
type Hold = (work: Promise<void>, what: string, abandoned: boolean) => void;

interface Entry {
  fn: () => unknown;
  /** 可选来源标注，仅用于诊断日志（超时/抛错时点名是哪一项）。 */
  label?: string;
}

/** 诊断用的条目标识：有 label 用 label，否则退到链内序号；两者都没有则不加缀。 */
function describe(label?: string, index?: number): string {
  if (label) return ` [${label}]`;
  return index === undefined ? '' : ` [#${index}]`;
}

/**
 * 是否 thenable：core 内部判断回调返回值要不要等、要不要接住拒绝的唯一写法，不从包根导出。
 * @internal
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}

/**
 * 一次性清理器链
 *
 * 用途：需要累积「注册 → 卸载」副作用的宿主，提供：
 * - `push(fn, label?)` 追加清理函数（label 仅进诊断日志）
 * - `remove(fn)` 精确移除单个清理函数（不执行）
 * - `disposeAsync(timeoutMs?)` 逆序**串行等待**每个清理函数（含异步返回值）
 *
 * 相比散落的 `this._disposables: (() => void)[]`，集中管理能避免
 * 「忘记 push / 忘记清空 / 错误处理不一致」等低级 bug。
 */
export class DisposableChain {
  #items: Entry[] = [];
  /** 链是否已被取走（见 disposeAsync）；对外读口是 `disposed`。 */
  #disposed = false;
  readonly #logger: CleanupReporter;
  readonly #hold: Hold;

  constructor(logger: CleanupReporter, hold: Hold) {
    this.#logger = logger;
    this.#hold = hold;
  }

  /** 报告清理问题；reporter 自身失败不得中断剩余清理，见 {@link reportQuietly}。 */
  #report(message: string, ...args: unknown[]): void {
    reportQuietly(() => this.#logger.warn(message, ...args));
  }

  /**
   * 追加一个清理函数。链已取走后追加会立刻执行；抛错与拒绝记 warn，异步返回值交给宿主（见 {@link Hold}）。
   * 登记方拿不到这个返回值：拒绝必须在这里接住，否则逃逸成宿主进程的 unhandledRejection。
   */
  push(fn: () => unknown, label?: string): void {
    if (!this.#disposed) {
      this.#items.push({ fn, label });
      return;
    }
    const who = describe(label);
    try {
      const ret = fn();
      if (isThenable(ret)) {
        const work = Promise.resolve(ret).then(
          () => undefined,
          err => this.#report(`DisposableChain: 异步清理拒绝，已忽略${who}:`, err),
        );
        this.#hold(work, `迟到登记的清理${who}`, false);
      }
    } catch (err) {
      this.#report(`DisposableChain: post-dispose 执行失败${who}:`, err);
    }
  }

  /** 链序标签名单（未命名项为 undefined 占位）。测试读口，纯读不执行。 */
  labels(): ReadonlyArray<string | undefined> {
    return this.#items.map(e => e.label);
  }

  /** 精确移除单个 disposable（不执行）。用于缓冲项"取消"场景。 */
  remove(fn: () => unknown): boolean {
    const idx = this.#items.findIndex(e => e.fn === fn);
    if (idx < 0) return false;
    this.#items.splice(idx, 1);
    return true;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** 当前登记的清理函数数量（诊断 / 测试用：可检测闭包是否如期自移除）。 */
  get size(): number {
    return this.#items.length;
  }

  /**
   * 逆序**串行**等待所有清理函数完成。
   *
   * 串行而非并发是刻意的：逆序是本类对外承诺的语义（消费侧清理先于提供侧），
   * 落盘类清理常有顺序依赖。单项抛错/拒绝被隔离，不中断后续清理。
   *
   * @param timeoutMs 单个异步清理项的等待上限；超时后放弃等待该项、交给宿主记账、
   *        **继续执行后续清理项**（定时器/监听器仍能摘干净），并 warn 点名。
   *        缺省或 <=0 不设限。
   */
  async disposeAsync(timeoutMs?: number): Promise<void> {
    if (this.#disposed) return;
    // 先清空再迭代快照：dispose 期间 disposer 常回调 remove(自身)（provide / 订阅句柄的自移除语义）。
    // 在迭代中 splice 活动数组，索引会错位、长度缩短，取到 undefined 而抛 "is not a function"；清空在前则
    // 这些 remove 作用于空数组、安全 no-op（返回 false，符合各自移除点注释的预期），快照索引也始终稳定。
    this.#disposed = true;
    const items = this.#items;
    this.#items = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const who = describe(items[i].label, i);
      const fail = (err: unknown): void => this.#report(`DisposableChain: dispose 抛出，已忽略${who}:`, err);
      try {
        const ret = items[i].fn();
        if (!isThenable(ret)) continue;
        // 先接住拒绝再限时（与事件总线同一写法）：超时后才到的拒绝也要上报，不能被放弃等待吞掉
        const work = Promise.resolve(ret).then(() => undefined, fail);
        await awaitWithTimeout(work, timeoutMs, () => {
          this.#report(`DisposableChain: 异步清理${who} 超过 ${timeoutMs}ms，放弃等待，继续后续清理`);
          this.#hold(work, `异步清理${who}`, true);
        });
      } catch (err) {
        fail(err);
      }
    }
  }
}

/**
 * 等待一个 promise，可选超时护栏；超时则放弃等待并调 `onTimeout` 上报。
 *
 * `setTimeout`/`clearTimeout` 是各 JS 运行时共有的宿主全局，登记在 core 的宿主全局白名单里
 * （test/core/architecture.test.ts 守卫）。
 *
 * 仅供 core 内部（DisposableChain 逐项等待、Resources 等初始化与交接、事件总线限时等待监听器）复用，
 *   不从包根导出。
 * @internal
 */
export async function awaitWithTimeout(
  p: Promise<unknown>,
  timeoutMs: number | undefined,
  onTimeout: (timeoutMs: number) => void,
) {
  if (!timeoutMs || timeoutMs <= 0) {
    await p;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const winner = await Promise.race([
      p.then(() => 'done' as const),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    if (winner === 'timeout') {
      // 放弃等待，但给原 promise 挂空 catch——迟到的 rejection 不得逃逸成 unhandledRejection
      p.catch(() => {});
      onTimeout(timeoutMs);
    }
  } finally {
    // clearTimeout 必须在 finally：悬空定时器会拖住事件循环，延迟进程退出
    clearTimeout(timer);
  }
}

/**
 * 执行一次诊断上报：同步抛错吞掉，返回值经 Promise.resolve 归一后挂空 catch。上报器由宿主注入
 * （logger 的 sink 可能是 stdout / 文件 / WebUI），它自身失败不得中断清理或拆卸，也不得逃逸成
 * unhandledRejection——这里是防泄漏的最后一道防线，连报告都失败时只能静默。
 *
 * 供 core 内部（清理链、事件总线、日志中枢、不抛的 Logger）复用，不从包根导出。
 * @internal
 */
export function reportQuietly(call: () => unknown): void {
  try {
    Promise.resolve(call()).catch(() => {});
  } catch {
    /* 上报器自身失败不再向外传播 */
  }
}
