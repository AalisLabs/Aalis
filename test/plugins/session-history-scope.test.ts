import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import toolOnebot from '../../packages/plugin-tool-onebot/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { sessionValuesPlugin } from '../fixtures/session-settings.js';
import { sessionTableManager } from '../fixtures/session-table.js';

// ════════════════════════════════════════════════════════════
// 允许读取范围（tool-session 的 scope，可按会话设）：session_get_history 与 onebot_get_session_history 都经这个服务的
// 规则链，范围按当前会话的生效值在各平台规则之前裁决：current 时目标不是当前会话一律拒绝，platform 时跨平台拒绝。平台规则
// 只能在它放行之后再收窄。哪一层写坏了按 current。访问规则按生产的宽松取值（群读私聊、跨群、跨私聊都开），拒绝只能来自
// 范围。装上会话管理时三个房间已收录，同平台按会话记下的出生平台判；没有会话管理时没有出生平台，同平台范围读不到别的会话。
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

/** sessions 给出时装会话设置的替身（按会话 id 交本会话层的值）；recorded 时装只交会话记录的会话管理替身 */
async function setup(
  historyScope: string,
  { sessions, recorded = true }: { sessions?: Record<string, Record<string, unknown>>; recorded?: boolean } = {},
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
  if (recorded) host.provide.use(sessionManager, sessionTableManager(ROOMS));
  if (sessions) await app.plugin(sessionValuesPlugin(sessions));
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

const CURRENT_ONLY = { error: expect.stringContaining('读取范围限于当前会话') };

describe('session-history：允许读取范围按会话的生效值', () => {
  it('这个会话设成当前会话：两个工具读别的群、别人私聊都被拒，读本群照常', async () => {
    const { generic, onebot } = await setup('all', { sessions: { [CUR]: { scope: 'current' } } });
    expect(await generic(OTHER_GROUP)).toEqual(CURRENT_ONLY);
    expect(await generic(PRIV)).toEqual(CURRENT_ONLY);
    expect(await onebot('group', '20002')).toMatchObject(CURRENT_ONLY);
    expect(await onebot('private', '30001')).toMatchObject(CURRENT_ONLY);
    expect(await generic(CUR)).toMatchObject({ ok: true, sessionId: CUR });
    expect(await onebot('group', '20001')).toMatchObject({ ok: true, sessionId: CUR });
  });

  it('这个会话设成同平台、插件配置全部：跨平台被拒，同平台别的群照常', async () => {
    const { generic } = await setup('all', { sessions: { [CUR]: { scope: 'platform' } } });
    expect(await generic(WEB)).toEqual({ error: expect.stringContaining('读取范围限于同平台会话') });
    expect(await generic(OTHER_GROUP)).toMatchObject({ ok: true, sessionId: OTHER_GROUP });
  });

  it('生效值就是这个会话的值：插件配置同平台、会话设成全部时交给平台规则', async () => {
    const { generic } = await setup('platform', { sessions: { [CUR]: { scope: 'all' } } });
    expect(await generic(WEB)).toMatchObject({ ok: true, sessionId: WEB });
  });

  it('写坏了按当前会话：会话层或插件配置里的坏值都读不到别的会话', async () => {
    const atSession = await setup('all', { sessions: { [CUR]: { scope: 'everything' } } });
    expect(await atSession.generic(OTHER_GROUP)).toEqual(CURRENT_ONLY);
    const atGlobal = await setup('everything');
    expect(await atGlobal.generic(OTHER_GROUP)).toEqual(CURRENT_ONLY);
    expect(await atGlobal.generic(CUR)).toMatchObject({ ok: true, sessionId: CUR });
  });

  it('会话管理不在场：范围 all 时交给平台规则；platform 时没有记下的出生平台，读不到别的会话', async () => {
    const all = await setup('all', { recorded: false });
    expect(await all.generic(OTHER_GROUP)).toMatchObject({ ok: true, sessionId: OTHER_GROUP });
    expect(await all.onebot('private', '30001')).toMatchObject({ ok: true, sessionId: PRIV });
    const platformScope = await setup('platform', { recorded: false });
    expect(await platformScope.generic(OTHER_GROUP)).toEqual({ error: expect.stringContaining('目标=unknown') });
    expect(await platformScope.generic(CUR)).toMatchObject({ ok: true, sessionId: CUR });
  });
});
