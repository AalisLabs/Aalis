import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionHistory } from '../../packages/api-session-history/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, optional, provide } from '../../packages/core/src/index.js';
import toolOnebot from '../../packages/plugin-tool-onebot/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import { type ConfigSchema, deepMergeDefaults, defaultsFrom } from '../../packages/schema-config/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { roomScopeManager } from '../fixtures/room-scope.js';
import { storedRoom } from '../fixtures/rooms.js';

// tool-onebot 同时提供 OneBot 会话历史的拒绝规则，而 session_get_history 对没有规则的平台默认放行。
// 所以写坏的开关不能让插件进 error：那会连同拒绝规则一起撤掉，群聊反而能读私聊。
// 两个房间默认已收录：同平台范围按会话记下的出生平台判，放行后才轮到平台规则。平台规则按目标会话 id 认出管它的
// 规则（id 的写法归平台），会话表里没有记录的目标照样问它。

const GROUP = 'onebot:10001:group:20002';
const PRIVATE = 'onebot:10001:private:30003';
const schema = toolOnebot.configSchema as ConfigSchema;

const booted: App[] = [];
afterEach(async () => {
  for (const app of booted.splice(0)) await app.stop();
});

/** rooms 是会话表里已收录的房间，scope 是 tool-session 的插件范围（缺省用它的默认值） */
async function setup(
  onebotFileConfig: Record<string, unknown>,
  { rooms = [GROUP, PRIVATE], scope }: { rooms?: string[]; scope?: 'all' } = {},
) {
  const warnings: string[] = [];
  const logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logger });
  await registerHubs(app);
  booted.push(app);
  const host = app.bind({ provide, history: optional(sessionHistory) });
  host.provide(tools, {
    register: (_t: Omit<RegisteredTool, 'pluginName'>) => () => {},
    registerGroup: () => () => {},
  } as never);
  host.provide(memory, { getHistory: async () => [] } as never);
  const records = rooms.map(id => storedRoom(id));
  host.provide(sessionManager, roomScopeManager({}, {}, records));
  await app.pluginAll([
    { definition: sessionTools, config: scope ? { scope } : {} },
    { definition: toolOnebot, config: deepMergeDefaults(defaultsFrom(schema), onebotFileConfig) },
  ]);
  await app.start();
  await app.plugins.idle();
  const readPrivateFromGroup = () => {
    const svc = host.history.current;
    if (!svc) throw new Error('session-history 不在场');
    return svc.getHistory({ sessionId: PRIVATE }, { sessionId: GROUP, platform: 'onebot' } as never);
  };
  return { state: app.plugins.getPlugin('@aalis/plugin-tool-onebot')?.state, readPrivateFromGroup, warnings };
}

describe('tool-onebot 写坏的开关回落默认值，拒绝规则保持在场', () => {
  it('合法 false：群聊读私聊被拒', async () => {
    const r = await setup({ sessionHistory: { allowGroupReadPrivate: false } });
    expect(r.state).toBe('active');
    expect(await r.readPrivateFromGroup()).toEqual({ error: expect.stringContaining('不允许从群聊读取私聊历史') });
  });

  it.each([
    ['YAML 的 no（字符串）', { sessionHistory: { allowGroupReadPrivate: 'no' } }],
    ['带引号的 false', { sessionHistory: { allowGroupReadPrivate: 'false' } }],
    ['与历史无关的工具开关', { groupManagement: { enabled: 'false' } }],
  ])('%s：插件照常激活、告警，群聊读私聊仍被拒', async (_label, config) => {
    const r = await setup(config);
    expect(r.state).toBe('active');
    expect(r.warnings.some(w => w.includes('配置项') && w.includes(Object.keys(config)[0]))).toBe(true);
    expect(await r.readPrivateFromGroup()).toEqual({ error: expect.stringContaining('不允许从群聊读取私聊历史') });
  });
});

describe('平台规则按目标会话 id 认出管它的规则', () => {
  it('会话表里没有这两个房间、插件范围 all：群聊读私聊照样被拒', async () => {
    const r = await setup({}, { rooms: [], scope: 'all' });
    expect(await r.readPrivateFromGroup()).toEqual({ error: expect.stringContaining('不允许从群聊读取私聊历史') });
  });
});
