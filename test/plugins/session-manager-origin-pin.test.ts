import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformAdapter } from '../../packages/api-platform/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { PERSONA, startSessionManager, TOOL_GROUPS } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 房间会话钉死出生平台：不论从哪个入口驱动（WebUI 往群里插话、群里建出的子任务、适配器没加载），
// 继承链都按会话 id 前缀的出生平台选档；没有出生平台的 owner 面会话照旧按入口平台。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';

const LAYERS = {
  platforms: {
    webui: { enabledToolGroups: ['system'], persona: '<webui 人设>' },
    onebot: { enabledToolGroups: ['search'], persona: '<群人设>' },
    cli: { enabledToolGroups: ['system'], persona: '<cli 人设>' },
  },
};

/** onebot 适配器不实现 canHandle：按 `onebot:` 前缀认领会话 */
const ONEBOT = { adapterName: 'OneBot', platform: 'onebot', getConnections: () => [], sendMessage: async () => {} };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(adapters: Partial<PlatformAdapter>[]) {
  const started = await startSessionManager({ layers: LAYERS, settings: [PERSONA, TOOL_GROUPS], adapters });
  apps.push(started.app);
  return started;
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

  it('群房间下的子任务（metadata 记下的平台是 webui）：resolveConfig 与 resolveInheritance 都按 onebot', async () => {
    const { sm } = await setup([ONEBOT]);
    const child = await sm.createChildSession(GROUP, { metadata: { platform: 'webui' } });

    expect(sm.resolveConfig(child.id, 'webui').enabledToolGroups).toEqual(['search']);
    const got = sm.resolveInheritance(child.id, 'webui');
    expect(got.platform).toBe('onebot');
    expect(got.values).toEqual({ enabledToolGroups: ['search'], persona: '<群人设>' });
  });

  it('没有注册任何平台适配器：IM 房间照样按 onebot 选档', async () => {
    const { sm } = await setup([]);
    await sm.ensureSession(GROUP);

    expect(sm.resolveConfig(GROUP, 'webui').persona).toBe('<群人设>');
    const got = sm.resolveInheritance(GROUP, 'webui');
    expect(got.platform).toBe('onebot');
    expect(got.values.enabledToolGroups).toEqual(['search']);
  });
});

describe('owner 面会话照旧按入口平台', () => {
  it('WebUI 建的根会话与它的子会话用 webui 档；cli-default 经 CLI 入口用 cli 档', async () => {
    const { sm } = await setup([ONEBOT]);
    const root = await sm.createSession({});
    const child = await sm.createSession({ parentId: root.id });
    expect(child.id.startsWith(`${root.id}::`)).toBe(true);

    for (const id of [root.id, child.id]) {
      expect(sm.resolveConfig(id, 'webui').enabledToolGroups, id).toEqual(['system']);
      const inheritance = sm.resolveInheritance(id, 'webui');
      expect(inheritance.platform, id).toBe('webui');
      expect(inheritance.values.persona, id).toBe('<webui 人设>');
    }

    expect(sm.resolveConfig('cli-default', 'cli').persona).toBe('<cli 人设>');
    expect(sm.resolveInheritance('cli-default', 'cli').platform).toBe('cli');
  });
});
