import { afterEach, describe, expect, it } from 'vitest';
import { type BoundTools, tools } from '../../packages/api-tools/src/index.js';
import {
  type App,
  definePlugin,
  defineService,
  type Logger,
  optional,
  provide,
} from '../../packages/core/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import { activationHost, createInspectableApp, rootActivation } from '../helpers/inspectable-app.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function world() {
  const warnings: unknown[][] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args) => void warnings.push(args),
    error: (...args) => void warnings.push(args),
    child: () => logger,
  };
  const app = createInspectableApp({ config: { name: 'registrar-test', logLevel: 'error', plugins: {} }, logger });
  apps.push(app);
  return { app, warnings, publish: app.bind({ provide }).provide };
}

interface Item {
  key: string;
  value: string;
  during?: () => void;
  cleanup?: () => unknown;
  fail?: boolean;
}

function hub() {
  const live = new Map<symbol, string>();
  return {
    values: () => [...live.values()],
    register(item: Item): () => unknown {
      // A throwing register has not acquired a resource; its reentrant registration still owns its own handle.
      if (item.fail) {
        item.during?.();
        throw new Error('registration failed');
      }
      const token = Symbol(item.key);
      live.set(token, item.value);
      item.during?.();
      return () => {
        live.delete(token);
        return item.cleanup?.();
      };
    },
  };
}

const registry = defineService<ReturnType<typeof hub>, { add(item: Item): () => void }>('registrar-reentry', port =>
  port.registrar<Item>({
    key: item => item.key,
    register: (provider, item) => provider.register(item),
  }),
);

describe('registrar ownership survives callbacks that reenter the same key', () => {
  it.each([true, false])('latest registration wins with provider already present = %s', async present => {
    const { app, publish } = world();
    const first = hub();
    const second = hub();
    if (present) publish(registry, first);
    const host = activationHost(app);
    const ctx = host.create(rootActivation(app), 'consumer');
    const bound = host.bind(ctx, { registry: optional(registry) }).registry;
    const off = bound.add({
      key: 'same',
      value: 'outer',
      during: () => bound.add({ key: 'same', value: 'inner' }),
    });
    if (!present) {
      publish(registry, first);
      await tick();
    }
    expect(first.values()).toEqual(['inner']);
    off();
    expect(first.values(), 'obsolete outer handle cannot remove the replacement').toEqual(['inner']);
    publish(registry, second, { priority: 1 });
    await tick();
    expect(first.values()).toEqual([]);
    expect(second.values()).toEqual(['inner']);
    await ctx.disposeAsync();
    expect(second.values()).toEqual([]);
  });

  it('a failed outer registration does not delete a successful reentrant replacement', async () => {
    const { app, publish } = world();
    const provider = hub();
    publish(registry, provider);
    const host = activationHost(app);
    const ctx = host.create(rootActivation(app), 'consumer');
    const bound = host.bind(ctx, { registry }).registry;
    expect(() =>
      bound.add({
        key: 'same',
        value: 'failed',
        fail: true,
        during: () => bound.add({ key: 'same', value: 'inner' }),
      }),
    ).toThrow('registration failed');
    expect(provider.values()).toEqual(['inner']);
    await ctx.disposeAsync();
    expect(provider.values()).toEqual([]);
  });

  it('replacement from the old cleanup wins; its in-flight cleanup is awaited', async () => {
    const { app, publish } = world();
    const provider = hub();
    publish(registry, provider);
    const host = activationHost(app);
    const ctx = host.create(rootActivation(app), 'consumer');
    const bound = host.bind(ctx, { registry }).registry;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {
      finish = resolve;
    });
    bound.add({
      key: 'same',
      value: 'old',
      cleanup() {
        bound.add({ key: 'same', value: 'inner' });
        return pending;
      },
    });
    bound.add({ key: 'same', value: 'outer' });
    expect(provider.values()).toEqual(['inner']);
    let closed = false;
    const closing = ctx.disposeAsync().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(provider.values()).toEqual([]);
  });

  it('a stale registration cleanup may throw without removing the live replacement', async () => {
    const { app, publish, warnings } = world();
    const provider = hub();
    publish(registry, provider);
    const host = activationHost(app);
    const ctx = host.create(rootActivation(app), 'consumer');
    const bound = host.bind(ctx, { registry }).registry;
    bound.add({
      key: 'same',
      value: 'outer',
      during: () => bound.add({ key: 'same', value: 'inner' }),
      cleanup: () => {
        throw new Error('withdraw failed');
      },
    });
    expect(provider.values()).toEqual(['inner']);
    expect(warnings.flat().map(String).join(' ')).toContain('withdraw failed');
    await ctx.disposeAsync();
    expect(provider.values()).toEqual([]);
  });

  it('asynchronous withdrawal of a superseded registration is awaited and rejection is isolated', async () => {
    const { app, publish, warnings } = world();
    const provider = hub();
    publish(registry, provider);
    const host = activationHost(app);
    const ctx = host.create(rootActivation(app), 'consumer');
    const bound = host.bind(ctx, { registry }).registry;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    bound.add({
      key: 'same',
      value: 'outer',
      during: () => bound.add({ key: 'same', value: 'inner' }),
      cleanup: () => pending,
    });
    expect(provider.values()).toEqual(['inner']);
    let closed = false;
    const closing = ctx.disposeAsync().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    reject(new Error('async withdraw failed'));
    await closing;
    expect(provider.values()).toEqual([]);
    expect(warnings.flat().map(String).join(' ')).toContain('async withdraw failed');
  });

  it('closing inside register withdraws the returned handle and waits for asynchronous cleanup', async () => {
    const { app, publish } = world();
    const provider = hub();
    publish(registry, provider);
    const host = activationHost(app);
    const ctx = host.create(rootActivation(app), 'consumer');
    const bound = host.bind(ctx, { registry }).registry;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {
      finish = resolve;
    });
    let closing!: Promise<void>;
    bound.add({
      key: 'same',
      value: 'late',
      during() {
        closing = ctx.disposeAsync();
      },
      cleanup: () => pending,
    });
    expect(provider.values()).toEqual([]);
    let closed = false;
    const observed = closing.then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    finish();
    await observed;
  });

  it('real tools cannot execute a same-key orphan after the consumer unloads', async () => {
    const { app, publish } = world();
    const provider = new ToolRegistry(app.logger);
    publish(tools, provider);
    let bound!: BoundTools;
    await app.plugin(
      definePlugin({
        name: 'tool-consumer',
        uses: { tools },
        apply({ tools }) {
          bound = tools;
        },
      }),
    );
    const definition = {
      type: 'function' as const,
      function: { name: 'same', description: 'same', parameters: { type: 'object' as const, properties: {} } },
    };
    const register = provider.register.bind(provider);
    let once = true;
    provider.register = (tool, owner) => {
      const off = register(tool, owner);
      if (once) {
        once = false;
        bound.register({ definition, handler: async () => 'orphan' });
      }
      return off;
    };
    bound.register({ definition, handler: async () => 'outer' });
    await app.plugins.unload('tool-consumer');
    expect((await provider.execute('same', {}, { sessionId: 'test', platform: 'test' })).content).toContain('未找到');
  });
});
