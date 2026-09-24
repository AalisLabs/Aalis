import { describe, expect, it, vi } from 'vitest';
import { Lifecycle } from '../../packages/core/src/kernel/lifecycle.js';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

describe('独立资源生命周期', () => {
  it('先等初始化和收尾段，再撤回可见资源，逆序等待清理后收尾', async () => {
    const acquired = gate();
    const drainClosing = gate();
    const drainStarted = gate();
    const trace: string[] = [];
    const life = new Lifecycle({
      beforeCleanup: () => trace.push('withdraw'),
      afterCleanup: () => trace.push('finished'),
    });
    life.disposables.push(() => trace.push('first'));
    life.draining.push(async () => {
      trace.push('drain:start');
      drainStarted.open();
      await drainClosing.promise;
      trace.push('drain:end');
    });
    life.trackInitialization(
      acquired.promise.then(() => {
        trace.push('initialized');
        life.disposables.push(() => trace.push('late'));
      }),
    );

    let finished = false;
    const closing = life.disposeAsync().then(() => {
      finished = true;
    });
    expect(life.disposed).toBe(true);
    expect(life.disposables.disposed).toBe(false);
    expect(trace).toEqual([]);
    acquired.open();
    await drainStarted.promise;
    expect(finished).toBe(false);
    life.disposables.push(() => trace.push('during-drain'));
    drainClosing.open();
    await closing;
    expect(trace).toEqual([
      'initialized',
      'drain:start',
      'drain:end',
      'withdraw',
      'during-drain',
      'late',
      'first',
      'finished',
    ]);
  });

  it('异步关闭与调用同栈发起首个清理回调，收尾等异步清理落定', async () => {
    const released = gate();
    const trace: string[] = [];
    const life = new Lifecycle({ afterCleanup: () => trace.push('finished') });
    life.disposables.push(async () => {
      trace.push('start');
      await released.promise;
      trace.push('end');
    });
    const closing = life.disposeAsync();
    expect(trace).toEqual(['start']);
    released.open();
    await closing;
    expect(trace).toEqual(['start', 'end', 'finished']);
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

  it('清理失败隔离，已关闭的生命周期不会再次清理', async () => {
    const trace: string[] = [];
    const warn = vi.fn();
    const life = new Lifecycle({}, { warn });
    for (const name of ['a', 'b', 'c']) {
      life.disposables.push(() => trace.push(name));
      life.disposables.push(async () => {
        throw new Error(name);
      });
    }
    await life.disposeAsync();
    await life.disposeAsync();
    expect(trace).toEqual(['c', 'b', 'a']);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
