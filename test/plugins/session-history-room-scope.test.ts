import { afterEach, describe, expect, it } from 'vitest';
import { type MemoryRecallScope, memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import toolOnebot from '../../packages/plugin-tool-onebot/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { roomScopeManager } from '../fixtures/room-scope.js';
import { storedRoom } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 召回按房间收窄（session-history 服务）：session_get_history 与 onebot_get_session_history
// 都经这个服务的规则链。房间 memoryRecallScope 在插件范围与各平台规则之前裁决：
// session 时目标不是当前会话一律拒绝，platform 时跨平台拒绝。平台规则只能在它放行之后再收窄。
// 访问规则按生产的宽松取值（群读私聊、跨群、跨私聊都开），拒绝只能来自房间范围。
// 装上会话管理时三个房间已收录，同平台按会话记下的出生平台判；没有会话管理时没有出生平台，同平台范围读不到别的会话。
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const CUR = `onebot:${SELF}:group:20001`;
const OTHER_GROUP = `onebot:${SELF}:group:20002`;
const PRIV = `onebot:${SELF}:private:30001`;
const WEB = 'webui:console';
const ROOMS = [CUR, OTHER_GROUP, PRIV].map(id => storedRoom(id));

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function adapter(name: string): PlatformAdapter {
  return { adapterName: name, platform: name, getConnections: () => [], sendMessage: async () => {} };
}

async function setup(
  historyScope: 'current' | 'platform' | 'all',
  room?: { rooms?: Record<string, MemoryRecallScope>; profiles?: Record<string, MemoryRecallScope> },
) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide });
  const handlers = new Map<string, RegisteredTool['handler']>();
  host.provide.use(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide.use(memory, {
    getHistory: async (sessionId: string) => [{ role: 'user', content: `${sessionId} 的原文`, timestamp: 1 }],
  } as never);
  host.provide.use(platform, adapter('onebot'));
  if (room) host.provide.use(sessionManager, roomScopeManager(room.rooms, room.profiles, ROOMS));
  await app.pluginAll([
    { definition: sessionTools, config: { scope: historyScope } },
    {
      definition: toolOnebot,
      config: { sessionHistory: { allowGroupReadPrivate: true, allowCrossGroup: true, allowCrossPrivate: true } },
    },
  ]);
  await app.start();
  await app.plugins.idle();
  for (const p of [sessionTools, toolOnebot]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`工具 ${name} 未注册`);
    return JSON.parse((await handler(args, { sessionId: CUR, platform: 'onebot' })) as string);
  };
  return {
    generic: (sessionId: string) => call('session_get_history', { session_id: sessionId }),
    onebot: (targetType: 'group' | 'private', targetId: string) =>
      call('onebot_get_session_history', { target_type: targetType, target_id: targetId }),
  };
}

const SESSION_ONLY = { error: expect.stringContaining('本房间的召回范围限于本会话') };

describe('session-history: 召回按房间收窄', () => {
  it('房间 session：两个工具读别的群、别人私聊都被拒，读本群照常', async () => {
    const { generic, onebot } = await setup('platform', { rooms: { [CUR]: 'session' } });
    expect(await generic(OTHER_GROUP)).toEqual(SESSION_ONLY);
    expect(await generic(PRIV)).toEqual(SESSION_ONLY);
    expect(await onebot('group', '20002')).toMatchObject(SESSION_ONLY);
    expect(await onebot('private', '30001')).toMatchObject(SESSION_ONLY);
    expect(await generic(CUR)).toMatchObject({ ok: true, sessionId: CUR });
    expect(await onebot('group', '20001')).toMatchObject({ ok: true, sessionId: CUR });
  });

  it('平台档写 session、房间未写：按会话所属平台解析，同样拒绝', async () => {
    const { generic, onebot } = await setup('platform', { profiles: { onebot: 'session' } });
    expect(await generic(PRIV)).toEqual(SESSION_ONLY);
    expect(await onebot('group', '20002')).toMatchObject(SESSION_ONLY);
  });

  it('房间 platform：插件范围为 all 时跨平台仍被拒，同平台别的群照常', async () => {
    const { generic } = await setup('all', { rooms: { [CUR]: 'platform' } });
    expect(await generic(WEB)).toEqual({ error: expect.stringContaining('本房间的召回范围限于同平台会话') });
    expect(await generic(OTHER_GROUP)).toMatchObject({ ok: true, sessionId: OTHER_GROUP });
  });

  it('房间写 all：放不宽插件范围，插件 platform 时跨平台照旧被拒', async () => {
    const { generic } = await setup('platform', { rooms: { [CUR]: 'all' } });
    expect(await generic(WEB)).toEqual({ error: expect.stringContaining('仅允许读取同平台会话历史') });
  });

  it('session-manager 不在场：插件范围 all 时交给平台规则；platform 时没有记下的出生平台，读不到别的会话', async () => {
    const all = await setup('all');
    expect(await all.generic(OTHER_GROUP)).toMatchObject({ ok: true, sessionId: OTHER_GROUP });
    expect(await all.onebot('private', '30001')).toMatchObject({ ok: true, sessionId: PRIV });
    const platformScope = await setup('platform');
    expect(await platformScope.generic(OTHER_GROUP)).toEqual({ error: expect.stringContaining('目标=unknown') });
    expect(await platformScope.generic(CUR)).toMatchObject({ ok: true, sessionId: CUR });
  });
});
