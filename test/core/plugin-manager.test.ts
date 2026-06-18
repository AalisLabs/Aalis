import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, type PluginModule } from '../../packages/core/src/index.js';

interface ScratchState {
  applied: string[];
  disposed: string[];
}

function makeApp(): { app: App; state: ScratchState; cleanup: () => void } {
  const app = new App({ config: { name: 'TestApp', logLevel: 'error', plugins: {} } });
  const state: ScratchState = { applied: [], disposed: [] };
  return {
    app,
    state,
    cleanup: () => {},
  };
}

function makePlugin(name: string, state: ScratchState, overrides: Partial<PluginModule> = {}): PluginModule {
  return {
    name,
    apply(ctx) {
      state.applied.push(name);
      ctx.onDispose(() => state.disposed.push(name));
    },
    ...overrides,
  };
}

describe('App plugin lifecycle', () => {
  let env: ReturnType<typeof makeApp>;
  beforeEach(() => {
    env = makeApp();
  });
  afterEach(() => env.cleanup());

  it('register → activate → unload 走完生命周期', async () => {
    const mod = makePlugin('p1', env.state);
    await env.app.plugin(mod);
    expect(env.state.applied).toEqual(['p1']);
    expect(env.app.plugins.getStatus()[0].state).toBe('active');

    await env.app.plugins.unload('p1');
    expect(env.state.disposed).toEqual(['p1']);
  });

  it('依赖不满足时变为 pending；提供者激活后自动 active', async () => {
    const dependent: PluginModule = {
      name: 'consumer',
      inject: { required: ['mysvc'] },
      apply(ctx) {
        env.state.applied.push('consumer');
        ctx.onDispose(() => env.state.disposed.push('consumer'));
      },
    };
    const provider: PluginModule = {
      name: 'provider',
      provides: ['mysvc'],
      apply(ctx) {
        ctx.provide('mysvc', { ok: true });
        env.state.applied.push('provider');
      },
    };

    await env.app.plugin(dependent);
    expect(env.app.plugins.getPlugin('consumer')?.state).toBe('pending');
    expect(env.state.applied).not.toContain('consumer');

    await env.app.plugin(provider);
    // service:registered 触发自动激活
    await new Promise(r => setTimeout(r, 10));
    expect(env.app.plugins.getPlugin('consumer')?.state).toBe('active');
    expect(env.state.applied).toContain('consumer');
  });

  it('禁用 active 插件 → dispose 副作用 + state 转为 disabled', async () => {
    await env.app.plugin(makePlugin('p', env.state));
    await env.app.plugins.disablePlugin('p');
    expect(env.app.plugins.getPlugin('p')?.state).toBe('disabled');
    expect(env.state.disposed).toContain('p');

    await env.app.plugins.enablePlugin('p');
    expect(env.app.plugins.getPlugin('p')?.state).toBe('active');
  });

  it('core 插件不能被禁用', async () => {
    await env.app.plugin(makePlugin('core-plug', env.state, { core: true }));
    const ok = await env.app.plugins.disablePlugin('core-plug');
    expect(ok).toBe(false);
    expect(env.app.plugins.getPlugin('core-plug')?.state).toBe('active');
  });

  it('apply 抛错 → state=error，错误信息记录到 entry.error', async () => {
    const boom: PluginModule = {
      name: 'boom',
      apply: () => {
        throw new Error('boom-detail');
      },
    };
    await env.app.plugin(boom);
    const entry = env.app.plugins.getPlugin('boom');
    expect(entry?.state).toBe('error');
    expect(entry?.error).toContain('boom-detail');
  });

  it('reusable 插件支持多实例注册，不同 instanceId 独立 dispose', async () => {
    const reusable: PluginModule = {
      name: 'multi',
      reusable: true,
      apply(ctx) {
        env.state.applied.push(ctx.id);
        ctx.onDispose(() => env.state.disposed.push(ctx.id));
      },
    };
    await env.app.plugin(reusable);
    await env.app.plugins.createInstance('multi', 'one', {});
    await env.app.plugins.createInstance('multi', 'two', {});
    expect(env.state.applied).toContain('multi');
    expect(env.state.applied).toContain('multi:one');
    expect(env.state.applied).toContain('multi:two');

    await env.app.plugins.removeInstance('multi:one');
    expect(env.state.disposed).toContain('multi:one');
    expect(env.app.plugins.getPlugin('multi:one')).toBeUndefined();
    expect(env.app.plugins.getPlugin('multi')).toBeDefined();
  });

  it('非 reusable 插件不允许多实例', async () => {
    await env.app.plugin(makePlugin('solo', env.state));
    const id = await env.app.plugins.createInstance('solo', 'extra');
    expect(id).toBeUndefined();
  });

  it('provides 声明与实际注册不符 → state=error', async () => {
    const liar: PluginModule = {
      name: 'liar',
      provides: ['nonexistent-svc'],
      apply() {
        // 没注册 nonexistent-svc
      },
    };
    await env.app.plugin(liar);
    expect(env.app.plugins.getPlugin('liar')?.state).toBe('error');
  });

  it('optional 依赖默认不级联 bounce —— 下游应通过惰性 getService 跟随 provider 切换', async () => {
    // 新契约：core 默认不再因 provider 重启级联 dispose 下游。下游若想拿到
    // 新 provider 实例，应在每次访问时 `ctx.getService(...)` 惰性查询。
    const events: string[] = [];

    const provider: PluginModule = {
      name: 'svc-provider',
      provides: ['mysvc'],
      apply(ctx, cfg) {
        ctx.provide('mysvc', { tag: cfg.tag ?? 'v1' });
        events.push(`provider:apply:${cfg.tag ?? 'v1'}`);
      },
    };
    let consumerCtx: { getService<T>(n: string): T | undefined } | undefined;
    const consumer: PluginModule = {
      name: 'svc-consumer',
      inject: { optional: ['mysvc'] },
      apply(ctx) {
        consumerCtx = ctx;
        events.push('consumer:apply');
        ctx.onDispose(() => events.push('consumer:dispose'));
      },
    };

    await env.app.plugin(provider, { tag: 'v1' });
    await env.app.plugin(consumer);
    await new Promise(r => setTimeout(r, 10));
    expect(consumerCtx?.getService<{ tag: string }>('mysvc')?.tag).toBe('v1');

    await env.app.plugins.updatePluginConfig('svc-provider', { tag: 'v2' });
    await new Promise(r => setTimeout(r, 30));

    // 默认不级联：consumer 不应被 dispose
    expect(events).not.toContain('consumer:dispose');
    // consumer ctx 还活着，再次 getService 应返回新 provider 实例
    expect(consumerCtx?.getService<{ tag: string }>('mysvc')?.tag).toBe('v2');
  });

  it('requiresBounceOnDepChange: true → provider 重启时下游被级联 bounce', async () => {
    // 逃生舱：插件显式声明无法响应式跟随 provider 时，core 仍会级联 bounce。
    const events: string[] = [];

    const provider: PluginModule = {
      name: 'svc-provider',
      provides: ['mysvc'],
      apply(ctx, cfg) {
        ctx.provide('mysvc', { tag: cfg.tag ?? 'v1' });
        events.push(`provider:apply:${cfg.tag ?? 'v1'}`);
      },
    };
    const consumer: PluginModule = {
      name: 'svc-consumer',
      inject: { optional: ['mysvc'] },
      requiresBounceOnDepChange: true,
      apply(ctx) {
        const svc = ctx.getService<{ tag: string }>('mysvc');
        events.push(`consumer:apply:${svc?.tag ?? 'none'}`);
        ctx.onDispose(() => events.push('consumer:dispose'));
      },
    };

    await env.app.plugin(provider, { tag: 'v1' });
    await env.app.plugin(consumer);
    await new Promise(r => setTimeout(r, 10));
    expect(events).toContain('consumer:apply:v1');

    await env.app.plugins.updatePluginConfig('svc-provider', { tag: 'v2' });
    await new Promise(r => setTimeout(r, 30));

    expect(events).toContain('consumer:dispose');
    expect(events).toContain('consumer:apply:v2');
  });

  it('updatePluginConfig 在 active 时触发重激活', async () => {
    const log: Array<Record<string, unknown>> = [];
    const mod: PluginModule = {
      name: 'rcfg',
      apply(ctx, cfg) {
        log.push({ ...cfg });
        ctx.onDispose(() => log.push({ disposed: true }));
      },
    };
    await env.app.plugin(mod, { v: 1 });
    expect(log).toEqual([{ v: 1 }]);

    await env.app.plugins.updatePluginConfig('rcfg', { v: 2 });
    // softReload 异步
    await new Promise(r => setTimeout(r, 30));
    expect(log).toContainEqual({ disposed: true });
    expect(log).toContainEqual({ v: 2 });
  });

  it('stopAll: 按拓扑逆序 dispose（消费者先关、提供者后关）', async () => {
    const order: string[] = [];
    const provider: PluginModule = {
      name: 'svc-A',
      provides: ['serviceA'],
      apply(ctx) {
        ctx.provide('serviceA', { ping: () => 'pong' });
        ctx.onDispose(() => order.push('svc-A.dispose'));
      },
    };
    const consumer: PluginModule = {
      name: 'cons-B',
      inject: { required: ['serviceA'] },
      apply(ctx) {
        ctx.onDispose(() => order.push('cons-B.dispose'));
      },
    };

    await env.app.plugin(provider);
    await env.app.plugin(consumer);
    await new Promise(r => setTimeout(r, 10));
    expect(env.app.plugins.getPlugin('cons-B')?.state).toBe('active');

    await env.app.plugins.stopAll();
    // 消费者必须先于提供者 dispose
    expect(order).toEqual(['cons-B.dispose', 'svc-A.dispose']);
    expect(env.app.plugins.isShuttingDown()).toBe(true);
  });

  it('stopAll: 关机标志屏蔽 service:unregistered 反应式 bounce', async () => {
    const events: string[] = [];
    const provider: PluginModule = {
      name: 'p-svc',
      provides: ['s'],
      apply(ctx) {
        ctx.provide('s', {});
        ctx.onDispose(() => events.push('p-svc.dispose'));
      },
    };
    const consumer: PluginModule = {
      name: 'c-svc',
      inject: { optional: ['s'] },
      apply(ctx) {
        events.push('c-svc.apply');
        ctx.onDispose(() => events.push('c-svc.dispose'));
      },
    };
    await env.app.plugin(provider);
    await env.app.plugin(consumer);
    await new Promise(r => setTimeout(r, 10));

    await env.app.plugins.stopAll();
    // c-svc 不应该在 stopAll 期间被反应式 bounce 一次再 dispose 一次
    // —— 应当是 stopAll 主动 dispose 一次（消费者先）
    const cDisposeCount = events.filter(e => e === 'c-svc.dispose').length;
    expect(cDisposeCount).toBe(1);
    // 应用顺序：consumer 先 dispose、provider 后 dispose
    const cIdx = events.indexOf('c-svc.dispose');
    const pIdx = events.indexOf('p-svc.dispose');
    expect(cIdx).toBeLessThan(pIdx);
  });
});

describe('激活归因与级联（#8.1 / #8.6 回归）', () => {
  let env: ReturnType<typeof makeApp>;
  beforeEach(() => {
    env = makeApp();
  });
  afterEach(() => env.cleanup());

  it('旁观插件的 plugin:loaded 监听器抛错，不把刚激活成功的插件打成 error', async () => {
    const observer: PluginModule = {
      name: 'observer',
      apply(ctx) {
        ctx.on('plugin:loaded', name => {
          if (name === 'victim') throw new Error('旁观者爆炸');
        });
      },
    };
    await env.app.plugin(observer);
    await env.app.plugin(makePlugin('victim', env.state));

    const victim = env.app.plugins.getStatus().find(p => p.name === 'victim');
    expect(victim?.state).toBe('active');
    expect(victim?.error).toBeUndefined();
  });

  it('unload 提供者后，依赖它的下游级联转 pending（不再依赖反应式巧合）', async () => {
    const provider: PluginModule = {
      name: 'provider',
      provides: ['mysvc'],
      apply(ctx) {
        ctx.provide('mysvc', { ok: true });
        env.state.applied.push('provider');
        ctx.onDispose(() => env.state.disposed.push('provider'));
      },
    };
    const consumer: PluginModule = {
      name: 'consumer',
      inject: { required: ['mysvc'] },
      apply(ctx) {
        env.state.applied.push('consumer');
        ctx.onDispose(() => env.state.disposed.push('consumer'));
      },
    };
    await env.app.plugin(provider);
    await env.app.plugin(consumer);
    expect(env.app.plugins.getStatus().find(p => p.name === 'consumer')?.state).toBe('active');

    await env.app.plugins.unload('provider');
    // 等排队的 recompute 与事件微任务清算
    await new Promise(r => setTimeout(r, 0));
    expect(env.app.plugins.getStatus().find(p => p.name === 'consumer')?.state).toBe('pending');
    expect(env.state.disposed).toContain('consumer');
  });

  it('激活过程中并发注册不丢失（recompute 排队，#8.6 lost wakeup 回归）', async () => {
    // 两个 register 并发触发：第二个 recompute 落在第一个的在飞窗口内，
    // 旧实现直接丢弃会让 p2 卡 pending；新实现排队补跑。
    const p1 = makePlugin('p1', env.state);
    const p2 = makePlugin('p2', env.state);
    await Promise.all([env.app.plugin(p1), env.app.plugin(p2)]);
    await new Promise(r => setTimeout(r, 0));
    const states = env.app.plugins.getStatus().map(p => [p.name, p.state]);
    expect(states).toContainEqual(['p1', 'active']);
    expect(states).toContainEqual(['p2', 'active']);
  });
});

describe('配置热重载与启动路径同政策（评审修复回归）', () => {
  it('watch 推送的快照在热重载时按 trimUnknownFields 裁剪 schema 外字段', async () => {
    let pushSnapshot: ((next: Record<string, unknown>) => void) | undefined;
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { p1: { known: 1 } } },
      configProvider: {
        save: () => {},
        watch: cb => {
          pushSnapshot = cb as (next: Record<string, unknown>) => void;
          return () => {};
        },
      },
    });
    const mod: PluginModule = {
      name: 'p1',
      defaultConfig: { known: 0 },
      configSchema: { known: { type: 'number', label: 'K' } },
      apply() {},
    };
    await app.plugin(mod);
    await app.start();

    // 模拟外部把 schema 外字段写进配置文件
    pushSnapshot?.({ name: 'T', logLevel: 'error', plugins: { p1: { known: 2, sneaky: true } } });
    // 热重载是异步链（watch 回调 → handleConfigFileChanged → bounce）
    await new Promise(r => setTimeout(r, 20));

    // 政策默认裁剪：sneaky 不应留在内存态
    expect(app.ctx.config.getPluginConfig('p1')).toEqual({ known: 2 });
    await app.stop();
  });
});
