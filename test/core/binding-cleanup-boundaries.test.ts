import { describe, expect, it } from 'vitest';
import {
  type AalisEvents,
  App,
  definePlugin,
  defineService,
  EventBus,
  type Logger,
  lifecycle,
  provide,
} from '../../packages/core/src/index.js';
import { rootActivation } from '../../packages/core/src/orchestration/app.js';
import { createActivationFixture } from '../helpers/activation.js';

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
    bound.off();
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
    const first = host.create(host.root, 'first');
    const second = host.create(host.root, 'second');
    host.bind(first, { provide }).provide(service, { label: 'A' });
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
    host.bind(second, { provide }).provide(service, { label: 'B' }, { priority: 1 });
    await tick();
    const during = [...active];
    const edges = activation.closeInfo().providers;
    await activation.disposeAsync();
    await host.root.disposeAsync();
    expect({ during, after: [...active] }).toEqual({ during: ['B'], after: [] });
    expect(edges.has(first), 'a failed cleanup still settles and releases its retained edge').toBe(false);
    expect(edges.has(second)).toBe(true);
  });

  it('late cleanup still executes when the diagnostic logger throws', async () => {
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {
        throw new Error('sink failed');
      },
      error() {},
      child: () => logger,
    };
    const { host, activation, caps } = createActivationFixture({ id: 'consumer', logger });
    await activation.disposeAsync();
    let cleaned = false;
    try {
      expect(() =>
        caps.lifecycle.onDispose(() => {
          cleaned = true;
        }),
      ).not.toThrow();
      expect(cleaned).toBe(true);
    } finally {
      await host.root.disposeAsync();
    }
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
    host.bind(host.root, { provide }).provide(resource, {});
    host.bind(activation, { resource }).resource.acquire();
    await activation.disposeAsync();
    await host.root.disposeAsync();
    expect(executions).toBe(1);
  });

  it.each([
    'sync',
    'async',
  ] as const)('%s notification failure does not strand a closed module identity', async failure => {
    class ThrowingBus extends EventBus {
      fail = false;
      override emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void> {
        if (this.fail && event === 'service:unregistered') {
          const error = new Error(`${failure} notification failure`);
          if (failure === 'sync') throw error;
          return Promise.reject(error);
        }
        return super.emit(event, ...args);
      }
    }
    const bus = new ThrowingBus();
    const warnings: unknown[][] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args) => void warnings.push(args),
      error: (...args) => void warnings.push(args),
      child: () => logger,
    };
    const app = new App({ config: { name: 'notify-test', logLevel: 'error', plugins: {} }, events: bus, logger });
    const service = defineService('notification-cleanup');
    const definition = definePlugin({
      name: 'worker',
      uses: { provide },
      provides: [service],
      apply({ provide }) {
        provide(service, {});
      },
    });
    const cap = app.bind({ lifecycle }).lifecycle;
    try {
      const first = await cap.module(definition);
      const oldActivation = [...rootActivation(app).children][0];
      bus.fail = true;
      await expect(first.disposeAsync()).resolves.toBeUndefined();
      expect(rootActivation(app).children.has(oldActivation)).toBe(false);
      const second = await cap.module(definition);
      expect(second.id).toBe('root#worker');
      expect(warnings.flat().map(String).join(' ')).toContain(`${failure} notification failure`);
    } finally {
      bus.fail = false;
      await app.stop();
    }
  });
});
