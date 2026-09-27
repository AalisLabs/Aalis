import { App, provide } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { type SessionInheritance, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 房间会话钉死出生平台：不论从哪个入口驱动（WebUI 往群里插话、群里建出的子任务、适配器没加载），
// 继承链都按会话 id 前缀的出生平台选档；没有出生平台的 owner 面会话照旧按入口平台。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';

const PROFILES = {
  platformProfiles: [
    { platform: 'webui', enabledToolGroups: ['system'], persona: '<webui 人设>' },
    { platform: 'onebot', enabledToolGroups: ['search'], persona: '<群人设>' },
    { platform: 'cli', enabledToolGroups: ['system'], persona: '<cli 人设>' },
  ],
};

/** onebot 适配器不实现 canHandle：按 `onebot:` 前缀认领会话 */
const ONEBOT = { adapterName: 'OneBot', platform: 'onebot', getConnections: () => [], sendMessage: async () => {} };
/** CLI 适配器靠 canHandle 认领不带前缀的 cli-default */
const CLI = {
  adapterName: 'CLI',
  platform: 'cli',
  getConnections: () => [],
  sendMessage: async () => {},
  canHandle: (id: string) => id === 'cli-default',
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(adapters: Partial<PlatformAdapter>[]) {
  const app = new App({ name: 'T', logLevel: 'error' });
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
  for (const adapter of adapters) host.provide(platform, adapter as never);
  await app.plugin(sessionManagerPlugin, PROFILES);
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
  return { sm: host.sessionManager.require(), action, inheritanceOf };
}

describe('房间会话按出生平台选档', () => {
  it('WebUI 入口驱动群房间：resolveConfig 取 onebot 档，resolveInheritance 的平台为 onebot', async () => {
    const { sm } = await setup([ONEBOT]);

    // 未登记（入站先于建档）与已登记的房间一样钉死
    for (const registered of [false, true]) {
      if (registered) await sm.ensureSession(GROUP);
      const resolved = sm.resolveConfig(GROUP, 'webui');
      expect(resolved.enabledToolGroups, `registered=${registered}`).toEqual(['search']);
      expect(resolved.persona).toBe('<群人设>');
      const inheritance = sm.resolveInheritance(GROUP, 'webui');
      expect(inheritance.platform).toBe('onebot');
      expect(inheritance.sources).toEqual({ enabledToolGroups: 'platform', persona: 'platform' });
    }
  });

  it('群房间下的子任务（metadata 记下的平台是 webui）：resolveConfig 与 getInheritance 都按 onebot', async () => {
    const { sm, inheritanceOf } = await setup([ONEBOT]);
    const child = await sm.createChildSession(GROUP, { metadata: { platform: 'webui' } });

    expect(sm.resolveConfig(child.id, 'webui').enabledToolGroups).toEqual(['search']);
    const got = await inheritanceOf(child.id);
    expect(got.platform).toBe('onebot');
    expect(got.values).toEqual({ enabledToolGroups: ['search'], persona: '<群人设>' });
  });

  it('没有注册任何平台适配器：IM 房间照样按 onebot 选档', async () => {
    const { sm, inheritanceOf } = await setup([]);
    await sm.ensureSession(GROUP);

    expect(sm.resolveConfig(GROUP, 'webui').persona).toBe('<群人设>');
    const got = await inheritanceOf(GROUP);
    expect(got.platform).toBe('onebot');
    expect(got.values.enabledToolGroups).toEqual(['search']);
  });
});

describe('owner 面会话照旧按入口平台', () => {
  it('WebUI 建的根会话与它的子会话用 webui 档；cli-default 经 CLI 入口用 cli 档', async () => {
    const { sm, action, inheritanceOf } = await setup([ONEBOT, CLI]);
    const root = (await action('createSession')({})) as { id: string };
    const child = (await action('createSession')({ parentId: root.id })) as { id: string };
    expect(child.id.startsWith(`${root.id}::`)).toBe(true);

    for (const id of [root.id, child.id]) {
      expect(sm.resolveConfig(id, 'webui').enabledToolGroups, id).toEqual(['system']);
      expect(sm.resolveInheritance(id, 'webui').platform, id).toBe('webui');
      const got = await inheritanceOf(id);
      expect(got.platform, id).toBe('webui');
      expect(got.values.persona, id).toBe('<webui 人设>');
    }

    expect(sm.resolveConfig('cli-default', 'cli').persona).toBe('<cli 人设>');
    const cli = await inheritanceOf('cli-default');
    expect(cli.platform, 'CLI 适配器经 canHandle 认领 cli-default').toBe('cli');
    expect(cli.values.persona).toBe('<cli 人设>');
  });
});
