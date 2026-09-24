import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../packages/core/src/index.js';
import { Resources } from '../../packages/core/src/infrastructure/resources.js';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

function stubLogger(warn = vi.fn()): Logger {
  const logger: Logger = { debug() {}, info() {}, warn, error() {}, child: () => logger };
  return logger;
}

describe('Resources 的关闭过程', () => {
  it('先等初始化和收尾段，再撤回可见资源，逆序等待清理后收尾', async () => {
    const acquired = gate();
    const drainClosing = gate();
    const drainStarted = gate();
    const trace: string[] = [];
    const life = new Resources('t', stubLogger(), {
      beforeCleanup: () => void trace.push('withdraw'),
      afterCleanup: () => void trace.push('finished'),
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
    const life = new Resources('t', stubLogger(), { afterCleanup: () => void trace.push('finished') });
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
      const warn = vi.fn();
      const life = new Resources('t', stubLogger(warn));
      life.disposables.push(() => released.promise);
      let originalDone = false;
      const original = life.disposeAsync().then(() => {
        originalDone = true;
      });
      const impatient = life.disposeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await impatient;
      expect(warn.mock.calls.map(args => String(args[0]))).toEqual(['Resources "t": 等待在飞拆卸超过 10ms，放弃等待']);
      expect(originalDone).toBe(false);
      released.open();
      await original;
      expect(originalDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('清理失败隔离，已关闭的资源账不会再次清理', async () => {
    const trace: string[] = [];
    const warn = vi.fn();
    const life = new Resources('t', stubLogger(warn));
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
