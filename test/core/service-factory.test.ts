import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  optional,
  provide,
  serviceFactory,
  services,
} from '../../packages/core/src/index.js';

const apps: App[] = [];
const releases: Array<() => void> = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}

function world() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args) => void warnings.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({
    config: { name: 'factory-audit', plugins: {}, logLevel: 'error' },
    logger,
    disposeTimeoutMs: 0,
  });
  apps.push(app);
  return { app, warnings };
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const app of apps.splice(0)) await app.stop();
});

describe('服务工厂构造与资源回滚', () => {
  it('构造失败与消费者重入关闭共享一次 onDispose', async () => {
    const { app } = world();
    const target = defineService<object>('reentrant-factory-close');
    const gate = deferred();
    let read!: () => unknown;
    let closed = 0;
    let delivered = 0;
    let closing!: Promise<boolean>;
    await app.plugin(
      definePlugin({
        name: 'factory-consumer',
        uses: { services },
        apply({ services }) {
          read = () => services.get(target);
        },
      }),
    );
    app.bind({ provide }).provide(
      target,
      serviceFactory(scope => {
        scope.onDispose(() => {
          closed++;
          return gate.promise.then(() => {
            delivered++;
          });
        });
        closing = app.plugins.unload('factory-consumer');
        throw new Error('factory failed during close');
      }),
    );

    expect(() => read()).toThrow('factory failed during close');
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await tick();
    expect(closed).toBe(1);
    expect(delivered).toBe(0);
    expect(finished).toBe(false);
    gate.resolve();
    await closing;
    await tick();
    expect({ closed, delivered }).toEqual({ closed: 1, delivered: 1 });
  });

  it('失败构造每次立即回滚，已取消的清理不执行，收尾回调只取消', async () => {
    const { app } = world();
    const host = app.bind({ provide, services });
    const broken = defineService<object>('broken-factory');
    let opened = 0;
    let closed = 0;
    let cancelled = 0;
    let drained = 0;
    host.provide(
      broken,
      serviceFactory(scope => {
        opened++;
        scope.track(() => closed++);
        const cancel = scope.onDispose(() => {
          cancelled++;
        });
        cancel();
        scope.onDrain(() => {
          drained++;
        });
        throw new Error('setup failed');
      }),
    );

    for (let i = 0; i < 3; i++) {
      expect(() => host.services.get(broken)).toThrow('setup failed');
      expect(closed).toBe(opened);
    }
    expect(opened).toBe(3);
    expect(cancelled).toBe(0);
    await app.stop();
    expect({ closed, cancelled, drained }).toEqual({ closed: 3, cancelled: 0, drained: 0 });
  });

  it('异步工厂被类型与运行期拒收；拒绝被报告，迟到资源立即撤回', async () => {
    const { app, warnings } = world();
    const host = app.bind({ provide, services });
    const descriptor = defineService<{ value: number }>('async-factory');
    const gate = deferred();
    let tracked = 0;
    let disposed = 0;
    let closed: boolean | undefined;
    // @ts-expect-error 工厂必须同步；此处保留 JavaScript 调用方违反契约时的运行期探针。
    const invalid = serviceFactory<{ value: number }>(async scope => {
      await gate.promise;
      closed = scope.closed;
      scope.track(() => tracked++);
      scope.onDispose(() => {
        disposed++;
      });
      throw new Error('late factory rejection');
    });
    host.provide(descriptor, invalid);

    expect(() => host.services.get(descriptor)).toThrow('必须同步');
    gate.resolve();
    await tick();
    expect({ closed, tracked, disposed }).toEqual({ closed: true, tracked: 1, disposed: 1 });
    expect(warnings.some(message => message.includes('late factory rejection'))).toBe(true);
    await app.stop();
    expect({ tracked, disposed }).toEqual({ tracked: 1, disposed: 1 });
  });

  it('失败构造的异步 track 回滚被关闭等待，交接时旧提供者仍可用', async () => {
    const { app } = world();
    const descriptor = defineService<object>('rollback-factory');
    const gate = deferred();
    const cleanupStarted = deferred();
    const deliveries: string[] = [];
    let providerAlive = true;
    let read: (() => unknown) | undefined;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { services },
        apply({ services }) {
          read = () => services.get(descriptor);
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'provider',
        uses: { provide, lifecycle },
        provides: [descriptor],
        apply({ provide, lifecycle }) {
          lifecycle.onDrain(() => {
            providerAlive = false;
          });
          provide(
            descriptor,
            serviceFactory(scope => {
              scope.track(async () => {
                cleanupStarted.resolve();
                await gate.promise;
                if (!providerAlive) throw new Error('provider already closed');
                deliveries.push('rollback delivered');
              });
              throw new Error('setup failed');
            }),
          );
        },
      }),
    );

    expect(() => read?.()).toThrow('setup failed');
    await cleanupStarted.promise;
    let finished = false;
    const stopped = app.stop().then(() => {
      finished = true;
    });
    await tick();
    expect(finished).toBe(false);
    expect(providerAlive).toBe(true);
    expect(deliveries).toEqual([]);
    gate.resolve();
    await stopped;
    expect(deliveries).toEqual(['rollback delivered']);
    expect(providerAlive).toBe(false);
  });

  it('失败回滚落定即释放旧提供者边，不给后续关闭制造虚假依赖', async () => {
    const { app } = world();
    const descriptor = defineService<object>('released-factory');
    const gate = deferred();
    const trace: string[] = [];
    let read: (() => unknown) | undefined;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { services, lifecycle },
        apply({ services, lifecycle }) {
          read = () => services.get(descriptor);
          lifecycle.onDrain(() => {
            trace.push('consumer');
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'provider',
        uses: { provide, lifecycle },
        provides: [descriptor],
        apply({ provide, lifecycle }) {
          lifecycle.onDrain(() => {
            trace.push('provider');
          });
          provide(
            descriptor,
            serviceFactory(scope => {
              scope.track(() => gate.promise);
              throw new Error('setup failed');
            }),
          );
        },
      }),
    );

    expect(() => read?.()).toThrow('setup failed');
    gate.resolve();
    await tick();
    await app.stop();
    // 两者不再有依赖，后挂的 provider 先收尾。滞留的工厂边会强制反转顺序。
    expect(trace).toEqual(['provider', 'consumer']);
  });
});

describe('服务工厂实例的提供者归属', () => {
  it('换提供者后，保留的旧实例在原提供者关闭前完成数据交接', async () => {
    const { app } = world();
    const descriptor = defineService<{ name: string }>('retained-factory');
    const deliveries: string[] = [];
    let providerAlive = true;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { target: optional(descriptor) },
        apply({ target }) {
          target.follow(() => {});
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'provider-a',
        uses: { provide, lifecycle },
        provides: [descriptor],
        apply({ provide, lifecycle }) {
          lifecycle.onDrain(() => {
            providerAlive = false;
          });
          provide(
            descriptor,
            serviceFactory(scope => {
              scope.onDrain(() => {
                if (!providerAlive) throw new Error('provider already closed');
                deliveries.push('old instance delivered');
              });
              return { name: 'a' };
            }),
          );
        },
      }),
    );
    await app.plugins.idle();
    await app.plugin(
      definePlugin({
        name: 'provider-b',
        uses: { provide },
        provides: [descriptor],
        apply({ provide }) {
          provide(
            descriptor,
            serviceFactory(() => ({ name: 'b' })),
            { priority: 1 },
          );
        },
      }),
    );
    await app.plugins.idle();

    await app.stop();
    expect(deliveries).toEqual(['old instance delivered']);
    expect(providerAlive).toBe(false);
  });

  it('动态 all 创建的非胜者实例，也保留其实际提供者至交接完成', async () => {
    const { app } = world();
    const descriptor = defineService<{ name: string }>('all-factories');
    const deliveries: string[] = [];
    const alive = { a: true, b: true };
    let readAll: (() => string[]) | undefined;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { services },
        apply({ services }) {
          readAll = () => services.all(descriptor).map(entry => entry.instance.name);
        },
      }),
    );
    for (const name of ['a', 'b'] as const) {
      await app.plugin(
        definePlugin({
          name,
          uses: { provide, lifecycle },
          provides: [descriptor],
          apply({ provide, lifecycle }) {
            lifecycle.onDrain(() => {
              alive[name] = false;
            });
            provide(
              descriptor,
              serviceFactory(scope => {
                scope.onDrain(() => {
                  if (!alive[name]) throw new Error(`${name} already closed`);
                  deliveries.push(name);
                });
                return { name };
              }),
              { priority: name === 'a' ? 2 : 1 },
            );
          },
        }),
      );
    }

    expect(readAll?.()).toEqual(['a', 'b']);
    await app.stop();
    expect(deliveries.toSorted()).toEqual(['a', 'b']);
    expect(alive).toEqual({ a: false, b: false });
  });
});
