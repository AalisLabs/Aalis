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
  it('收尾段已等过初始化并超时放弃：关闭不再等第二遍', async () => {
    const warn = vi.fn();
    const life = new Resources('t', stubLogger(warn));
    life.trackInitialization(new Promise(() => {}));
    await life.drain(20);
    await life.disposeAsync(20);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('等待初始化落定'))).toHaveLength(1);
    expect(life.disposables.disposed).toBe(true);
  });

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

  it('关闭一律异步：清理回调不在调用方的栈上执行（abort 监听除外），收尾等异步清理落定', async () => {
    const released = gate();
    const trace: string[] = [];
    const life = new Resources('t', stubLogger(), { afterCleanup: () => void trace.push('finished') });
    life.signal.addEventListener('abort', () => void trace.push('abort'));
    life.disposables.push(async () => {
      trace.push('start');
      await released.promise;
      trace.push('end');
    });
    const closing = life.disposeAsync();
    expect(trace).toEqual(['abort']);
    released.open();
    await closing;
    expect(trace).toEqual(['abort', 'start', 'end', 'finished']);
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
