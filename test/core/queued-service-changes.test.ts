import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type Events,
  events,
  LogHub,
  lifecycle,
  optional,
  type Provide,
  provide,
  type Services,
  services,
} from '../../packages/core/src/index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

const svcA = defineService<unknown>('qsc-a');
const svcB = defineService<unknown>('qsc-b');
const svcNever = defineService<unknown>('qsc-never');

describe('排队的服务下线变化', () => {
  let app: App;
  let host: { provide: Provide; services: Services; events: Events };
  let releases: Array<() => void>;

  beforeEach(async () => {
    releases = [];
    app = new App({
      config: { name: 'queued-services', logLevel: 'error', plugins: {} },
      logHub: new LogHub(),
    });
    host = app.bind({ provide, services, events });
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
    const registering = app.plugin(
      definePlugin({
        name: 'busy',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          if (phase === 'activation') {
            entered.resolve();
            await gate.promise;
          } else {
            lifecycle.onDispose(async () => {
              entered.resolve();
              await gate.promise;
            });
          }
        },
      }),
    );
    let done: Promise<unknown> = registering;
    if (phase === 'disposal') {
      await registering;
      await app.plugins.idle();
      expect(app.plugins.getPlugin('busy')?.state).toBe('active');
      done = app.plugins.disable('busy');
    }
    await entered.promise;
    return { release: gate.resolve, done };
  }

  async function requiredA(name: string, opts: { dispose?: () => void | Promise<void> } = {}) {
    const state = { applies: 0, disposes: 0, values: [] as unknown[][] };
    await app.plugin(
      definePlugin({
        name,
        uses: { lifecycle, a: svcA },
        apply({ lifecycle, a }) {
          state.applies++;
          state.values.push([a.current]);
          lifecycle.onDispose(() => {
            state.disposes++;
            return opts.dispose?.();
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin(name)?.state).toBe('active');
    return state;
  }

  async function requiredB(name: string) {
    const state = { applies: 0, disposes: 0, values: [] as unknown[][] };
    await app.plugin(
      definePlugin({
        name,
        uses: { lifecycle, b: svcB },
        apply({ lifecycle, b }) {
          state.applies++;
          state.values.push([b.current]);
          lifecycle.onDispose(() => {
            state.disposes++;
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin(name)?.state).toBe('active');
    return state;
  }

  async function requiredBoth(name: string, opts: { dispose?: () => void | Promise<void> } = {}) {
    const state = { applies: 0, disposes: 0, values: [] as unknown[][] };
    await app.plugin(
      definePlugin({
        name,
        uses: { lifecycle, a: svcA, b: svcB },
        apply({ lifecycle, a, b }) {
          state.applies++;
          state.values.push([a.current, b.current]);
          lifecycle.onDispose(() => {
            state.disposes++;
            return opts.dispose?.();
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin(name)?.state).toBe('active');
    return state;
  }

  it.each(['activation', 'disposal'] as const)('%s 占用期间的 required 下线仍被消化（转 pending）', async phase => {
    const resource = { alive: true };
    const remove = host.provide(svcA, resource);
    const state = await requiredA('consumer');
    const busy = await pause(phase);

    remove();
    await app.plugins.softReload();
    expect(state.applies).toBe(1);

    busy.release();
    await busy.done;
    await app.plugins.idle();

    expect(state.applies).toBe(1);
    expect(state.disposes).toBe(1);
    expect(state.values).toEqual([[resource]]);
    expect(app.plugins.getPlugin('consumer')?.state).toBe('pending');
  });

  it('合并多个下线服务与重复通知，只停用命中的 required 消费者一次', async () => {
    const removeA = host.provide(svcA, {});
    const removeB = host.provide(svcB, {});
    const both = await requiredBoth('both');
    const onlyA = await requiredA('only-a');
    const onlyB = await requiredB('only-b');
    const unrelated = { applies: 0, disposes: 0 };
    await app.plugin(
      definePlugin({
        name: 'unrelated',
        uses: { lifecycle, never: optional(svcNever) },
        apply({ lifecycle }) {
          unrelated.applies++;
          lifecycle.onDispose(() => {
            unrelated.disposes++;
          });
        },
      }),
    );
    const lazy = { applies: 0, disposes: 0 };
    await app.plugin(
      definePlugin({
        name: 'lazy',
        uses: { lifecycle, a: optional(svcA) },
        apply({ lifecycle }) {
          lazy.applies++;
          lifecycle.onDispose(() => {
            lazy.disposes++;
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('unrelated')?.state).toBe('active');
    expect(app.plugins.getPlugin('lazy')?.state).toBe('active');
    const busy = await pause('activation');

    removeA();
    removeB();
    await host.events.emit('service:unregistered', svcA.name);
    await host.events.emit('service:unregistered', svcB.name);
    host.provide(svcNever, {});
    await app.plugins.softReload();
    busy.release();
    await busy.done;
    await app.plugins.idle();

    for (const state of [both, onlyA, onlyB]) {
      expect(state.applies).toBe(1);
      expect(state.disposes).toBe(1);
    }
    expect(app.plugins.getPlugin('both')?.state).toBe('pending');
    expect(app.plugins.getPlugin('only-a')?.state).toBe('pending');
    expect(app.plugins.getPlugin('only-b')?.state).toBe('pending');
    expect(unrelated).toEqual({ applies: 1, disposes: 0 });
    expect(lazy).toEqual({ applies: 1, disposes: 0 });
  });

  it('队列消费前服务已恢复，容器现态为真相——required 消费者不拆', async () => {
    const remove = host.provide(svcA, { version: 1 });
    const state = await requiredA('consumer');
    const busy = await pause('activation');

    remove();
    const replacement = { version: 2 };
    host.provide(svcA, replacement);
    busy.release();
    await busy.done;
    await app.plugins.idle();

    expect(host.services.get(svcA)).toBe(replacement);
    expect(state.applies).toBe(1);
    expect(state.disposes).toBe(0);
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
  });

  it.each([
    'activation',
    'disposal',
  ] as const)('%s 期间新登记的 required 消费者只在最新服务状态下首次激活', async phase => {
    const remove = host.provide(svcA, {});
    await app.plugins.idle();
    const busy = await pause(phase);
    const values: unknown[] = [];
    let disposes = 0;
    await app.plugin(
      definePlugin({
        name: 'new-consumer',
        uses: { lifecycle, a: svcA },
        apply({ lifecycle, a }) {
          values.push(a.current);
          lifecycle.onDispose(() => {
            disposes++;
          });
        },
      }),
    );
    remove();
    busy.release();
    await busy.done;
    await app.plugins.idle();

    // 登记时服务还在，但排队消化时已经没有——首次激活不得对着过期「在场」发生
    expect(app.plugins.getPlugin('new-consumer')?.state).toBe('pending');
    expect(values).toEqual([]);
    expect(disposes).toBe(0);
  });

  it('批次内有的服务恢复、有的仍缺失，仍识别后者的 required 消费者', async () => {
    const removeA = host.provide(svcA, {});
    const removeB = host.provide(svcB, {});
    const state = await requiredBoth('consumer');
    const busy = await pause('activation');

    removeA();
    removeB();
    const replacement = {};
    host.provide(svcA, replacement);
    busy.release();
    await busy.done;
    await app.plugins.idle();

    expect(state.applies).toBe(1);
    expect(state.disposes).toBe(1);
    expect(app.plugins.getPlugin('consumer')?.state).toBe('pending');
    expect(host.services.get(svcA)).toBe(replacement);
    expect(host.services.get(svcB)).toBeUndefined();
  });

  it.each(['activation', 'disposal'] as const)('%s 期间 shutdown 优先于已排队的普通变化', async phase => {
    // optional 下线在新契约里本不会拆消费者；这里要钉的是：占用期间排进来的
    // 普通变化不得在停机之外再拆一次。消费者保持 active 直到 shutdown 成批关掉。
    const remove = host.provide(svcA, {});
    const state = { applies: 0, disposes: 0 };
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { lifecycle, a: optional(svcA) },
        apply({ lifecycle }) {
          state.applies++;
          lifecycle.onDispose(() => {
            state.disposes++;
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
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
    const remove = host.provide(svcA, {});
    const entered = deferred();
    const cleanup = deferred();
    releases.push(cleanup.resolve);
    const state = await requiredA('consumer', {
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
    host.provide(svcA, { restored: true });
    cleanup.resolve();
    await idle;
    await busy.done;
    expect(state.applies).toBe(2);
    expect(state.disposes).toBe(1);
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
  });

  it('一批清理期间继续下线的服务不丢失，也不让已清理的消费者重复重建', async () => {
    const removeA = host.provide(svcA, {});
    const removeB = host.provide(svcB, {});
    const entered = deferred();
    const cleanup = deferred();
    releases.push(cleanup.resolve);
    const both = await requiredBoth('both', {
      dispose: async () => {
        entered.resolve();
        await cleanup.promise;
      },
    });
    const onlyB = await requiredB('only-b');

    removeA();
    await entered.promise;
    removeB();
    cleanup.resolve();
    await app.plugins.idle();

    expect(both.applies).toBe(1);
    expect(both.disposes).toBe(1);
    expect(onlyB.applies).toBe(1);
    expect(onlyB.disposes).toBe(1);
    expect(app.plugins.getPlugin('both')?.state).toBe('pending');
    expect(app.plugins.getPlugin('only-b')?.state).toBe('pending');
  });
});
