import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { resolveText } from '../../packages/schema-i18n/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 工具分组是工具注册表的按会话字段 enabledToolGroups，只有 owner 能改。ToolService.sessionGroups(sessionId, platform)
// 交这个会话的生效值，platform 是入口平台，只对没有出生平台的会话起作用。会话设置不在时取插件配置里的值。
// 哪一层都没设（生效值是 undefined）时按会话从哪里建的算：根会话（子会话取根会话的）带创建来源，即在本机的 WebUI 或终端
// 建的，开全部分组；其余一律不开，包括聊天平台的群与私聊（对端是 owner 的私聊也不开）和内部会话。不判 owner：为了 owner
// 开了，owner 默认用什么工具就看不出来。会话管理缺席时不开。显式写的 []（任何一层）是不开。
// ════════════════════════════════════════════════════════════

const TOOLS = '@aalis/plugin-tools';
const OWNER_QQ = '99999';
const OWNER = { platform: 'onebot', userId: OWNER_QQ };
const GROUP = 'onebot:10000:group:20001';
const OWNER_DM = `onebot:10000:private:${OWNER_QQ}`;
const OTHER_DM = 'onebot:10000:private:30001';
const ROOMS = Object.fromEntries([GROUP, OWNER_DM, OTHER_DM].map(id => [id, storedRoom(id)]));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('工具分组字段', () => {
  it('写在工具注册表的 configSchema 上：多选、可自填、没有作者默认（没设时的含义写在 unset）、各种会话都适用、只有 owner 能改', () => {
    const field = (toolsPlugin.configSchema as unknown as Record<string, Record<string, unknown>>).enabledToolGroups;
    expect(field).toMatchObject({
      type: 'multiselect',
      dynamicOptions: 'toolGroups',
      allowCustom: true,
      session: { prominence: 'common', order: 30 },
    });
    expect('default' in field).toBe(false);
    const session = field.session as { appliesTo?: unknown; minLevel?: number; unset?: unknown };
    expect([session.appliesTo, session.minLevel]).toEqual([undefined, undefined]);
    expect(resolveText(session.unset as never, ['zh-CN'])).toBe(
      '在本机（WebUI、终端）建的会话：全部分组；别的会话：不开',
    );
  });
});

describe('sessionGroups', () => {
  it('按会话取生效值：本会话层压过平台档；没有出生平台的会话按入口平台选平台档', async () => {
    const { app, sm, admin } = await startSettings({
      doc: { sessionConfig: { platforms: { cli: { [TOOLS]: { enabledToolGroups: ['system'] } } } } },
      fields: [toolsPlugin],
      owners: [OWNER],
    });
    apps.push(app);
    const registry = app.bind({ tools }).tools.use;
    const owner = await sm.createSession({ name: '本机会话' }, { createdFrom: 'webui' });
    expect(registry.sessionGroups(owner.id, 'cli')).toEqual(['system']);
    await admin.update({ sessionId: owner.id }, { plugin: TOOLS, key: 'enabledToolGroups', value: ['web'] });
    expect(registry.sessionGroups(owner.id, 'cli')).toEqual(['web']);
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

describe('哪一层都没设：按会话从哪里建的算', () => {
  /** 权限服务在场、认得 owner：它在不在都不影响这条规则 */
  async function start() {
    const started = await startSettings({ fields: [toolsPlugin], stored: ROOMS, owners: [OWNER] });
    apps.push(started.app);
    return { ...started, registry: started.app.bind({ tools }).tools.use };
  }

  it('在 WebUI 或终端建的根会话开全部分组，它们的子会话也开', async () => {
    const { sm, registry } = await start();
    const webui = await sm.createSession({ name: 'w' }, { createdFrom: 'webui' });
    const cli = await sm.ensureSession('cli-default', {}, { createdFrom: 'cli' });
    expect(registry.sessionGroups(webui.id, 'webui')).toEqual(['*']);
    expect(registry.sessionGroups(cli.id, 'cli')).toEqual(['*']);
    expect(registry.sessionGroups((await sm.createChildSession(webui.id, {})).id, 'webui')).toEqual(['*']);
    expect(registry.sessionGroups((await sm.createChildSession(cli.id, {})).id, 'cli')).toEqual(['*']);
  });

  it('子会话建立时写下父会话的生效值：父会话没设工具分组时不写，子会话照样按根会话算', async () => {
    const { sm, admin, registry } = await start();
    const webui = await sm.createSession({ name: 'w' }, { createdFrom: 'webui' });
    const metadata = admin.childMetadata(webui.id, { platform: 'webui' });
    const written = (metadata['session-settings'] as { values: Array<{ plugin: string }> }).values;
    expect(written.filter(entry => entry.plugin === TOOLS)).toEqual([]);
    const child = await sm.createChildSession(webui.id, { metadata });
    expect(registry.sessionGroups(child.id, 'webui')).toEqual(['*']);
  });

  it('聊天平台的群不开，群的子会话也不开', async () => {
    const { sm, registry } = await start();
    expect(registry.sessionGroups(GROUP, 'onebot')).toEqual([]);
    expect(registry.sessionGroups((await sm.createChildSession(GROUP, {})).id, 'onebot')).toEqual([]);
  });

  it('聊天平台的私聊不开：对端是 owner 的也不开', async () => {
    const { registry } = await start();
    expect(registry.sessionGroups(OWNER_DM, 'onebot')).toEqual([]);
    expect(registry.sessionGroups(OTHER_DM, 'onebot')).toEqual([]);
  });

  it('内部会话（编排、定时任务、mcp-server、按 id 兜底建档的）不开', async () => {
    const { sm, registry } = await start();
    for (const id of ['workflow::daily', 'scheduler:zz-job', 'mcp:zz-client', 'zz-unfiled']) {
      await sm.ensureSession(id);
      expect(registry.sessionGroups(id, 'webui'), id).toEqual([]);
    }
  });

  it('显式写的 []（本会话层或平台档）是不开，与没设分开', async () => {
    const { sm, admin, registry } = await start();
    const webui = await sm.createSession({ name: 'w' }, { createdFrom: 'webui' });
    await admin.update({ sessionId: webui.id }, { plugin: TOOLS, key: 'enabledToolGroups', value: [] });
    expect(registry.sessionGroups(webui.id, 'webui')).toEqual([]);
    await admin.update({ sessionId: webui.id }, { plugin: TOOLS, key: 'enabledToolGroups', value: null });
    expect(registry.sessionGroups(webui.id, 'webui')).toEqual(['*']);
    await admin.update(
      { layer: { scope: 'platform', platform: 'webui' } },
      { plugin: TOOLS, key: 'enabledToolGroups', value: [] },
    );
    expect(registry.sessionGroups(webui.id, 'webui')).toEqual([]);
  });

  it('会话管理缺席时一律不开', async () => {
    const { app, store } = hostedApp({});
    apps.push(app);
    await registerHubs(app);
    await registerFromDoc(app, store, toolsPlugin);
    await app.plugins.idle();
    expect(app.bind({ tools }).tools.use.sessionGroups('<任意会话>', 'webui')).toEqual([]);
  });
});
