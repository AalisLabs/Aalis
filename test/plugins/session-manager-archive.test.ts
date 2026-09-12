import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { SessionManagerService } from '../../packages/api-session-manager/src/index.js';
import * as sessionManagerModule from '../../packages/plugin-session-manager/src/index.js';

// 背景：archiveSession action 用 `this.archiveSession(...)` 递归，而 webui-server 是把函数从
// actions 对象里取出来单独调用的（this === undefined）——有子会话时必抛 TypeError，父会话也没归档。
// 契约：递归归档不依赖 this，action 脱离对象调用照样把整棵子树连父一起归档。

function fakeMemory() {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    listMetadata: async () => [...meta].map(([key, data]) => ({ key, data })),
    commitMetadata: async (ops: Array<{ op: string; key: string; data?: Record<string, unknown> }>) => {
      for (const o of ops) {
        if (o.op === 'put' && o.data) meta.set(o.key, o.data);
        else if (o.op === 'del') meta.delete(o.key);
      }
    },
    getHistory: async () => [],
    clearSession: async () => {},
  };
}

async function setup() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  app.ctx.provide('memory', fakeMemory() as never);
  await app.ctx.useModule(sessionManagerModule, {});
  await app.plugins.idle();
  const sm = app.ctx.getService<SessionManagerService>('session-manager');
  if (!sm) throw new Error('session-manager 服务未注册');
  return { app, sm };
}

describe('archiveSession action：脱离 actions 对象调用也能递归归档', () => {
  it('取出函数单独调用（this === undefined）时，父 + 子 + 孙全部归档', async () => {
    const { app, sm } = await setup();
    await sm.ensureSession('parent', { name: '父会话' });
    const child = await sm.createChildSession('parent', { name: '子任务' });
    const grandchild = await sm.createChildSession(child.id, { name: '孙任务' });

    // 与 webui-server 的取法一致：只拿函数，不带 receiver
    const archiveSession = sessionManagerModule.actions?.archiveSession;
    expect(archiveSession, 'archiveSession action 应存在').toBeTypeOf('function');
    const detached = archiveSession as (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;

    await expect(detached(app.ctx, { id: 'parent' })).resolves.toEqual({ success: true });

    expect(sm.getSession('parent')?.status, '父会话应被归档').toBe('archived');
    expect(sm.getSession(child.id)?.status, '子会话应被归档').toBe('archived');
    expect(sm.getSession(grandchild.id)?.status, '孙会话应被归档').toBe('archived');
    await app.stop();
  });
});
