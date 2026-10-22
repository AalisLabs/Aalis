import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 工具分组是工具注册表的按会话字段 enabledToolGroups：作者默认空列表（只给不属于任何分组的工具），只有 owner 能改。
// ToolService.sessionGroups(sessionId, platform) 交这个会话的生效值，platform 是入口平台，只对没有出生平台的会话起作用。
// 会话设置不在时取插件配置里的值。
// ════════════════════════════════════════════════════════════

const TOOLS = '@aalis/plugin-tools';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('工具分组字段', () => {
  it('写在工具注册表的 configSchema 上：多选、可自填、作者默认空列表、各种会话都适用、只有 owner 能改', () => {
    const field = (toolsPlugin.configSchema as unknown as Record<string, Record<string, unknown>>).enabledToolGroups;
    expect(field).toMatchObject({
      type: 'multiselect',
      dynamicOptions: 'toolGroups',
      allowCustom: true,
      default: [],
      session: { prominence: 'common', order: 30 },
    });
    const session = field.session as { appliesTo?: unknown; minLevel?: number; unset?: unknown };
    expect([session.appliesTo, session.minLevel, session.unset]).toEqual([undefined, undefined, undefined]);
  });
});

describe('sessionGroups', () => {
  it('按会话取生效值：本会话层压过平台档；没有出生平台的会话按入口平台选平台档；都没设时是空列表', async () => {
    const { app, sm, admin } = await startSettings({
      doc: { sessionConfig: { platforms: { cli: { [TOOLS]: { enabledToolGroups: ['*'] } } } } },
      fields: [toolsPlugin],
    });
    apps.push(app);
    const registry = app.bind({ tools }).tools.use;
    const owner = await sm.createSession({ name: '本机会话' });
    expect(registry.sessionGroups(owner.id, 'cli')).toEqual(['*']);
    expect(registry.sessionGroups(owner.id, 'webui')).toEqual([]);
    await admin.update({ sessionId: owner.id }, { plugin: TOOLS, key: 'enabledToolGroups', value: ['system'] });
    expect(registry.sessionGroups(owner.id, 'cli')).toEqual(['system']);
  });

  it('会话设置不在时取插件配置里的值', async () => {
    const { app } = await startSettings({
      settings: false,
      doc: { plugins: { [TOOLS]: { enabledToolGroups: ['web'] } } },
      fields: [toolsPlugin],
    });
    apps.push(app);
    expect(app.bind({ tools }).tools.use.sessionGroups('<任意会话>', 'cli')).toEqual(['web']);
  });
});
