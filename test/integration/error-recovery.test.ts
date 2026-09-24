import { describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, lifecycle, provide } from '../../packages/core/src/index.js';

/**
 * 异常恢复测试：插件出错不应炸掉宿主或泄漏资源
 */

/** 观测用的服务：只看它在容器里出现 / 不出现，实现本身无行为 */
const marker = defineService<{ ok: boolean }>('marker');
const halfLeak = defineService<{ x: number }>('half-leak');
const p1svc = defineService<Record<string, never>>('p1svc');
const p2svc = defineService<Record<string, never>>('p2svc');

function tempApp() {
  const app = new App({ name: 'ER', logLevel: 'error' });
  return {
    app,
    cleanup: async () => {
      try {
        await app.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

describe('插件错误恢复', () => {
  it('apply 抛错的插件不会污染 app', async () => {
    const { app, cleanup } = tempApp();
    const host = app.bind({ lifecycle, marker });
    try {
      const bad = definePlugin({
        name: '@test/bad-apply',
        apply() {
          throw new Error('boom on apply');
        },
      });
      // register 不抛错（错误被 PluginManager 捕获），而是把 entry 标记为 'error'
      await app.plugins.register(bad);
      const status = app.plugins.getStatus().find(s => s.instanceId === '@test/bad-apply');
      expect(status?.state).toBe('error');
      expect(status?.error).toMatch(/boom on apply/);
      // app 仍然可用
      expect(host.lifecycle.closed).toBe(false);
      // 后续注册其他插件正常
      const ok = definePlugin({
        name: '@test/ok',
        uses: { provide },
        apply(caps) {
          caps.provide(marker, { ok: true });
        },
      });
      await app.plugins.register(ok);
      await app.plugins.idle(); // register 在 flight 在飞时排队早退，静置后再断言
      expect(app.plugins.getPlugin('@test/ok')?.state).toBe('active');
      expect(host.marker.current).toEqual({ ok: true });
    } finally {
      await cleanup();
    }
  });

  it('onDispose 抛错不阻止其他清理', async () => {
    const { app, cleanup } = tempApp();
    try {
      const order: string[] = [];
      const p1 = definePlugin({
        name: '@test/p1',
        uses: { lifecycle, provide },
        apply(caps) {
          caps.lifecycle.onDispose(() => {
            order.push('p1');
            throw new Error('p1 dispose fail');
          });
          caps.provide(p1svc, {});
        },
      });
      const p2 = definePlugin({
        name: '@test/p2',
        uses: { lifecycle, provide },
        apply(caps) {
          caps.lifecycle.onDispose(() => {
            order.push('p2');
          });
          caps.provide(p2svc, {});
        },
      });
      await app.plugins.register(p1);
      await app.plugins.register(p2);
      await app.plugins.idle();
      expect(app.plugins.getPlugin('@test/p1')?.state).toBe('active');
      expect(app.plugins.getPlugin('@test/p2')?.state).toBe('active');
      // 停掉 app；即使 p1 dispose 抛错，p2 应仍被调用
      await app.stop();
      expect(order).toContain('p1');
      expect(order).toContain('p2');
    } finally {
      await cleanup();
    }
  });

  it('apply 抛错的插件不留下 service', async () => {
    const { app, cleanup } = tempApp();
    const host = app.bind({ halfLeak });
    try {
      const bad = definePlugin({
        name: '@test/half',
        uses: { provide },
        apply(caps) {
          caps.provide(halfLeak, { x: 1 });
          throw new Error('mid-apply boom');
        },
      });
      await app.plugins.register(bad);
      // 插件激活应被拆掉，注入的 service 不应残留
      expect(host.halfLeak.current).toBeUndefined();
      const status = app.plugins.getStatus().find(s => s.instanceId === '@test/half');
      expect(status?.state).toBe('error');
    } finally {
      await cleanup();
    }
  });
});
