import { App, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';

// 背景：平台派生会话（cli-default、OneBot 的 `onebot:bot:group:x`）从不经 createSession 预建，
// createChildSession 原本对未建档的父直接抛「父会话不存在」，create_subtask 在这些平台必败。
// 契约：父档缺失时先 ensureSession 兜底建档，再挂子会话。

/** 只实现 SessionManager 用到的四个方法的假 memory。 */
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
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide, sessionManager });
  host.provide(memory, fakeMemory() as never);
  await app.plugin(sessionManagerPlugin, {});
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错——核激活状态，别让「压根没跑起来」冒充绿
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  return { app, sm: host.sessionManager.require() };
}

describe('createChildSession：父会话未建档时兜底建档', () => {
  it('平台派生父 id 未建档也能建子会话，并把父挂进树', async () => {
    const { app, sm } = await setup();
    const parentId = 'cli-default';

    const child = await sm.createChildSession(parentId, { name: '子任务 A', inputContext: '去查个东西' });

    expect(child.parentId).toBe(parentId);
    expect(child.createdBy).toBe('agent');
    // 父档被兜底建出来，且 children 已挂上（否则 getTree/getChildren 看不到）
    const parent = sm.getSession(parentId);
    expect(parent, '父会话应被兜底建档').toBeDefined();
    expect(parent?.children).toContain(child.id);
    expect(sm.getChildren(parentId).map(s => s.id)).toEqual([child.id]);
    await app.stop();
  });

  it('父会话已建档时不改动其既有字段（兜底不越权覆盖）', async () => {
    const { app, sm } = await setup();
    const parentId = 'onebot:bot:group:g1';
    await sm.ensureSession(parentId, { name: '群聊', config: { think: false }, createdBy: 'user' });

    const child = await sm.createChildSession(parentId, { name: '子任务 B', config: { think: true } });

    const parent = sm.getSession(parentId);
    expect(parent?.name).toBe('群聊');
    expect(parent?.config).toEqual({ think: false });
    expect(parent?.createdBy).toBe('user');
    expect(parent?.children).toContain(child.id);
    await app.stop();
  });
});
