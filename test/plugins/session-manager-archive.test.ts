import { App, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// 背景：archiveSession 曾用 `this.archiveSession(...)` 递归，而 webui-server 是把处理函数
// 取出来单独调用的（没有 receiver）——有子会话时必抛 TypeError，父会话也没归档。
// 契约：递归归档不依赖 this，处理函数脱离登记它的对象调用，照样把整棵子树连父一起归档。

async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  // 桩 webui-server：页面动作登记到这里，测试按 method 取处理函数
  const actions = new Map<string, WebuiActionHandler>();
  const host = app.bind({ provide, sessionManager });
  // memory 是会话管理的 required 依赖：不先摆上，插件会停在 pending
  host.provide(memory, fakeMemory() as never);
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction(method: string, handler: WebuiActionHandler) {
      actions.set(method, handler);
      return () => void actions.delete(method);
    },
  } as never);
  await app.plugin(sessionManagerPlugin, {});
  await app.plugins.idle();
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`会话管理未激活（state=${state}）`);
  const sm = host.sessionManager.require();
  return { app, sm, actions };
}

describe('archiveSession 页面动作：脱离登记它的对象调用也能递归归档', () => {
  it('取出处理函数单独调用时，父 + 子 + 孙全部归档', async () => {
    const { app, sm, actions } = await setup();
    await sm.ensureSession('parent', { name: '父会话' });
    const child = await sm.createChildSession('parent', { name: '子任务' });
    const grandchild = await sm.createChildSession(child.id, { name: '孙任务' });

    // 与 webui-server 的取法一致：只拿函数，不带 receiver
    const archiveSession = actions.get('archiveSession');
    expect(archiveSession, 'archiveSession 页面动作应已登记').toBeTypeOf('function');
    const detached = archiveSession as WebuiActionHandler;

    await expect(detached({ id: 'parent' })).resolves.toEqual({ success: true });

    expect(sm.getSession('parent')?.status, '父会话应被归档').toBe('archived');
    expect(sm.getSession(child.id)?.status, '子会话应被归档').toBe('archived');
    expect(sm.getSession(grandchild.id)?.status, '孙会话应被归档').toBe('archived');
    await app.stop();
  });
});
