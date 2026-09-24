import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  config,
  definePlugin,
  defineService,
  events,
  lifecycle,
  optional,
  type PluginDefinition,
  provide,
  type ServiceRef,
} from '../../packages/core/src/index.js';
import type { PluginManager } from '../../packages/core/src/orchestration/plugin.js';

// activating 窗口里的管理动作（unload / disable / bounce / updateConfig 撞上在飞 apply）
// 由 admin-during-activation.test.ts 守；本文件钉调度稳态路径。

interface ScratchState {
  applied: string[];
  disposed: string[];
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function makeApp(): { app: App; state: ScratchState } {
  const app = new App({ config: { name: 'TestApp', logLevel: 'error', plugins: {} } });
  apps.push(app);
  return { app, state: { applied: [], disposed: [] } };
}

function makePlugin(
  name: string,
  state: ScratchState,
  overrides: Partial<Pick<PluginDefinition, 'reusable'>> = {},
): PluginDefinition {
  return definePlugin({
    name,
    uses: { lifecycle },
    apply({ lifecycle }) {
      state.applied.push(name);
      lifecycle.onDispose(() => {
        state.disposed.push(name);
      });
    },
    ...overrides,
  });
}

const mysvc = defineService<{ ok: boolean; tag?: string }>('pm-mysvc');
const serviceA = defineService<{ ping(): string }>('pm-serviceA');
const shutdownSvc = defineService<Record<string, never>>('pm-shutdown-svc');

describe('App plugin lifecycle', () => {
  it('register → activate → unload 走完生命周期', async () => {
    const { app, state } = makeApp();
    await app.plugin(makePlugin('p1', state));
    await app.plugins.idle();
    expect(state.applied).toEqual(['p1']);
    expect(app.plugins.getPlugin('p1')?.state).toBe('active');

    await app.plugins.unload('p1');
    expect(state.disposed).toEqual(['p1']);
  });

  it('依赖不满足时变为 pending；提供者激活后自动 active', async () => {
    const { app, state } = makeApp();
    const dependent = definePlugin({
      name: 'consumer',
      uses: { lifecycle, mysvc },
      apply({ lifecycle }) {
        state.applied.push('consumer');
        lifecycle.onDispose(() => {
          state.disposed.push('consumer');
        });
      },
    });
    const provider = definePlugin({
      name: 'provider',
      provides: [mysvc],
      uses: { provide },
      apply({ provide }) {
        provide(mysvc, { ok: true });
        state.applied.push('provider');
      },
    });

    await app.plugin(dependent);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('pending');
    expect(state.applied).not.toContain('consumer');

    await app.plugin(provider);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    expect(state.applied).toContain('consumer');
  });

  it('禁用 active 插件 → dispose 副作用 + state 转为 disabled', async () => {
    const { app, state } = makeApp();
    await app.plugin(makePlugin('p', state));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');

    await app.plugins.disable('p');
    expect(app.plugins.getPlugin('p')?.state).toBe('disabled');
    expect(state.disposed).toContain('p');

    await app.plugins.enable('p');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
  });

  it('apply 抛错 → state=error，错误信息记录到 entry.error', async () => {
    const { app } = makeApp();
    await app.plugin(
      definePlugin({
        name: 'boom',
        apply: () => {
          throw new Error('boom-detail');
        },
      }),
    );
    await app.plugins.idle();
    const entry = app.plugins.getPlugin('boom');
    expect(entry?.state).toBe('error');
    expect(entry?.error).toContain('boom-detail');
  });

  it('reusable 插件支持多实例注册，不同 instanceId 独立 dispose', async () => {
    const { app, state } = makeApp();
    const reusable = definePlugin({
      name: 'multi',
      reusable: true,
      uses: { lifecycle },
      apply({ lifecycle }) {
        state.applied.push(lifecycle.id);
        lifecycle.onDispose(() => {
          state.disposed.push(lifecycle.id);
        });
      },
    });
    await app.plugin(reusable);
    await app.plugins.register(reusable, {}, 'multi:one');
    await app.plugins.register(reusable, {}, 'multi:two');
    await app.plugins.idle();
    expect(state.applied).toContain('multi');
    expect(state.applied).toContain('multi:one');
    expect(state.applied).toContain('multi:two');
    expect(app.plugins.getPlugin('multi')?.state).toBe('active');
    expect(app.plugins.getPlugin('multi:one')?.state).toBe('active');
    expect(app.plugins.getPlugin('multi:two')?.state).toBe('active');

    await app.plugins.unload('multi:one');
    expect(state.disposed).toContain('multi:one');
    expect(app.plugins.getPlugin('multi:one')).toBeUndefined();
    expect(app.plugins.getPlugin('multi')).toBeDefined();
  });

  it('非 reusable 插件不允许多实例', async () => {
    const { app, state } = makeApp();
    const solo = makePlugin('solo', state);
    await app.plugin(solo);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('solo')?.state).toBe('active');
    await app.plugins.register(solo, {}, 'solo:extra');
    expect(app.plugins.getPlugin('solo:extra')).toBeUndefined();
  });

  it('provides 声明与实际注册不符 → state=error', async () => {
    const { app } = makeApp();
    const missing = defineService<unknown>('pm-nonexistent-svc');
    await app.plugin(
      definePlugin({
        name: 'liar',
        provides: [missing],
        apply() {},
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('liar')?.state).toBe('error');
  });

  it('optional 依赖不级联 bounce：下游每次查询拿到当前提供者', async () => {
    const { app } = makeApp();
    const eventsLog: string[] = [];
    let svc!: ServiceRef<{ ok: boolean; tag?: string }>;

    await app.plugin(
      definePlugin({
        name: 'svc-provider',
        provides: [mysvc],
        uses: { provide, config },
        apply({ provide, config }) {
          const tag = typeof config.tag === 'string' ? config.tag : 'v1';
          provide(mysvc, { ok: true, tag });
          eventsLog.push(`provider:apply:${tag}`);
        },
      }),
      { tag: 'v1' },
    );
    await app.plugin(
      definePlugin({
        name: 'svc-consumer',
        uses: { lifecycle, mysvc: optional(mysvc) },
        apply({ lifecycle, mysvc }) {
          svc = mysvc;
          eventsLog.push('consumer:apply');
          lifecycle.onDispose(() => {
            eventsLog.push('consumer:dispose');
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('svc-consumer')?.state).toBe('active');
    expect(svc.current?.tag).toBe('v1');

    await app.plugins.updateConfig('svc-provider', { tag: 'v2' });
    await app.plugins.idle();

    expect(eventsLog).not.toContain('consumer:dispose');
    expect(svc.current?.tag).toBe('v2');
  });

  it('updateConfig 在 active 时触发重激活', async () => {
    const { app } = makeApp();
    const log: Array<Record<string, unknown>> = [];
    await app.plugin(
      definePlugin({
        name: 'rcfg',
        uses: { config, lifecycle },
        apply({ config, lifecycle }) {
          log.push({ ...config });
          lifecycle.onDispose(() => {
            log.push({ disposed: true });
          });
        },
      }),
      { v: 1 },
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('rcfg')?.state).toBe('active');
    expect(log).toEqual([{ v: 1 }]);

    await app.plugins.updateConfig('rcfg', { v: 2 });
    await app.plugins.idle();
    expect(log).toContainEqual({ disposed: true });
    expect(log).toContainEqual({ v: 2 });
  });

  it('stopAll: 按拓扑逆序 dispose（消费者先关、提供者后关）', async () => {
    const { app } = makeApp();
    const order: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'svc-A',
        provides: [serviceA],
        uses: { provide, lifecycle },
        apply({ provide, lifecycle }) {
          provide(serviceA, { ping: () => 'pong' });
          lifecycle.onDispose(() => {
            order.push('svc-A.dispose');
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'cons-B',
        uses: { lifecycle, serviceA },
        apply({ lifecycle }) {
          lifecycle.onDispose(() => {
            order.push('cons-B.dispose');
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('cons-B')?.state).toBe('active');

    await (app.plugins as PluginManager).stopAll();
    expect(order).toEqual(['cons-B.dispose', 'svc-A.dispose']);
    expect(await app.plugins.bounce('svc-A'), '停机后拒绝重建').toBe(false);
  });

  it('stopAll: 关机标志屏蔽 service:unregistered 反应式重算', async () => {
    const { app } = makeApp();
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'p-svc',
        provides: [shutdownSvc],
        uses: { provide, lifecycle },
        apply({ provide, lifecycle }) {
          provide(shutdownSvc, {});
          lifecycle.onDispose(() => {
            log.push('p-svc.dispose');
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'c-svc',
        uses: { lifecycle, s: optional(shutdownSvc) },
        apply({ lifecycle }) {
          log.push('c-svc.apply');
          lifecycle.onDispose(() => {
            log.push('c-svc.dispose');
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('c-svc')?.state).toBe('active');

    await (app.plugins as PluginManager).stopAll();
    // optional 消费者不应在停机期间被反应式拆一次再被停机计划拆一次
    expect(log.filter(e => e === 'c-svc.dispose')).toHaveLength(1);
    expect(log.indexOf('c-svc.dispose')).toBeLessThan(log.indexOf('p-svc.dispose'));
  });
});

describe('激活归因与级联', () => {
  it('旁观插件的 plugin:loaded 监听器抛错，不把刚激活成功的插件打成 error', async () => {
    const { app, state } = makeApp();
    await app.plugin(
      definePlugin({
        name: 'observer',
        uses: { events },
        apply({ events }) {
          events.on('plugin:loaded', name => {
            if (name === 'victim') throw new Error('旁观者爆炸');
          });
        },
      }),
    );
    await app.plugin(makePlugin('victim', state));
    await app.plugins.idle();

    const victim = app.plugins.getPlugin('victim');
    expect(victim?.state).toBe('active');
    expect(victim?.error).toBeUndefined();
  });

  it('unload 提供者后，依赖它的下游级联转 pending', async () => {
    const { app, state } = makeApp();
    await app.plugin(
      definePlugin({
        name: 'provider',
        provides: [mysvc],
        uses: { provide, lifecycle },
        apply({ provide, lifecycle }) {
          provide(mysvc, { ok: true });
          state.applied.push('provider');
          lifecycle.onDispose(() => {
            state.disposed.push('provider');
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { lifecycle, mysvc },
        apply({ lifecycle }) {
          state.applied.push('consumer');
          lifecycle.onDispose(() => {
            state.disposed.push('consumer');
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');

    await app.plugins.unload('provider');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('pending');
    expect(state.disposed).toContain('consumer');
  });

  it('激活过程中并发注册不丢失（recompute 排队）', async () => {
    const { app, state } = makeApp();
    await Promise.all([app.plugin(makePlugin('p1', state)), app.plugin(makePlugin('p2', state))]);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p1')?.state).toBe('active');
    expect(app.plugins.getPlugin('p2')?.state).toBe('active');
  });
});

// 配置热重载编排（watch → diff → bounce）属宿主层，测试在 test/runtime/config-sync.test.ts。

describe('异步 dispose 编排（bounce/unload 等待落盘）', () => {
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  it('bounce：异步 onDispose flush 完成先于重激活', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    const timeline: string[] = [];
    let flushed = false;
    await app.plugin(
      definePlugin({
        name: 'flusher',
        uses: { lifecycle },
        apply({ lifecycle }) {
          timeline.push(`apply(flushed=${flushed})`);
          lifecycle.onDispose(async () => {
            await sleep(15);
            flushed = true;
            timeline.push('flush-done');
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('flusher')?.state).toBe('active');
    await app.plugins.bounce('flusher');
    await app.plugins.idle();
    expect(timeline).toEqual(['apply(flushed=false)', 'flush-done', 'apply(flushed=true)']);
  });

  it('unload：等待异步清理完成后才宣告卸载', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    let persisted = false;
    await app.plugin(
      definePlugin({
        name: 'persister',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.onDispose(async () => {
            await sleep(10);
            persisted = true;
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('persister')?.state).toBe('active');
    await app.plugins.unload('persister');
    expect(persisted).toBe(true);
  });

  it('stop：根激活的异步清理在 stop() 返回前完成', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    let rootCleaned = false;
    app.bind({ lifecycle }).lifecycle.onDispose(async () => {
      await sleep(10);
      rootCleaned = true;
    });
    await app.stop();
    expect(rootCleaned).toBe(true);
  });
});
