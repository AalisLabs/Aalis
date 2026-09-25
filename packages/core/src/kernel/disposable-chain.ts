/** 清理器只需要错误报告能力，不依赖宿主的日志系统。 */
export interface CleanupReporter {
  warn(message: string, ...args: unknown[]): void;
}

/**
 * 清理链的两段，排空时按此顺序：`withdraw`（撤回交到别人手里的登记）先，`cleanup`（释放自有资源）后。
 * 分段只约束**排空快照内**的次序：撤回段先、清理段后、各段内部逆序；排空开始后的迟到登记仍立即执行。
 * kernel 不出包，本类型不导出（未用导出会被 knip 拦下）。
 */
type DisposePhase = 'withdraw' | 'cleanup';

const PHASES: readonly DisposePhase[] = ['withdraw', 'cleanup'];

interface Entry {
  fn: () => unknown;
  /** 可选来源标注，仅用于诊断日志（超时/抛错时点名是哪一项）。 */
  label?: string;
  phase: DisposePhase;
}

/** 诊断用的条目标识：有 label 用 label，否则退到链内序号；两者都没有则不加缀。 */
function describe(label?: string, index?: number): string {
  if (label) return ` [${label}]`;
  return index === undefined ? '' : ` [#${index}]`;
}

/**
 * 一次性清理器链
 *
 * 用途：需要累积「注册 → 卸载」副作用的宿主，提供：
 * - `push(fn, label?, phase?)` 追加清理函数（label 仅进诊断日志；phase 见 {@link DisposePhase}，默认 cleanup）
 * - `remove(fn)` 精确移除单个清理函数（不执行）
 * - `seal()` 只标记已取走（链为空时用），此后的登记就地执行
 * - `disposeAsync(timeoutMs?)` 按段逆序**串行等待**每个清理函数（含异步返回值）
 *
 * 相比散落的 `this._disposables: (() => void)[]`，集中管理能避免
 * 「忘记 push / 忘记清空 / 错误处理不一致」等低级 bug。
 */
export class DisposableChain {
  private items: Entry[] = [];
  /** 链是否已被 {@link take} 取走；对外读口是 `disposed`。不叫 disposed 是因为与那个 getter 撞名。 */
  private taken = false;

  /** disposeAsync 排空期间迟到登记、就地执行的异步清理：段收口等它们落定（拒绝已接住） */
  private readonly late = new Map<Promise<void>, string>();
  private draining = false;

  /**
   * @param settlePhase 段收口：disposeAsync 每排空一段后调用，返回该段内**发起但尚未落定**的异步清理
   *   （宿主自己记账，链不认识它们；超时与点名由宿主按传入的上限自理）。链等它落定再进下一段——
   *   不占链上条目，条目数与标签名单不受影响。
   */
  constructor(
    private readonly logger?: CleanupReporter,
    private readonly settlePhase?: (timeoutMs?: number) => Promise<unknown> | undefined,
  ) {}

  /** 报告清理问题；reporter 自身失败不得中断剩余清理，见 {@link reportQuietly}。 */
  private report(message: string, ...args: unknown[]): void {
    reportQuietly(() => this.logger?.warn(message, ...args));
  }

  /**
   * 追加一个清理函数。链已取走后追加会立刻执行，与段无关；拒绝记 warn。异步返回值：链还在
   * disposeAsync 排空途中就由当前段的收口等到，排空已结束（或链经 seal 取走）则无人等待。
   */
  push(fn: () => unknown, label?: string, phase: DisposePhase = 'cleanup'): void {
    if (this.taken) {
      try {
        this.settle(fn(), describe(label));
      } catch (err) {
        this.report(`DisposableChain: post-dispose 执行失败${describe(label)}:`, err);
      }
      return;
    }
    this.items.push({ fn, label, phase });
  }

  /**
   * 取走后就地执行的清理不一定有人等（见 push），但拒绝必须有人接：登记方拿不到这个返回值，
   * 逃逸的拒绝会成为宿主进程的 unhandledRejection。
   */
  private settle(ret: unknown, who: string): void {
    if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
      const settled: Promise<void> = Promise.resolve(ret)
        .then(
          () => undefined,
          err => this.report(`DisposableChain: 异步清理拒绝，已忽略${who}:`, err),
        )
        .then(() => {
          this.late.delete(settled);
        });
      if (this.draining) this.late.set(settled, who);
    }
  }

  /** 链序标签名单（未命名项为 undefined 占位）。测试读口，纯读不执行。 */
  labels(): ReadonlyArray<string | undefined> {
    return this.items.map(e => e.label);
  }

  /** 精确移除单个 disposable（不执行）。用于缓冲项"取消"场景。 */
  remove(fn: () => unknown): boolean {
    const idx = this.items.findIndex(e => e.fn === fn);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    return true;
  }

  get disposed(): boolean {
    return this.taken;
  }

  /** 当前登记的清理函数数量（诊断 / 测试用：可检测闭包是否如期自移除）。 */
  get size(): number {
    return this.items.length;
  }

  /**
   * 置位 taken、快照并清空 items——seal 与 disposeAsync 共用，避免逻辑漂移。
   *
   * 先清空再迭代快照：dispose 期间 disposer 常回调 remove(自身)（provide /
   * 订阅句柄的自移除语义）。若在迭代中 splice 活动数组，索引
   * 会错位、长度缩短，导致取到 undefined 而抛 "is not a function"。清空在前
   * 则这些 remove 作用于空数组、安全 no-op（返回 false，符合各自移除点注释
   * 的预期），快照索引也始终稳定。
   */
  private take(): Entry[] {
    this.taken = true;
    const items = this.items;
    this.items = [];
    return items;
  }

  /** 只标记已取走、不执行任何清理：调用方保证此刻链为空，此后的登记就地执行。重复调用无效果。 */
  seal(): void {
    this.take();
  }

  /**
   * 按段**串行**等待所有清理函数完成：撤回段先、清理段后，段内逆序。
   *
   * 串行而非并发是刻意的：逆序是本类对外承诺的语义（消费侧清理先于提供侧），
   * 落盘类清理常有顺序依赖。单项抛错/拒绝被隔离，不中断后续清理。
   *
   * @param timeoutMs 单个异步清理项的等待上限；超时后放弃等待该项、
   *        **继续执行后续清理项**（定时器/监听器仍能摘干净），并 warn 点名。
   *        缺省或 <=0 不设限。
   */
  async disposeAsync(timeoutMs?: number): Promise<void> {
    if (this.taken) return;
    const items = this.take();
    this.draining = true;
    for (const phase of PHASES) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].phase !== phase) continue;
        try {
          const ret = items[i].fn();
          if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
            await this.awaitWithTimeout(Promise.resolve(ret), timeoutMs, describe(items[i].label, i));
          }
        } catch (err) {
          this.report(`DisposableChain: dispose 抛出，已忽略${describe(items[i].label, i)}:`, err);
        }
      }
      // 段收口：先等本段里迟到登记的（它们可能再登记新的，故循环），再等宿主记账的在飞清理
      while (this.late.size > 0) {
        const batch = [...this.late];
        await awaitWithTimeout(Promise.all(batch.map(([work]) => work)), timeoutMs, () => {
          for (const [work, who] of batch) {
            if (!this.late.delete(work)) continue;
            this.report(`DisposableChain: 迟到登记的异步清理${who} 超过 ${timeoutMs}ms，放弃等待`);
          }
        });
      }
      const pending = this.settlePhase?.(timeoutMs);
      if (pending) await pending;
    }
    this.draining = false;
  }

  /**
   * 等待单个清理 promise，可选超时护栏。
   *
   * 环境无关性记账：这是 core 首个计时器使用点。`setTimeout`/`clearTimeout`
   * 是所有 JS 运行时（浏览器/Node/Deno/Worker）的共有全局，非 `node:` 专属，
   * 不引入环境假设。
   */
  private async awaitWithTimeout(p: Promise<unknown>, timeoutMs?: number, who = ''): Promise<void> {
    await awaitWithTimeout(p, timeoutMs, () =>
      this.report(`DisposableChain: 异步清理${who} 超过 ${timeoutMs}ms，放弃等待，继续后续清理`),
    );
  }
}

/**
 * 等待一个 promise，可选超时护栏；超时则放弃等待并调 `onTimeout` 上报。
 *
 * 环境无关性记账：`setTimeout`/`clearTimeout` 是所有 JS 运行时（浏览器/Node/
 * Deno/Worker）的共有全局，非 `node:` 专属，不引入环境假设。
 *
 * 仅供 core 内部（DisposableChain 逐项等待、激活合流等待在飞拆卸）复用，
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
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 执行一次诊断上报：同步抛错吞掉，返回值经 Promise.resolve 归一后挂空 catch。上报器由宿主注入
 * （logger 的 sink 可能是 stdout / 文件 / WebUI），它自身失败不得中断清理或拆卸，也不得逃逸成
 * unhandledRejection——这里是防泄漏的最后一道防线，连报告都失败时只能静默。
 *
 * 供 core 内部（清理链、事件总线、激活拆卸路径）复用，不从包根导出。
 * @internal
 */
export function reportQuietly(call: () => unknown): void {
  try {
    Promise.resolve(call()).catch(() => {});
  } catch {
    /* 上报器自身失败不再向外传播 */
  }
}
