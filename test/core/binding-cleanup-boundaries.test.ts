import { describe, expect, it } from 'vitest';
import { definePlugin, defineService, events, type Logger, provide } from '../../packages/core/src/index.js';
import { createActivationFixture } from '../helpers/activation.js';
import { createInspectableApp, rootActivation } from '../helpers/inspectable-app.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('binding cleanup boundaries', () => {
  it('manual withdrawal that starts closing is awaited before its asynchronous result has been returned', async () => {
    const { host, activation } = createActivationFixture({ id: 'consumer' });
    let release!: () => void;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    let closing!: Promise<void>;
    const descriptor = defineService<never, { off(): void }>('manual-close', port => ({
      off: port.track(() => {
        closing = activation.disposeAsync();
        return pending;
      }),
    }));
    const { bound } = host.bind(activation, { bound: descriptor });
    bound.use.off();
    let closed = false;
    const observed = closing.then(() => {
      closed = true;
    });
    await tick();
    const premature = closed;
    release();
    await observed;
    await host.root.disposeAsync();
    expect(premature).toBe(false);
  });

  it('a throwing cleanup then getter does not block other followers or retain the old dependency edge', async () => {
    const { host, activation } = createActivationFixture({ id: 'consumer' });
    const service = defineService<{ label: string }>('cleanup-result');
    const first = host.create('first');
    const second = host.create('second');
    const offA = host.bind(first, { provide }).provide.use(service, { label: 'A' });
    const { ref } = host.bind(activation, { ref: service });
    const active = new Set<string>();
    ref.follow(() => () => ({
      // biome-ignore lint/suspicious/noThenProperty: deliberate malformed thenable tests cleanup isolation
      get then() {
        throw new Error('then getter failed');
      },
    }));
    ref.follow(provider => {
      active.add(provider.label);
      return () => {
        active.delete(provider.label);
      };
    });
    host.bind(second, { provide }).provide.use(service, { label: 'B' }, { priority: 1 });
    await tick();
    // A 撤掉之后只剩跟随边能把 first 留在提供者里：声明的服务对全部在场的提供者建边
    offA();
    const during = [...active];
    const edges = activation.providers();
    await activation.disposeAsync();
    await host.root.disposeAsync();
    expect({ during, after: [...active] }).toEqual({ during: ['B'], after: [] });
    expect(edges.has(first), 'a failed cleanup still settles and releases its retained edge').toBe(false);
    expect(edges.has(second)).toBe(true);
  });

  it.each(['follow', 'registrar'] as const)('%s consumes a custom cleanup thenable only once', async mode => {
    const { host, activation } = createActivationFixture({ id: 'consumer' });
    let executions = 0;
    const cleanup = {
      // biome-ignore lint/suspicious/noThenProperty: explicit thenable verifies single Promise assimilation
      then(resolve: () => void) {
        executions++;
        resolve();
      },
    };
    const resource = defineService<object, { acquire(): void }>('cleanup-thenable', port => ({
      acquire() {
        if (mode === 'follow') {
          port.follow(() => () => cleanup);
        } else {
          port.registrar<string>({ key: item => item, register: () => () => cleanup }).add('item');
        }
      },
    }));
    host.bind(host.root, { provide }).provide.use(resource, {});
    host.bind(activation, { resource }).resource.use.acquire();
    await activation.disposeAsync();
    await host.root.disposeAsync();
    expect(executions).toBe(1);
  });

  it.each([
    'sync',
    'async',
  ] as const)('%s listener failure on service:changed does not strand a closed plugin identity', async failure => {
    const warnings: unknown[][] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args) => void warnings.push(args),
      error: (...args) => void warnings.push(args),
      child: () => logger,
    };
    const app = createInspectableApp({ name: 'notify-test', logLevel: 'error', logger });
    const service = defineService('notification-cleanup');
    const definition = definePlugin({
      name: 'worker',
      uses: { provide },
      provides: [service],
      apply({ provide }) {
        provide.use(service, {});
      },
    });
    let fail = false;
    app.bind({ events }).events.use.on('service:changed', () => {
      if (!fail) return;
      const error = new Error(`${failure} notification failure`);
      if (failure === 'sync') throw error;
      return Promise.reject(error);
    });
    try {
      await app.plugin(definition);
      const oldActivation = [...rootActivation(app).children][0];
      fail = true;
      await expect(app.plugins.unload('worker')).resolves.toBe(true);
      expect(rootActivation(app).children.has(oldActivation)).toBe(false);
      await expect(app.plugin(definition)).resolves.toBe(true);
      expect([...rootActivation(app).children].map(child => child.id)).toEqual(['worker']);
      expect(warnings.flat().map(String).join(' ')).toContain(`${failure} notification failure`);
    } finally {
      fail = false;
      await app.stop();
    }
  });
});
