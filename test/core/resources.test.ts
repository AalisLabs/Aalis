import { describe, expect, it } from 'vitest';
import type { Logger } from '../../packages/core/src/infrastructure/logger.js';
import { Resources } from '../../packages/core/src/infrastructure/resources.js';
import { deferred } from '../helpers/deferred.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function world(options: { afterCleanup?: () => void } = {}) {
  const warnings: unknown[][] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args) => void warnings.push(args),
    error: (...args) => void warnings.push(args),
    child: () => logger,
  };
  return { resources: new Resources('test', logger, options), warnings };
}

describe('Resources', () => {
  it('keeps phase ordering and independent cancellation without any service or activation', async () => {
    const calls: string[] = [];
    const { resources } = world({ afterCleanup: () => calls.push('after') });
    resources.onCut(() => calls.push('before'));
    const same = () => void calls.push('same');
    resources.onDispose(same);
    resources.onDispose(() => void calls.push('middle'));
    resources.onDispose(same)();
    resources.onDrain(() => void calls.push('drain'));
    resources.trackWithdrawal(() => calls.push('withdraw'));
    const off = resources.track(() => void calls.push('manual'), 'manual');
    off();
    expect(resources.withdrawals.labels()).not.toContain('manual');
    await resources.disposeAsync();
    expect(calls).toEqual(['manual', 'drain', 'before', 'withdraw', 'middle', 'same', 'after']);
  });

  it('waits for a cleanup handle received after a registration callback starts closing', async () => {
    const { resources } = world();
    const cleanup = deferred();
    let closing!: Promise<void>;
    let withdrew = false;
    // This is the synchronous provider register callback. The caller receives off only after it returns.
    const register = () => {
      closing = resources.disposeAsync();
      return () => {
        withdrew = true;
        return cleanup.promise;
      };
    };
    const off = register();
    if (resources.disposed) resources.holdInflight(off(), 'late registration');
    let closed = false;
    const observed = closing.then(() => {
      closed = true;
    });
    await tick();
    expect(withdrew).toBe(true);
    expect(closed).toBe(false);
    cleanup.resolve();
    await observed;
    expect(closed).toBe(true);
  });

  it('tracks cleanup spawned while an earlier cleanup settles, and isolates rejection', async () => {
    const { resources, warnings } = world();
    const first = deferred();
    const second = deferred();
    resources.holdInflight(
      first.promise.then(() => resources.holdInflight(second.promise, 'second')),
      'first',
    );
    let closed = false;
    const closing = resources.disposeAsync().then(() => {
      closed = true;
    });
    first.resolve();
    await tick();
    expect(closed).toBe(false);
    second.reject(new Error('cleanup failed'));
    await closing;
    expect(warnings.flat().map(String).join(' ')).toContain('cleanup failed');
  });

  it('preserves the existing explicit cleanup timeout and reports an in-flight task only once', async () => {
    const { resources, warnings } = world();
    resources.holdInflight(new Promise<void>(() => {}), 'stuck cleanup');
    await resources.disposeAsync(5);
    expect(warnings).toHaveLength(1);
    expect(warnings.flat().map(String).join(' ')).toContain('stuck cleanup');
  });

  it('manual withdrawal can remove an item without executing it, while late cleanup still executes', async () => {
    const { resources } = world();
    let withdrawn = 0;
    const off = resources.trackWithdrawal(() => withdrawn++);
    resources.withdrawals.remove(off);
    await resources.disposeAsync();
    expect(withdrawn).toBe(0);
    resources.onDispose(() => {
      withdrawn++;
    });
    expect(withdrawn).toBe(1);
  });
});
