import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, type Context, LogHub } from '../../packages/core/src/index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('排队的服务下线变化', () => {
  let app: App;
  let releases: Array<() => void>;

  beforeEach(async () => {
    releases = [];
    app = new App({
      config: { name: 'queued-services', logLevel: 'error', plugins: {} },
      logHub: new LogHub(),
    });
    await app.plugins.idle();
  });

  afterEach(async () => {
    for (const release of releases) release();
    await app.stop();
  });

  async function pause(phase: 'activation' | 'disposal') {
    const entered = deferred();
    const gate = deferred();
    releases.push(gate.resolve);
    const registering = app.plugin({
      name: 'busy',
      async apply(ctx) {
        if (phase === 'activation') {
          entered.resolve();
          await gate.promise;
        } else {
          ctx.onDispose(async () => {
            entered.resolve();
            await gate.promise;
          });
        }
      },
    });
    let done: Promise<unknown> = registering;
    if (phase === 'disposal') {
      await registering;
      await app.plugins.idle();
      done = app.plugins.disablePlugin('busy');
    }
    await entered.promise;
    return { release: gate.resolve, done };
  }

  async function consumer(
    name: string,
    optional: string[],
    opts: { bounce?: boolean; dispose?: () => void | Promise<void> } = {},
  ) {
    const state = { applies: 0, disposes: 0, values: [] as unknown[][] };
    await app.plugin({
      name,
      inject: { optional },
      requiresBounceOnDepChange: opts.bounce ?? true,
      apply(ctx: Context) {
        state.applies++;
        state.values.push(optional.map(service => ctx.getService(service)));
        ctx.onDispose(() => {
          state.disposes++;
          return opts.dispose?.();
        });
      },
    });
    await app.plugins.idle();
    return state;
  }

  it.each(['activation', 'disposal'] as const)('%s 占用期间的 optional 下线仍触发一次重建', async phase => {
    const resource = { alive: true };
    const remove = app.ctx.provide('optional-a', resource);
    const state = await consumer('consumer', ['optional-a']);
    const busy = await pause(phase);

    remove();
    await app.plugins.softReload();
    expect(state.applies).toBe(1);

    busy.release();
    await busy.done;
    await app.plugins.idle();

    expect(state).toEqual({ applies: 2, disposes: 1, values: [[resource], [undefined]] });
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
  });

  it('合并多个下线服务与重复通知，只重建命中的显式消费者一次', async () => {
    const removeA = app.ctx.provide('optional-a', {});
    const removeB = app.ctx.provide('optional-b', {});
    const both = await consumer('both', ['optional-a', 'optional-b']);
    const onlyA = await consumer('only-a', ['optional-a']);
    const onlyB = await consumer('only-b', ['optional-b']);
    const unrelated = await consumer('unrelated', ['never-provided']);
    const lazy = await consumer('lazy', ['optional-a'], { bounce: false });
    const busy = await pause('activation');

    removeA();
    removeB();
    await app.ctx.emit('service:unregistered', 'optional-a');
    await app.ctx.emit('service:unregistered', 'optional-b');
    app.ctx.provide('unrelated-service', {});
    await app.plugins.softReload();
    busy.release();
    await busy.done;
    await app.plugins.idle();

    for (const state of [both, onlyA, onlyB]) {
      expect(state.applies).toBe(2);
      expect(state.disposes).toBe(1);
    }
    expect(both.values[1]).toEqual([undefined, undefined]);
    for (const state of [unrelated, lazy]) {
      expect(state.applies).toBe(1);
      expect(state.disposes).toBe(0);
    }
  });

  it('队列消费前服务已恢复，保留仅在服务当前缺失时重建的语义', async () => {
    const remove = app.ctx.provide('optional-a', { version: 1 });
    const state = await consumer('consumer', ['optional-a']);
    const busy = await pause('activation');

    remove();
    const replacement = { version: 2 };
    app.ctx.provide('optional-a', replacement);
    busy.release();
    await busy.done;
    await app.plugins.idle();

    expect(app.ctx.getService('optional-a')).toBe(replacement);
    expect(state.applies).toBe(1);
    expect(state.disposes).toBe(0);
  });

  it.each(['activation', 'disposal'] as const)('%s 期间新登记的消费者只在最新服务状态下首次激活', async phase => {
    const remove = app.ctx.provide('optional-a', {});
    await app.plugins.idle();
    const busy = await pause(phase);
    const values: unknown[] = [];
    let disposes = 0;
    await app.plugin({
      name: 'new-consumer',
      inject: { optional: ['optional-a'] },
      requiresBounceOnDepChange: true,
      apply(ctx) {
        values.push(ctx.getService('optional-a'));
        ctx.onDispose(() => {
          disposes++;
        });
      },
    });
    remove();
    busy.release();
    await busy.done;
    await app.plugins.idle();

    expect(app.plugins.getPlugin('new-consumer')?.state).toBe('active');
    expect(values).toEqual([undefined]);
    expect(disposes).toBe(0);
  });

  it('批次内有的服务恢复、有的仍缺失，仍识别后者的消费者', async () => {
    const removeA = app.ctx.provide('optional-a', {});
    const removeB = app.ctx.provide('optional-b', {});
    const state = await consumer('consumer', ['optional-a', 'optional-b']);
    const busy = await pause('activation');

    removeA();
    removeB();
    const replacement = {};
    app.ctx.provide('optional-a', replacement);
    busy.release();
    await busy.done;
    await app.plugins.idle();

    expect(state.applies).toBe(2);
    expect(state.disposes).toBe(1);
    expect(state.values[1]).toEqual([replacement, undefined]);
  });

  it.each(['activation', 'disposal'] as const)('%s 期间 shutdown 优先于已排队的普通变化', async phase => {
    const remove = app.ctx.provide('optional-a', {});
    const state = await consumer('consumer', ['optional-a']);
    const busy = await pause(phase);

    remove();
    await app.plugins.stopAll();
    await app.plugins.softReload();
    expect(app.plugins.isShuttingDown()).toBe(true);
    busy.release();
    await busy.done;
    await app.plugins.idle();

    expect(state.applies).toBe(1);
    expect(state.disposes).toBe(1);
    expect(app.plugins.getPlugin('consumer')?.state).toBe('disposed');
  });

  it('idle 等待排队变化引起的异步清理和重新激活', async () => {
    const remove = app.ctx.provide('optional-a', {});
    const entered = deferred();
    const cleanup = deferred();
    releases.push(cleanup.resolve);
    const state = await consumer('consumer', ['optional-a'], {
      dispose: async () => {
        entered.resolve();
        await cleanup.promise;
      },
    });
    const busy = await pause('activation');
    remove();
    let settled = false;
    const idle = app.plugins.idle().then(() => {
      settled = true;
    });
    busy.release();

    expect(await Promise.race([entered.promise.then(() => 'cleanup'), idle.then(() => 'idle')])).toBe('cleanup');
    expect(settled).toBe(false);
    expect(state.applies).toBe(1);
    cleanup.resolve();
    await idle;
    await busy.done;
    expect(state.applies).toBe(2);
    expect(state.disposes).toBe(1);
  });

  it('一批清理期间继续下线的服务不丢失，也不让已清理的消费者重复重建', async () => {
    const removeA = app.ctx.provide('optional-a', {});
    const removeB = app.ctx.provide('optional-b', {});
    const entered = deferred();
    const cleanup = deferred();
    releases.push(cleanup.resolve);
    const both = await consumer('both', ['optional-a', 'optional-b'], {
      dispose: async () => {
        entered.resolve();
        await cleanup.promise;
      },
    });
    const onlyB = await consumer('only-b', ['optional-b']);

    removeA();
    await entered.promise;
    removeB();
    cleanup.resolve();
    await app.plugins.idle();

    for (const state of [both, onlyB]) {
      expect(state.applies).toBe(2);
      expect(state.disposes).toBe(1);
    }
    expect(both.values[1]).toEqual([undefined, undefined]);
    expect(onlyB.values[1]).toEqual([undefined]);
  });
});
