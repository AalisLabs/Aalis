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

  it('optional 依赖的服务实例被替换时 → 下游插件 bounce 重新 apply', async () => {
    // 回归 Bug A：plugin-commands 改 commandPrefix 重载后，doctor / agent-default
    // 等以 optional 方式依赖 commands 的插件之前不会被 bounce，导致命令丢失。
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

    // 触发 provider 重载（service 被 dispose 后重新 provide）
    await env.app.plugins.updatePluginConfig('svc-provider', { tag: 'v2' });
    await new Promise(r => setTimeout(r, 30));

    // consumer 必须被 bounce 并以新 service 实例重新 apply
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
});
