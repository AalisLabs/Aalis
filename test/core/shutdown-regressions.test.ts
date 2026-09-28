import { describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  provide,
} from '../../packages/core/src/index.js';
import { deferred } from '../helpers/deferred.js';

function quietApp(): App {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => logger,
  };
  return new App({ name: 'shutdown-regressions', logger, disposeTimeoutMs: 2_000 });
}

async function within<T>(work: Promise<T>, ms = 1_000, label = '操作'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 在 ${ms}ms 内未落定`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('停机回归', () => {
  it('disable 的异步清理中开始 stop：释放后 stop 和 idle 均落定，消费者仅交接及清理一次', async () => {
    const app = quietApp();
    const store = defineService<{ save(data: string): void }>('shutdown-regressions:store');
    const entered = deferred();
    const release = deferred();
    const saved: string[] = [];
    const counts = { providerCleanup: 0, consumerDrain: 0, consumerCleanup: 0 };

    await app.plugin(
      definePlugin({
        name: 'provider',
        uses: { provide, lifecycle },
        provides: [store],
        apply({ provide, lifecycle }) {
          provide(store, { save: data => void saved.push(data) });
          lifecycle.onDispose(async () => {
            counts.providerCleanup++;
            entered.resolve();
            await release.promise;
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { store, lifecycle },
        apply({ store, lifecycle }) {
          lifecycle.onDrain(() => {
            counts.consumerDrain++;
            store.require().save('last');
          });
          lifecycle.onDispose(() => {
            counts.consumerCleanup++;
          });
        },
      }),
    );
    await within(app.plugins.idle());

    const disabling = app.plugins.disable('provider');
    let stopping: Promise<void> | undefined;
    try {
      await within(entered.promise);
      stopping = app.stop();
    } finally {
      release.resolve();
    }

    expect(await within(disabling, 1_000, 'disable')).toBe(true);
    await within(stopping!, 1_000, 'stop');
    await within(app.plugins.idle(), 1_000, 'idle');
    expect(saved).toEqual(['last']);
    expect(counts).toEqual({ providerCleanup: 1, consumerDrain: 1, consumerCleanup: 1 });
  });

  async function setupAdminStates() {
    const app = quietApp();
    const effects = { applies: 0, disposes: 0 };
    const missing = defineService<unknown>('shutdown-regressions:missing');
    await app.plugin(definePlugin({ name: 'disabled', apply() {} }), { marker: 'disabled' }, undefined, {
      disabled: true,
    });
    await app.plugin(definePlugin({ name: 'pending', uses: { missing }, apply() {} }), { marker: 'pending' });
    await app.plugin(
      definePlugin({
        name: 'error',
        apply() {
          throw new Error('intentional activation error');
        },
      }),
      { marker: 'error' },
    );
    await app.plugin(
      definePlugin({
        name: 'active',
        uses: { lifecycle },
        apply({ lifecycle }) {
          effects.applies++;
          lifecycle.onDispose(() => {
            effects.disposes++;
          });
        },
      }),
      { marker: 'active' },
    );
    await within(app.plugins.idle());
    expect(Object.fromEntries(app.plugins.getStatus().map(s => [s.instanceId, s.state]))).toEqual({
      disabled: 'disabled',
      pending: 'pending',
      error: 'error',
      active: 'active',
    });
    return { app, effects };
  }

  async function expectAdminRefused(app: App, effects: { applies: number; disposes: number }, phase: string) {
    const ids = ['disabled', 'pending', 'error', 'active'];
    const before = Object.fromEntries(
      ids.map(id => {
        const entry = app.plugins.getPlugin(id)!;
        return [id, { state: entry.state, config: structuredClone(entry.config) }];
      }),
    );
    const beforeEffects = { ...effects };
    const results: Record<string, boolean> = {};
    for (const id of ids) {
      const actions = {
        enable: () => app.plugins.enable(id),
        unload: () => app.plugins.unload(id),
        disable: () => app.plugins.disable(id),
        bounce: () => app.plugins.bounce(id, { config: { changed: true } }),
        updateConfig: () => app.plugins.updateConfig(id, { changed: true }),
      };
      for (const [action, run] of Object.entries(actions)) {
        results[`${id}.${action}`] = await within(run());
      }
    }
    results.register = await within(
      app.plugins.register(
        definePlugin({
          name: `new-${phase}`,
          apply() {
            effects.applies++;
          },
        }),
      ),
    );
    const after = Object.fromEntries(
      ids.map(id => {
        const entry = app.plugins.getPlugin(id);
        return [id, entry && { state: entry.state, config: structuredClone(entry.config) }];
      }),
    );
    expect.soft(results, phase).toEqual(Object.fromEntries(Object.keys(results).map(key => [key, false])));
    expect.soft(after, `${phase}: 状态与配置不应改变`).toEqual(before);
    expect.soft(effects, `${phase}: 不应出现激活或清理副作用`).toEqual(beforeEffects);
    expect.soft(app.plugins.getPlugin(`new-${phase}`)).toBeUndefined();
  }

  it('app:stopping 屏障内，各管理动作拒绝且不改变现有条目', async () => {
    const { app, effects } = await setupAdminStates();
    const entered = deferred();
    const release = deferred();
    app.bind({ events }).events.on('app:stopping', async () => {
      entered.resolve();
      await release.promise;
    });
    const stopping = app.stop();
    try {
      await within(entered.promise);
      await expectAdminRefused(app, effects, 'during-stop');
    } finally {
      release.resolve();
      await within(stopping);
    }
  });

  it('stop 完成后，各管理动作拒绝且不改变现有条目', async () => {
    const { app, effects } = await setupAdminStates();
    await within(app.stop());
    await expectAdminRefused(app, effects, 'after-stop');
    await within(app.plugins.idle());
  });
});
