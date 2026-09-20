import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type LifecycleCap,
  lifecycle,
  provide,
  services,
} from '../../packages/core/src/index.js';

/**
 * 子模块挂载
 *
 * 核心契约：
 * 1. lifecycle.module 把一份定义挂到子激活，dispose 即卸载，不进 PluginManager
 * 2. 父激活关闭时级联清理子模块
 * 3. 两个独立 App 的服务与配置互不影响（隔离是 App 边界，不是已放弃的 Scope 容器）
 *
 * 子模块挂载时缺 required 即拒；挂载后没有独立持续激活闸——不要断言它与顶层调度完全相同。
 */

function makeApp() {
  return new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
}

describe('lifecycle.module 子模块挂载', () => {
  let app: App;
  beforeEach(() => {
    app = makeApp();
  });
  afterEach(async () => {
    await app.stop().catch(() => {});
  });

  it('lifecycle.module 不进入 PluginManager；返回的 dispose 触发卸载', async () => {
    const events: string[] = [];
    const mini = definePlugin({
      name: 'mini',
      uses: { lifecycle },
      apply({ lifecycle }) {
        events.push('apply');
        lifecycle.onDispose(() => {
          events.push('disposed');
        });
      },
    });
    const off = await app.bind({ lifecycle }).lifecycle.module(mini);
    expect(events).toEqual(['apply']);
    expect(app.plugins.getStatus().map(p => p.name)).not.toContain('mini');

    off.dispose();
    expect(events).toEqual(['apply', 'disposed']);
  });

  it('父激活关闭时级联销毁子模块', async () => {
    const disposed: string[] = [];
    const inner = definePlugin({
      name: 'inner',
      uses: { lifecycle },
      apply({ lifecycle }) {
        lifecycle.onDispose(() => {
          disposed.push(lifecycle.id);
        });
      },
    });
    await app.plugin(
      definePlugin({
        name: 'outer',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await lifecycle.module(inner);
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('outer')?.state).toBe('active');

    await app.plugins.unload('outer');
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toContain('inner');
  });

  it('apply 抛错时立即 dispose 子激活并冒泡错误', async () => {
    const disposed: string[] = [];
    const bad = definePlugin({
      name: 'bad',
      uses: { lifecycle },
      apply({ lifecycle }) {
        lifecycle.onDispose(() => {
          disposed.push('cleanup');
        });
        throw new Error('boom');
      },
    });
    await expect(app.bind({ lifecycle }).lifecycle.module(bad)).rejects.toThrow(/boom/);
    expect(disposed).toEqual(['cleanup']);
  });

  it('已关闭的激活上 lifecycle.module 抛错', async () => {
    let cap: LifecycleCap | undefined;
    await app.plugin(
      definePlugin({
        name: 'host',
        uses: { lifecycle },
        apply({ lifecycle }) {
          cap = lifecycle;
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('host')?.state).toBe('active');
    await app.plugins.unload('host');
    await expect(cap!.module(definePlugin({ name: 'late', apply() {} }))).rejects.toThrow(/dispose/);
  });
});

describe('独立 App 隔离', () => {
  it('两个独立 App 各自的服务/配置互不影响', async () => {
    const app1 = new App({ config: { name: 'A', logLevel: 'error', plugins: {} } });
    const app2 = new App({ config: { name: 'B', logLevel: 'error', plugins: {} } });
    const only = defineService<{ v: number }>('only-in-1');

    app1.bind({ provide }).provide(only, { v: 1 });

    expect(app1.bind({ services }).services.get(only)).toBeDefined();
    expect(app2.bind({ services }).services.get(only)).toBeUndefined();
    expect(app1.config.get('name')).toBe('A');
    expect(app2.config.get('name')).toBe('B');

    await app1.stop();
    await app2.stop();
  });
});
