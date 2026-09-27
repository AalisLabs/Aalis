import { App, provide } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// 会话种类、受众与出生平台：入表时按 id 与 parentId 推出并覆盖写入，调用方传的值与存储里的旧值都不采信。

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(initial: Record<string, Record<string, unknown>> = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, sessionManager });
  host.provide(memory, fakeMemory(initial) as never);
  await app.plugin(sessionManagerPlugin, {});
  await app.plugins.idle();
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  return host.sessionManager.require();
}

const describeOf = (s: { kind?: unknown; audience?: unknown; originPlatform?: unknown } | undefined) => ({
  kind: s?.kind,
  audience: s?.audience,
  originPlatform: s?.originPlatform,
});

describe('会话种类字段', () => {
  it('owner 面会话：WebUI 根会话与 cli-default 为 room、owner、无出生平台，WebUI 会话的子会话为 task、无受众', async () => {
    const sm = await setup();
    const root = await sm.createSession({ name: '新会话' });
    const child = await sm.createChildSession(root.id, { name: '子会话' });
    const cli = await sm.ensureSession('cli-default');

    expect(describeOf(root)).toEqual({ kind: 'room', audience: 'owner', originPlatform: undefined });
    expect(describeOf(child)).toEqual({ kind: 'task', audience: undefined, originPlatform: undefined });
    expect(describeOf(cli)).toEqual({ kind: 'room', audience: 'owner', originPlatform: undefined });
  });

  it('IM 房间：群为 group、私聊为 private，出生平台取 id 前缀；房间下的子会话为 task、带出生平台', async () => {
    const sm = await setup();
    const group = await sm.ensureSession(GROUP);
    const priv = await sm.ensureSession(PRIVATE);
    const task = await sm.createChildSession(GROUP, { name: '子任务' });

    expect(describeOf(group)).toEqual({ kind: 'room', audience: 'group', originPlatform: 'onebot' });
    expect(describeOf(priv)).toEqual({ kind: 'room', audience: 'private', originPlatform: 'onebot' });
    expect(describeOf(task)).toEqual({ kind: 'task', audience: undefined, originPlatform: 'onebot' });
  });

  it('加载时不采信存储值：存成 owner 的群房间读回为 group，没有这些字段的旧记录补上', async () => {
    const stale = { name: '群', status: 'completed', children: [], config: {}, createdAt: 1, updatedAt: 1 };
    const sm = await setup({
      [GROUP]: { ...stale, id: GROUP, kind: 'room', audience: 'owner' },
      [`${GROUP}::abcd1234`]: { ...stale, id: `${GROUP}::abcd1234`, parentId: GROUP, kind: 'room', audience: 'group' },
      'session-abcd1234': { ...stale, id: 'session-abcd1234' },
    });

    expect(describeOf(sm.getSession(GROUP))).toEqual({ kind: 'room', audience: 'group', originPlatform: 'onebot' });
    expect(describeOf(sm.getSession(`${GROUP}::abcd1234`))).toEqual({
      kind: 'task',
      audience: undefined,
      originPlatform: 'onebot',
    });
    expect(describeOf(sm.getSession('session-abcd1234'))).toEqual({
      kind: 'room',
      audience: 'owner',
      originPlatform: undefined,
    });
  });

  it('调用方传的种类、受众与出生平台被忽略', async () => {
    const sm = await setup();
    const root = await sm.createSession({
      name: '新会话',
      kind: 'task',
      audience: 'group',
      originPlatform: 'onebot',
    } as never);
    const child = await sm.createChildSession(GROUP, { name: '子任务', kind: 'room', audience: 'private' } as never);

    expect(describeOf(root)).toEqual({ kind: 'room', audience: 'owner', originPlatform: undefined });
    expect(describeOf(child)).toEqual({ kind: 'task', audience: undefined, originPlatform: 'onebot' });
  });
});
