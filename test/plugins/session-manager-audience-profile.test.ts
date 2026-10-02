import { afterEach, describe, expect, it } from 'vitest';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { PAPER_NAME, PERSONA, startSessionManager, TOOL_GROUPS } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 平台档的受众条目：同一平台的群与私聊可以用不同的档。
//
// - 受众条目只写与同平台的平台档不同的键，按层叠加在平台档上，来源层记为 audience；
// - 受众不是 group、private 的条目告警后忽略，不当成「不限受众」覆盖整个平台的房间；
// - 只对有出生平台的会话生效，owner 面会话不受影响。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

const BASE = { enabledToolGroups: ['search'], persona: '<群人设>' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(layers: AalisConfig['sessionConfig']) {
  const started = await startSessionManager({ layers, settings: [PERSONA, TOOL_GROUPS, PAPER_NAME] });
  apps.push(started.app);
  return started;
}

describe('受众条目叠加在平台档上', () => {
  it('私聊房间取私聊条目的分组与平台档的人设，群房间只取平台档，私聊房间的子任务同样叠加', async () => {
    const { sm, warns } = await setup({
      platforms: { onebot: BASE },
      audiences: { onebot: { private: { enabledToolGroups: ['search', 'scheduler'] } } },
    });

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
    expect(warns, '合法条目不告警').toEqual([]);
  });

  it('受众写错的条目告警后忽略：群房间与私聊房间都拿不到它的键', async () => {
    const { sm, warns } = await setup({
      platforms: { onebot: BASE },
      audiences: { onebot: { grp: { enabledToolGroups: ['system'], paperName: '<白纸甲>' } } as never },
    });

    for (const id of [GROUP, PRIVATE]) {
      const resolved = sm.resolveConfig(id, 'onebot');
      expect(resolved.enabledToolGroups, id).toEqual(['search']);
      expect(resolved.paperName, id).toBeUndefined();
    }
    const warned = warns.find(w => w.includes('grp'));
    expect(warned, '点名取值').toBeTruthy();
    expect(warned, '点名平台').toContain('onebot');
  });
});

describe('owner 面会话不受受众条目影响', () => {
  it('WebUI 根会话、它的子会话、webui-default 与 cli-default 只取入口平台的平台档', async () => {
    const { sm } = await setup({
      platforms: { webui: { enabledToolGroups: ['system'] }, cli: { enabledToolGroups: ['system'] } },
      audiences: {
        webui: { private: { enabledToolGroups: ['search'] }, group: { enabledToolGroups: ['search'] } },
        cli: { private: { enabledToolGroups: ['search'] } },
      },
    });
    const root = await sm.createSession({});
    const child = await sm.createSession({ parentId: root.id });

    for (const id of [root.id, child.id, 'webui-default']) {
      const inheritance = sm.resolveInheritance(id, 'webui');
      expect(inheritance.values.enabledToolGroups, id).toEqual(['system']);
      expect(inheritance.sources.enabledToolGroups, id).toBe('platform');
      expect(inheritance.audience, id).toBeUndefined();
    }
    expect(sm.resolveConfig('webui-default', 'webui').enabledToolGroups).toEqual(['system']);
    expect(sm.resolveConfig('cli-default', 'cli').enabledToolGroups).toEqual(['system']);
    expect(sm.resolveInheritance('cli-default', 'cli').sources.enabledToolGroups).toBe('platform');
  });
});
