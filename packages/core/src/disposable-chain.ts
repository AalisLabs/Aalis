import type { Logger } from './logger.js';

/**
 * 一次性清理器链
 *
 * 用途：Context 及其他需要累积「注册 → 卸载」副作用的场景，提供：
 * - `push(fn)` 追加清理函数
 * - `remove(fn)` 精确移除单个清理函数（不执行）
 * - `dispose()` 逆序调用所有清理函数并清空；期间任一抛错不影响其他
 *
 * 相比散落的 `this._disposables: (() => void)[]`，集中管理能避免
 * 「忘记 push / 忘记清空 / 错误处理不一致」等低级 bug。
 */
export class DisposableChain {
  private _items: (() => void)[] = [];
  private _disposed = false;

  constructor(private readonly logger?: Logger) {}

  /** 追加一个清理函数。dispose 后追加会立刻执行。 */
  push(fn: () => void): void {
    if (this._disposed) {
      try {
        fn();
      } catch (err) {
        this.logger?.warn(`DisposableChain: post-dispose 执行失败: ${err}`);
      }
      return;
    }
    this._items.push(fn);
  }

  /** 精确移除单个 disposable（不执行）。用于缓冲项"取消"场景。 */
  remove(fn: () => void): boolean {
    const idx = this._items.indexOf(fn);
    if (idx < 0) return false;
    this._items.splice(idx, 1);
    return true;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * 逆序执行所有清理函数并清空。重复调用无效果。
   * 单个函数抛错被 swallow（可选择通过 logger 记录 debug）。
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (let i = this._items.length - 1; i >= 0; i--) {
      try {
        this._items[i]();
      } catch (err) {
        this.logger?.debug('DisposableChain: dispose 抛出，已忽略:', err);
      }
    }
    this._items = [];
  }
}
