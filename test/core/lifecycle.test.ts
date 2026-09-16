import { describe, expect, it, vi } from 'vitest';
import { Lifecycle } from '../../packages/core/src/lifecycle.js';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

describe('独立资源生命周期', () => {
  it('先等初始化和子节点，再撤回可见资源，逆序等待清理后收尾', async () => {
    const acquired = gate();
    const childClosing = gate();
    const childStarted = gate();
    const trace: string[] = [];
    const parent = new Lifecycle({
      beforeCleanup: () => trace.push('withdraw'),
      afterCleanup: () => trace.push('finished'),
    });
    const child = new Lifecycle();
    parent.adopt(child);
    parent.disposables.push(() => trace.push('first'));
    child.disposables.push(async () => {
      trace.push('child:start');
      childStarted.open();
      await childClosing.promise;
      trace.push('child:end');
    });
    parent.trackInitialization(
      acquired.promise.then(() => {
        trace.push('initialized');
        parent.disposables.push(() => trace.push('late'));
      }),
    );

    let finished = false;
    const closing = parent.disposeAsync().then(() => {
      finished = true;
    });
    expect(parent.disposed).toBe(true);
    expect(parent.disposables.disposed).toBe(false);
    expect(trace).toEqual([]);
    acquired.open();
    await childStarted.promise;
    expect(finished).toBe(false);
    parent.disposables.push(() => trace.push('during-child'));
    childClosing.open();
    await closing;
    expect(trace).toEqual([
      'initialized',
      'child:start',
      'child:end',
      'withdraw',
      'during-child',
      'late',
      'first',
      'finished',
    ]);
  });

  it('同步关闭同栈完成同步工作，后续异步关闭不升级为等待已启动的异步清理', async () => {
    const released = gate();
    const trace: string[] = [];
    const life = new Lifecycle({ afterCleanup: () => trace.push('finished') });
    life.disposables.push(async () => {
      trace.push('start');
      await released.promise;
      trace.push('end');
    });
    life.dispose();
    expect(trace).toEqual(['start', 'finished']);
    await life.disposeAsync();
    expect(trace).toEqual(['start', 'finished']);
    released.open();
    await released.promise;
    expect(trace).toEqual(['start', 'finished', 'end']);
  });

  it('一个等待者超时不结束原关闭，也不放行其他等待者', async () => {
    vi.useFakeTimers();
    try {
      const released = gate();
      const timeouts: string[] = [];
      const life = new Lifecycle({ onTimeout: phase => timeouts.push(phase) });
      life.disposables.push(() => released.promise);
      let originalDone = false;
      const original = life.disposeAsync().then(() => {
        originalDone = true;
      });
      const impatient = life.disposeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await impatient;
      expect(timeouts).toEqual(['disposal']);
      expect(originalDone).toBe(false);
      released.open();
      await original;
      expect(originalDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('清理失败隔离，子节点按加入顺序关闭且不会再次清理已关闭的子节点', async () => {
    const trace: string[] = [];
    const warn = vi.fn();
    const parent = new Lifecycle();
    for (const name of ['a', 'b', 'c']) {
      const child = new Lifecycle({}, { warn });
      parent.adopt(child);
      child.disposables.push(() => trace.push(name));
      child.disposables.push(async () => {
        throw new Error(name);
      });
      if (name === 'b') await child.disposeAsync();
    }
    await parent.disposeAsync();
    expect(trace).toEqual(['b', 'a', 'c']);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('所有权保持单父节点无环，关闭后不能再收养资源节点', () => {
    const root = new Lifecycle();
    const child = new Lifecycle();
    const other = new Lifecycle();
    root.adopt(child);
    expect(() => other.adopt(child)).toThrow();
    expect(() => child.adopt(root)).toThrow();
    expect(() => root.adopt(root)).toThrow();
    root.dispose();
    expect(() => root.adopt(other)).toThrow();
    expect(() => other.adopt(child)).toThrow();
    other.dispose();
  });
});
