import { App, events, provide } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionKind, sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// 会话种类：入表时按父会话与出生平台推出并覆盖写入，调用方传的值与存储里的旧值都不采信。
// 种类由纯函数 sessionKind 给出：子会话为 task，有出生平台为 room（含 owner 自己的私聊），其余为 owner。

const GROUP = 'onebot:10000:group:20001';
const ORIGIN = { originPlatform: 'onebot', originChat: { type: 'group', multiParty: true, targetId: '20001' } };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(initial: Record<string, Record<string, unknown>> = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, sessionManager });
  host.provide.use(memory, fakeMemory(initial) as never);
  await app.plugin(sessionManagerPlugin);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  return { sm: host.sessionManager.use, host };
}

describe('sessionKind', () => {
  it.each([
    ['子会话，父会话是群', 'task', { parentId: GROUP }],
    ['子会话，父会话是 owner 的会话', 'task', { parentId: 'session-abcd1234' }],
    ['有出生平台（群、私聊，含 owner 自己的私聊）', 'room', { originPlatform: 'onebot' }],
    ['没有出生平台的根会话', 'owner', {}],
  ] as const)('%s → %s', (_name, kind, session) => {
    expect(sessionKind(session)).toBe(kind);
  });
});

describe('会话种类字段', () => {
  it('WebUI 根会话与 cli-default 为 owner，子会话为 task；按原生入站建档的房间为 room，按 id 建档的不是', async () => {
    const { sm, host } = await setup();
    const root = await sm.createSession({ name: '新会话' });
    const child = await sm.createChildSession(root.id, { name: '子会话' });
    const cli = await sm.ensureSession('cli-default');
    const byId = await sm.ensureSession('onebot:10000:group:20009');
    await host.events.use.emit('inbound:message', {
      content: '<占位>',
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      groupId: '20001',
    });

    expect([root.kind, child.kind, cli.kind, byId.kind]).toEqual(['owner', 'task', 'owner', 'owner']);
    expect(sm.getSession(GROUP)?.kind).toBe('room');
    expect((await sm.createChildSession(GROUP, { name: '子任务' })).kind).toBe('task');
  });

  it('加载时不采信存储值：按父会话与出生平台重算', async () => {
    const stale = { name: '群', status: 'completed', children: [], config: {}, createdAt: 1, updatedAt: 1 };
    const { sm } = await setup({
      [GROUP]: { ...stale, ...ORIGIN, id: GROUP, kind: 'owner' },
      [`${GROUP}::abcd1234`]: { ...stale, id: `${GROUP}::abcd1234`, parentId: GROUP, kind: 'room' },
      'session-abcd1234': { ...stale, id: 'session-abcd1234', kind: 'room' },
    });

    expect(sm.getSession(GROUP)?.kind).toBe('room');
    expect(sm.getSession(`${GROUP}::abcd1234`)?.kind).toBe('task');
    expect(sm.getSession('session-abcd1234')?.kind).toBe('owner');
  });

  it('调用方传的种类被忽略', async () => {
    const { sm } = await setup();
    const root = await sm.createSession({ name: '新会话', kind: 'task' } as never);
    const child = await sm.createChildSession(root.id, { name: '子任务', kind: 'room' } as never);

    expect(root.kind).toBe('owner');
    expect(child.kind).toBe('task');
  });
});
