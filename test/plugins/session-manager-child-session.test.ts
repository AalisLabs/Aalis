import { App, events, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { settingsPlugin, THINK } from '../fixtures/session-settings.js';

// 背景：平台派生会话（cli-default、OneBot 的 `onebot:bot:group:x`）从不经 createSession 预建，
// createChildSession 原本对未建档的父直接抛「父会话不存在」，create_subtask 在这些平台必败。
// 契约：父档缺失时先 ensureSession 兜底建档，再挂子会话。

async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, events, sessionManager });
  host.provide(memory, fakeMemory() as never);
  await app.plugin(sessionManagerPlugin);
  await app.plugin(settingsPlugin('test-settings', [THINK]));
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错——核激活状态，别让「压根没跑起来」冒充绿
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  return { app, host, sm: host.sessionManager.require() };
}

describe('createChildSession：父会话未建档时兜底建档', () => {
  it('平台派生父 id 未建档也能建子会话，并把父挂进树', async () => {
    const { app, sm } = await setup();
    const parentId = 'cli-default';

    const child = await sm.createChildSession(parentId, { name: '子任务 A', inputContext: '去查个东西' });

    expect(child.parentId).toBe(parentId);
    expect(child.createdBy).toBe('agent');
    // 父档被兜底建出来，且 children 已挂上（否则 getChildren 看不到）
    const parent = sm.getSession(parentId);
    expect(parent, '父会话应被兜底建档').toBeDefined();
    expect(parent?.children).toContain(child.id);
    expect(sm.getChildren(parentId).map(s => s.id)).toEqual([child.id]);
    await app.stop();
  });

  it('父会话已建档时不改动其既有字段（兜底不越权覆盖）', async () => {
    const { app, sm } = await setup();
    const parentId = 'onebot:bot:group:g1';
    await sm.ensureSession(parentId, { name: '群聊', config: { think: 'off' }, createdBy: 'user' });

    const child = await sm.createChildSession(parentId, { name: '子任务 B', config: { think: 'high' } });

    const parent = sm.getSession(parentId);
    expect(parent?.name).toBe('群聊');
    expect(parent?.config).toEqual({ think: 'off' });
    expect(parent?.createdBy).toBe('user');
    expect(parent?.children).toContain(child.id);
    await app.stop();
  });
});

describe('子会话增删：父会话的子会话列表变了，发 session:updated', () => {
  it('建子会话先发子会话的 session:created，再发父会话的 session:updated；删子会话先发 session:deleted，再发父会话的 session:updated', async () => {
    const { app, host, sm } = await setup();
    const parent = await sm.createSession({ name: '父' });
    const seen: Array<[string, string, number]> = [];
    host.events.on('session:created', s => void seen.push(['created', s.id, s.children.length]));
    host.events.on('session:updated', s => void seen.push(['updated', s.id, s.children.length]));
    host.events.on('session:deleted', id => void seen.push(['deleted', id, 0]));

    const child = await sm.createChildSession(parent.id, { name: '子' });
    expect(seen).toEqual([
      ['created', child.id, 0],
      ['updated', parent.id, 1],
    ]);

    seen.length = 0;
    await sm.deleteSession(child.id);
    expect(seen).toEqual([
      ['deleted', child.id, 0],
      ['updated', parent.id, 0],
    ]);
    await app.stop();
  });
});
