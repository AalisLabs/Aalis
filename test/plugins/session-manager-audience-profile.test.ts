import { App, type Logger, provide } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { type SessionInheritance, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 平台档的受众条目：同一平台的群与私聊可以用不同的档。
//
// - 写了 audience 的条目只列与同平台基础档不同的键，按层叠加在基础档上，来源层记为 audience；
// - 受众值写错的整条丢弃并告警，不当成「不限受众」覆盖整个平台的房间；
// - 只对有出生平台的会话生效，owner 面会话不受影响；getPlatformProfiles 不含受众条目。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

const BASE = { platform: 'onebot', enabledToolGroups: ['search'], persona: '<群人设>' };
const PRIVATE_ENTRY = { platform: 'onebot', audience: 'private', enabledToolGroups: ['search', 'scheduler'] };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(platformProfiles: Record<string, unknown>[]) {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  await registerHubs(app);
  const actions = new Map<string, WebuiActionHandler>();
  const host = app.bind({ provide, sessionManager });
  host.provide(memory, fakeMemory() as never);
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction(method: string, handler: WebuiActionHandler) {
      actions.set(method, handler);
      return () => void actions.delete(method);
    },
  } as never);
  await app.plugin(sessionManagerPlugin, { platformProfiles });
  await app.plugins.idle();
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  const action = (method: string) => {
    const handler = actions.get(method);
    if (!handler) throw new Error(`页面动作 ${method} 未登记`);
    return handler;
  };
  const inheritanceOf = async (sessionId: string) =>
    (await action('getInheritance')({ sessionId })) as SessionInheritance;
  return { sm: host.sessionManager.require(), action, inheritanceOf, warns };
}

describe('受众条目叠加在平台档上', () => {
  it('私聊房间取私聊条目的分组与基础档的人设，群房间只取基础档，私聊房间的子任务同样叠加', async () => {
    const { sm, inheritanceOf, warns } = await setup([BASE, PRIVATE_ENTRY]);

    const priv = sm.resolveInheritance(PRIVATE, 'webui');
    expect(priv.values).toEqual({ enabledToolGroups: ['search', 'scheduler'], persona: '<群人设>' });
    expect(priv.sources).toEqual({ enabledToolGroups: 'audience', persona: 'platform' });
    expect(priv.platform).toBe('onebot');
    expect(priv.audience).toBe('private');
    expect(sm.resolveConfig(PRIVATE, 'onebot').enabledToolGroups).toEqual(['search', 'scheduler']);

    const group = sm.resolveInheritance(GROUP, 'onebot');
    expect(group.values).toEqual({ enabledToolGroups: ['search'], persona: '<群人设>' });
    expect(group.sources).toEqual({ enabledToolGroups: 'platform', persona: 'platform' });
    expect(group.audience).toBe('group');

    const child = await sm.createChildSession(PRIVATE, { metadata: { platform: 'webui' } });
    expect(sm.resolveConfig(child.id, 'webui').enabledToolGroups).toEqual(['search', 'scheduler']);
    expect(sm.resolveInheritance(child.id, 'webui').sources.enabledToolGroups).toBe('audience');

    const got = await inheritanceOf(PRIVATE);
    expect(got.platform).toBe('onebot');
    expect(got.audience).toBe('private');
    expect(got.sources.enabledToolGroups).toBe('audience');

    // 受众条目不混进 getPlatformProfiles：它的返回会被页面动作整份复制进新会话的 config
    expect(sm.getPlatformProfiles()).toEqual({ onebot: { enabledToolGroups: ['search'], persona: '<群人设>' } });
    expect(warns, '合法条目不告警').toEqual([]);
  });

  it('受众写错的整条丢弃并告警：群房间与私聊房间都拿不到它的键', async () => {
    const { sm, warns } = await setup([
      BASE,
      { platform: 'onebot', audience: 'grp', enabledToolGroups: ['system'], remoteAgentTypes: ['<实例甲>'] },
    ]);

    for (const id of [GROUP, PRIVATE]) {
      const resolved = sm.resolveConfig(id, 'onebot');
      expect(resolved.enabledToolGroups, id).toEqual(['search']);
      expect(resolved.remoteAgentTypes, id).toBeUndefined();
    }
    expect(sm.getPlatformProfiles()).toEqual({ onebot: { enabledToolGroups: ['search'], persona: '<群人设>' } });
    const warned = warns.find(w => w.includes('grp'));
    expect(warned, '点名取值').toBeTruthy();
    expect(warned, '点名平台').toContain('onebot');
  });
});

describe('owner 面会话不受受众条目影响', () => {
  it('WebUI 根会话、它的子会话、webui-default 与 cli-default 只取入口平台的基础档', async () => {
    const { sm, action, inheritanceOf } = await setup([
      { platform: 'webui', enabledToolGroups: ['system'] },
      { platform: 'webui', audience: 'private', enabledToolGroups: ['search'] },
      { platform: 'webui', audience: 'group', enabledToolGroups: ['search'] },
      { platform: 'cli', enabledToolGroups: ['system'] },
      { platform: 'cli', audience: 'private', enabledToolGroups: ['search'] },
    ]);
    const root = (await action('createSession')({})) as { id: string };
    const child = (await action('createSession')({ parentId: root.id })) as { id: string };

    for (const id of [root.id, child.id, 'webui-default']) {
      const inheritance = sm.resolveInheritance(id, 'webui');
      expect(inheritance.values.enabledToolGroups, id).toEqual(['system']);
      expect(inheritance.sources.enabledToolGroups, id).toBe('platform');
      expect(inheritance.audience, id).toBeUndefined();
      const got = await inheritanceOf(id);
      expect(got.values.enabledToolGroups, id).toEqual(['system']);
      expect(got.audience, id).toBeUndefined();
    }
    expect(sm.resolveConfig('webui-default', 'webui').enabledToolGroups).toEqual(['system']);
    expect(sm.resolveConfig('cli-default', 'cli').enabledToolGroups).toEqual(['system']);
    expect(sm.resolveInheritance('cli-default', 'cli').sources.enabledToolGroups).toBe('platform');
  });
});
