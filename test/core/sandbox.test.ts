import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, type Context, type PluginModule } from '../../packages/core/src/index.js';

/**
 * 沙盒插件加载测试
 *
 * 核心契约：
 * 1. ctx.useModule 把一个插件 module 挂载到子 ctx，dispose 即卸载，
 *    不污染全局 PluginManager
 * 2. 使用 createScope 时，服务注册仅作用于沙盒，父级不可见
 * 3. 父 ctx dispose 级联清理沙盒插件
 * 4. 两个并存沙盒互相隔离
 */

function makeApp() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  return { app, cleanup: () => {} };
}

describe('Context.useModule 沙盒插件加载', () => {
  let env: ReturnType<typeof makeApp>;
  beforeEach(() => {
    env = makeApp();
  });
  afterEach(() => env.cleanup());

  it('useModule 不进入 PluginManager；返回的 dispose 触发卸载', async () => {
    const events: string[] = [];
    const mini: PluginModule = {
      name: 'mini',
      apply(ctx) {
        events.push('apply');
        ctx.onDispose(() => events.push('disposed'));
      },
    };
    const off = await env.app.ctx.useModule(mini);
    expect(events).toEqual(['apply']);
    expect(env.app.plugins.getStatus().map(p => p.name)).not.toContain('mini');

    off();
    expect(events).toEqual(['apply', 'disposed']);
  });

  it('scoped: 沙盒内 provide 不暴露给父级，dispose 后清理', async () => {
    const sandbox: PluginModule = {
      name: 'sandbox-tool',
      apply(ctx) {
        ctx.provide('sandbox-svc', { v: 1 });
      },
    };
    const off = await env.app.ctx.useModule(sandbox, {}, { scoped: true });
    expect(env.app.ctx.getService('sandbox-svc')).toBeUndefined();
    off();
    expect(env.app.ctx.getService('sandbox-svc')).toBeUndefined();
  });

  it('父 ctx dispose 级联销毁 useModule 子上下文', async () => {
    const disposed: string[] = [];
    const root = env.app.ctx;
    const scope: Context | undefined = root.createScope('outer-scope');
    await scope.useModule({
      name: 'inner',
      apply(c) {
        c.onDispose(() => disposed.push(c.id));
      },
    });
    scope.dispose();
    expect(disposed.length).toBe(1);
    expect(disposed[0]).toContain('inner');
  });

  it('apply 抛错时立即 dispose 子 ctx 并冒泡错误', async () => {
    const disposed: string[] = [];
    const bad: PluginModule = {
      name: 'bad',
      apply(ctx) {
        ctx.onDispose(() => disposed.push('cleanup'));
        throw new Error('boom');
      },
    };
    await expect(env.app.ctx.useModule(bad)).rejects.toThrow(/boom/);
    expect(disposed).toEqual(['cleanup']);
  });

  it('两个沙盒并存互相隔离', async () => {
    const events: string[] = [];
    const off1 = await env.app.ctx.useModule(
      {
        name: 'a',
        apply(c) {
          c.provide('val', 'A');
          c.onDispose(() => events.push('a-disposed'));
        },
      },
      {},
      { scoped: true },
    );
    const off2 = await env.app.ctx.useModule(
      {
        name: 'b',
        apply(c) {
          c.provide('val', 'B');
          c.onDispose(() => events.push('b-disposed'));
        },
      },
      {},
      { scoped: true },
    );

    // 父级既无 A 也无 B
    expect(env.app.ctx.getService('val')).toBeUndefined();
    off1();
    expect(events).toEqual(['a-disposed']);
    off2();
    expect(events).toEqual(['a-disposed', 'b-disposed']);
  });

  it('已 dispose 的 ctx 上 useModule 抛错', async () => {
    const child = env.app.ctx.fork('to-dispose');
    child.dispose();
    await expect(child.useModule({ name: 'late', apply: () => {} })).rejects.toThrow(/dispose/);
  });
});

describe('createApp 完全隔离沙盒', () => {
  it('两个独立 App 各自的服务/事件互不影响', async () => {
    const app1 = new App({ config: { name: 'A', logLevel: 'error', plugins: {} } });
    const app2 = new App({ config: { name: 'B', logLevel: 'error', plugins: {} } });

    await app1.plugin({
      name: 'p',
      apply(ctx) {
        ctx.provide('only-in-1', { v: 1 });
      },
    });

    expect(app1.ctx.getService('only-in-1')).toBeDefined();
    expect(app2.ctx.getService('only-in-1')).toBeUndefined();
    expect(app1.ctx.config.get('name')).toBe('A');
    expect(app2.ctx.config.get('name')).toBe('B');
  });
});
