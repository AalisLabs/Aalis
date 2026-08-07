import type { Logger } from './logger.js';

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
 * 一次性清理器链
 *
 * 用途：Context 及其他需要累积「注册 → 卸载」副作用的场景，提供：
 * - `push(fn, label?)` 追加清理函数（label 仅进诊断日志）
 * - `remove(fn)` 精确移除单个清理函数（不执行）
 * - `dispose()` 同步逆序调用所有清理函数并清空；期间任一抛错不影响其他
 * - `disposeAsync(timeoutMs?)` 逆序**串行等待**每个清理函数（含异步返回值）
 *
 * 相比散落的 `this._disposables: (() => void)[]`，集中管理能避免
 * 「忘记 push / 忘记清空 / 错误处理不一致」等低级 bug。
 */
export class DisposableChain {
  private _items: Entry[] = [];
  private _disposed = false;

  constructor(private readonly logger?: Logger) {}

  /** 追加一个清理函数。dispose 后追加会立刻执行（异步返回值不等待）。 */
  push(fn: () => unknown, label?: string): void {
    if (this._disposed) {
      try {
        fn();
      } catch (err) {
        this.logger?.warn(`DisposableChain: post-dispose 执行失败: ${err}`);
      }
      return;
    }
    this._items.push({ fn, label });
  }

  /** 精确移除单个 disposable（不执行）。用于缓冲项"取消"场景。 */
  remove(fn: () => unknown): boolean {
    const idx = this._items.findIndex(e => e.fn === fn);
    if (idx < 0) return false;
    this._items.splice(idx, 1);
    return true;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /** 当前登记的清理函数数量（诊断 / 测试用：可检测闭包是否如期自移除）。 */
  get size(): number {
    return this._items.length;
  }

  /**
   * 置位 disposed、快照并清空 items——两个 dispose 入口共用，避免逻辑漂移。
   *
   * 先清空再迭代快照：dispose 期间 disposer 常回调 remove(自身)（provide /
   * whenService / subscribe 的自移除语义）。若在迭代中 splice 活动数组，索引
   * 会错位、长度缩短，导致取到 undefined 而抛 "is not a function"。清空在前
   * 则这些 remove 作用于空数组、安全 no-op（返回 false，符合各自移除点注释
   * 的预期），快照索引也始终稳定。
   */
  private take(): Entry[] {
    this._disposed = true;
    const items = this._items;
    this._items = [];
    return items;
  }

  /**
   * 同步逆序执行所有清理函数并清空。重复调用无效果。
   * 单个函数抛错被 swallow（可选择通过 logger 记录 debug）；
   * 异步返回值**不等待**——需要等待落盘类清理时用 {@link disposeAsync}。
   */
  dispose(): void {
    if (this._disposed) return;
    const items = this.take();
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i].fn();
      } catch (err) {
        this.logger?.debug(`DisposableChain: dispose 抛出，已忽略${describe(items[i].label, i)}:`, err);
      }
    }
  }

  /**
   * 逆序**串行**等待所有清理函数完成。
   *
   * 串行而非并发是刻意的：逆序是本类对外承诺的语义（消费侧清理先于提供侧），
   * 落盘类清理常有顺序依赖。单项抛错/拒绝被隔离，不中断后续清理。
   *
   * @param timeoutMs 单个异步清理项的等待上限；超时后放弃等待该项、
   *        **继续执行后续清理项**（定时器/监听器仍能摘干净），并 warn 点名。
   *        缺省或 <=0 不设限。
   */
  async disposeAsync(timeoutMs?: number): Promise<void> {
    if (this._disposed) return;
    const items = this.take();
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        const ret = items[i].fn();
        if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
          await this.awaitWithTimeout(Promise.resolve(ret), timeoutMs, describe(items[i].label, i));
        }
      } catch (err) {
        this.logger?.debug(`DisposableChain: dispose 抛出，已忽略${describe(items[i].label, i)}:`, err);
      }
    }
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
      this.logger?.warn(`DisposableChain: 异步清理${who} 超过 ${timeoutMs}ms，放弃等待，继续后续清理`),
    );
  }
}

/**
 * 等待一个 promise，可选超时护栏；超时则放弃等待并调 `onTimeout` 上报。
 *
 * 环境无关性记账：`setTimeout`/`clearTimeout` 是所有 JS 运行时（浏览器/Node/
 * Deno/Worker）的共有全局，非 `node:` 专属，不引入环境假设。
 *
 * @internal 仅供 core 内部（DisposableChain 逐项等待、Context join 在飞拆卸）复用，
 *   不从包根导出。
 */
export async function awaitWithTimeout(p: Promise<unknown>, timeoutMs: number | undefined, onTimeout: () => void) {
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
      onTimeout();
    }
  } finally {
    // clearTimeout 必须在 finally：悬空定时器会拖住事件循环，延迟进程退出
    if (timer !== undefined) clearTimeout(timer);
  }
}
