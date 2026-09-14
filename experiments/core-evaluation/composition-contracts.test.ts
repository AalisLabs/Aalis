import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';

// These probes intentionally assert the observed snapshot. A green Vitest run
// verifies reproduction; consult goalSatisfied to assess the proposed contract.
const observations: Array<{
  id: string;
  goal: string;
  classification: 'contract-gap' | 'documented-limitation';
  goalSatisfied: boolean;
  observed: unknown;
}> = [];

afterAll(() => {
  const directory = new URL('./results/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL('composition-contracts.json', directory), `${JSON.stringify(observations, null, 2)}\n`);
});

const makeApp = () => new App({ config: { name: 'core-evaluation', logLevel: 'error', plugins: {} } });

describe('composition contracts: observed behavior, not a pass score', () => {
  it('C1: shutdown ordering must account for the selected provider, including its dependencies', async () => {
    const app = makeApp();
    const order: string[] = [];
    const fallback = { name: 'fallback', closed: false };
    const primary = { name: 'primary', closed: false };
    let seenDuringCleanup: string | undefined;
    await app.plugin({
      name: 'fallback',
      provides: ['store'],
      apply(ctx) {
        ctx.provide('store', fallback, { priority: 0 });
        ctx.onDispose(() => {
          fallback.closed = true;
          order.push('fallback-closed');
        });
      },
    });
    await app.plugin({
      name: 'consumer',
      inject: { required: ['store'] },
      apply(ctx) {
        ctx.onDispose(() => {
          // The recommended lazy read is used, rather than a cached reference.
          const store = ctx.getService<typeof primary>('store');
          seenDuringCleanup = store?.name;
          order.push(`consumer-flush:${store?.name}:${store?.closed}`);
        });
      },
    });
    await app.plugin({
      name: 'gate',
      provides: ['gate'],
      apply: ctx => {
        ctx.provide('gate', {});
      },
    });
    await app.plugin({
      name: 'primary',
      inject: { required: ['gate'] },
      provides: ['store'],
      apply(ctx) {
        ctx.provide('store', primary, { priority: 10 });
        ctx.onDispose(() => {
          primary.closed = true;
          order.push('primary-closed');
        });
      },
    });
    expect(app.ctx.getService('store')).toBe(primary);
    await app.stop();
    observations.push({
      id: 'C1',
      goal: 'The provider selected before shutdown remains available until its consumers finish cleanup.',
      classification: 'contract-gap',
      goalSatisfied:
        seenDuringCleanup === 'primary' &&
        order.indexOf('primary-closed') > order.indexOf('consumer-flush:primary:false'),
      observed: { selectedBeforeShutdown: 'primary', seenDuringCleanup, order },
    });
    expect(order).toEqual(['primary-closed', 'consumer-flush:fallback:false', 'fallback-closed']);
  });

  it('C2: useModule returns a synchronous disposer, so awaiting it does not join asynchronous cleanup', async () => {
    const app = makeApp();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let closed = false;
    let finished!: () => void;
    const completed = new Promise<void>(resolve => {
      finished = resolve;
    });
    const off = await app.ctx.useModule({
      name: 'async-resource',
      apply(ctx) {
        ctx.onDispose(async () => {
          await gate;
          closed = true;
          finished();
        });
      },
    });
    await off();
    observations.push({
      id: 'C2',
      goal: 'A dynamically mounted module exposes an awaitable resource-release boundary.',
      classification: 'documented-limitation',
      goalSatisfied: closed,
      observed: { closedAfterAwaitingReturnedDisposer: closed },
    });
    expect(closed).toBe(false);
    release();
    await completed;
    await app.stop();
  });

  it('C3: duplicate human-readable fork ids collide in resource ownership', async () => {
    const app = makeApp();
    const left = app.ctx.fork('same-label');
    const right = app.ctx.fork('same-label');
    right.provide('right-only', { alive: true });
    expect(right.getService('right-only')).toEqual({ alive: true });
    await left.disposeAsync();
    const siblingResourcePresent = right.getService('right-only') !== undefined;
    observations.push({
      id: 'C3',
      goal: "Two separately created contexts cannot remove each other's resources just because their labels match.",
      classification: 'documented-limitation',
      goalSatisfied: siblingResourcePresent,
      observed: { rightDisposed: right.disposed, siblingResourcePresent },
    });
    expect(right.disposed).toBe(false);
    expect(siblingResourcePresent).toBe(false);
    await app.stop();
  });
});
