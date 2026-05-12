import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';

/**
 * 异常恢复测试：插件出错不应炸掉宿主或泄漏资源
 */

function tempApp() {
  const app = new App({ config: { name: 'ER', logLevel: 'error', plugins: {} } });
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
    try {
      const bad = {
        name: '@test/bad-apply',
        apply() {
          throw new Error('boom on apply');
        },
      };
      // register 不抛错（错误被 PluginManager 捕获），而是把 entry 标记为 'error'
      await app.plugins.register(bad);
      const status = app.plugins.getStatus().find(s => s.instanceId === '@test/bad-apply');
      expect(status?.state).toBe('error');
      expect(status?.error).toMatch(/boom on apply/);
      // app 仍然可用
      expect(app.ctx.disposed).toBe(false);
      // 后续注册其他插件正常
      const ok = {
        name: '@test/ok',
        apply(ctx: { provide: (n: string, v: unknown) => void }) {
          ctx.provide('marker', { ok: true });
        },
      };
      await app.plugins.register(ok);
      expect(app.ctx.getService('marker')).toEqual({ ok: true });
    } finally {
      await cleanup();
    }
  });

  it('onDispose 抛错不阻止其他清理', async () => {
    const { app, cleanup } = tempApp();
    try {
      const order: string[] = [];
      const p1 = {
        name: '@test/p1',
        apply(ctx: { onDispose: (fn: () => void) => void; provide: (n: string, v: unknown) => void }) {
          ctx.onDispose(() => {
            order.push('p1');
            throw new Error('p1 dispose fail');
          });
          ctx.provide('p1svc', {});
        },
      };
      const p2 = {
        name: '@test/p2',
        apply(ctx: { onDispose: (fn: () => void) => void; provide: (n: string, v: unknown) => void }) {
          ctx.onDispose(() => {
            order.push('p2');
          });
          ctx.provide('p2svc', {});
        },
      };
      await app.plugins.register(p1);
      await app.plugins.register(p2);
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
    try {
      const bad = {
        name: '@test/half',
        apply(ctx: { provide: (n: string, v: unknown) => void }) {
          ctx.provide('half-leak', { x: 1 });
          throw new Error('mid-apply boom');
        },
      };
      await app.plugins.register(bad);
      // 插件 ctx 应被 dispose，注入的 service 不应残留
      expect(app.ctx.getService('half-leak')).toBeUndefined();
      const status = app.plugins.getStatus().find(s => s.instanceId === '@test/half');
      expect(status?.state).toBe('error');
    } finally {
      await cleanup();
    }
  });
});
