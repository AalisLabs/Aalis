import { App, type Logger, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 会话配置的按房间键：白纸与远端代理的房间设置、召回范围，进同一条继承链。
//
// - 平台档读得到这七个键，类型不对的丢弃并告警（它们关系到费用与召回范围，不做宽松转换）；
// - 房间只覆盖其中一个键时，其余照常继承平台档；
// - 建会话时复制配置（WebUI 的 createSession）不冻结房间专属键，召回范围照常带上；
// - 会话页取继承值时由服务端推出会话所属平台，并回每个键来自哪一层。
// ════════════════════════════════════════════════════════════

/** 只经继承链实时解析、不随建会话复制的键（与 ROOM_ONLY_CONFIG_KEYS 同一份清单，这里单写一遍防它被悄悄缩短） */
const ROOM_ONLY = [
  'paperEnabled',
  'paperName',
  'remoteAgentTypes',
  'remoteAgentUserDailyCents',
  'remoteAgentUserDailyTasks',
  'remoteAgentRoomDailyCents',
] as const;

/** 七个新键都写上的一份合法平台档 */
const FULL_ROOM_PROFILE = {
  paperEnabled: true,
  paperName: '<试点白纸名>',
  remoteAgentTypes: ['<远端代理实例 id>'],
  remoteAgentUserDailyCents: 100,
  remoteAgentUserDailyTasks: 3,
  remoteAgentRoomDailyCents: 500,
  memoryRecallScope: 'session',
};

async function setup(pluginConfig: Record<string, unknown>) {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'error', logger });
  await registerHubs(app);
  // 桩 webui-server：页面动作登记到这里，测试按 method 取处理函数
  const actions = new Map<string, WebuiActionHandler>();
  const host = app.bind({ provide, sessionManager });
  // memory 是会话管理的 required 依赖：不先摆上，插件会停在 pending
  host.provide(memory, fakeMemory() as never);
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction(method: string, handler: WebuiActionHandler) {
      actions.set(method, handler);
      return () => void actions.delete(method);
    },
  } as never);
  // onebot 适配器不实现 canHandle：按 `onebot:` 前缀认领会话
  host.provide(platform, {
    adapterName: 'OneBot',
    platform: 'onebot',
    getConnections: () => [],
    sendMessage: async () => {},
  } as never);
  await app.plugin(sessionManagerPlugin, pluginConfig);
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错——核激活状态，别让「压根没跑起来」冒充绿
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  const action = (method: string) => {
    const handler = actions.get(method);
    if (!handler) throw new Error(`页面动作 ${method} 未登记`);
    return handler;
  };
  return { app, sm: host.sessionManager.require(), action, actions, warns };
}

describe('按房间键进继承链', () => {
  it('房间只覆盖 paperEnabled，平台档的上限照常继承；房间写 null 回到继承', async () => {
    const { app, sm } = await setup({
      platformProfiles: [{ platform: 'onebot', paperEnabled: false, remoteAgentUserDailyCents: 100 }],
    });
    const room = 'onebot:bot:group:g1';
    await sm.ensureSession(room, { config: { paperEnabled: true } });

    const resolved = sm.resolveConfig(room, 'onebot');
    expect(resolved.paperEnabled, '房间覆盖压过平台档').toBe(true);
    expect(resolved.remoteAgentUserDailyCents, '未覆盖的键继承平台档').toBe(100);

    // 持久化读回来的「清除覆盖」是 null：与 undefined 同义，回到继承
    await sm.ensureSession(room, { config: { paperEnabled: null } as never });
    expect(sm.resolveConfig(room, 'onebot').paperEnabled).toBe(false);
    await app.stop();
  });

  it('平台档读到七个新键', async () => {
    const { app, sm, warns } = await setup({ platformProfiles: [{ platform: 'onebot', ...FULL_ROOM_PROFILE }] });
    expect(sm.getPlatformProfiles().onebot).toEqual(FULL_ROOM_PROFILE);
    expect(warns, '合法取值不告警').toEqual([]);
    await app.stop();
  });

  it('类型不对的丢弃并告警：远端类型写成字符串、上限为负、召回范围不在三档里', async () => {
    const { app, sm, warns } = await setup({
      platformProfiles: [
        {
          platform: 'onebot',
          paperEnabled: 'yes',
          paperName: 42,
          remoteAgentTypes: '<远端代理实例 id>',
          remoteAgentUserDailyCents: -1,
          remoteAgentUserDailyTasks: Number.POSITIVE_INFINITY,
          remoteAgentRoomDailyCents: '500',
          memoryRecallScope: 'x',
        },
      ],
    });
    expect(sm.getPlatformProfiles().onebot).toEqual({});
    const joined = warns.join('\n');
    for (const key of [
      'paperEnabled',
      'paperName',
      'remoteAgentTypes',
      'remoteAgentUserDailyCents',
      'remoteAgentUserDailyTasks',
      'remoteAgentRoomDailyCents',
      'memoryRecallScope',
    ]) {
      expect(joined, `${key} 被丢弃时应告警`).toContain(key);
    }
    await app.stop();
  });

  it('远端类型数组里的非字符串项被滤掉并告警', async () => {
    const { app, sm, warns } = await setup({
      platformProfiles: [{ platform: 'onebot', remoteAgentTypes: ['<实例甲>', 7, null, '<实例乙>'] }],
    });
    expect(sm.getPlatformProfiles().onebot).toEqual({ remoteAgentTypes: ['<实例甲>', '<实例乙>'] });
    expect(warns.join('\n')).toContain('remoteAgentTypes');
    await app.stop();
  });

  it('空串与 null 按未设置处理，不告警（WebUI 表单留空、YAML 裸键）', async () => {
    const { app, sm, warns } = await setup({
      platformProfiles: [{ platform: 'onebot', paperName: '', memoryRecallScope: '', paperEnabled: null }],
    });
    expect(sm.getPlatformProfiles().onebot).toEqual({});
    expect(warns).toEqual([]);
    await app.stop();
  });
});

describe('WebUI createSession 不冻结房间专属键', () => {
  it('根会话复制 webui 平台档：不含房间专属键，含 memoryRecallScope', async () => {
    const { app, sm, action } = await setup({ platformProfiles: [{ platform: 'webui', ...FULL_ROOM_PROFILE }] });
    const created = (await action('createSession')({})) as { id: string };
    const config = sm.getSession(created.id)?.config ?? {};
    for (const key of ROOM_ONLY) expect(config, `根会话不应冻结 ${key}`).not.toHaveProperty(key);
    expect(config.memoryRecallScope, '召回范围随建会话复制').toBe('session');
    await app.stop();
  });

  it('子会话复制父会话的生效配置：不含房间专属键，含 memoryRecallScope', async () => {
    const { app, sm, action } = await setup({});
    await sm.ensureSession('webui-parent', { config: { ...FULL_ROOM_PROFILE, memoryRecallScope: 'platform' } });
    const created = (await action('createSession')({ parentId: 'webui-parent' })) as { id: string };
    const config = sm.getSession(created.id)?.config ?? {};
    for (const key of ROOM_ONLY) expect(config, `子会话不应冻结 ${key}`).not.toHaveProperty(key);
    expect(config.memoryRecallScope).toBe('platform');
    await app.stop();
  });
});

describe('getInheritance：服务端推出会话所属平台，回继承值与来源', () => {
  const profiles = {
    defaults: { persona: 'from-defaults' },
    platformProfiles: [
      { platform: 'onebot', paperName: '<群白纸名>', remoteAgentTypes: ['<远端代理实例 id>'] },
      { platform: 'webui', paperName: '<网页白纸名>', memoryRecallScope: 'all' },
    ],
  };

  it('onebot 群会话：平台为 onebot，取值与来源来自 onebot 平台档（传入的平台参数不起作用）', async () => {
    const { app, sm, action } = await setup(profiles);
    const room = 'onebot:bot:group:g1';
    await sm.ensureSession(room, { name: '<试点群显示名>' });

    const got = await action('getInheritance')({ sessionId: room, platform: 'webui' });
    expect(got).toEqual({
      platform: 'onebot',
      values: { persona: 'from-defaults', paperName: '<群白纸名>', remoteAgentTypes: ['<远端代理实例 id>'] },
      sources: { persona: 'defaults', paperName: 'platform', remoteAgentTypes: 'platform' },
    });
    await app.stop();
  });

  it('WebUI 建的会话：平台为 webui', async () => {
    const { app, action } = await setup(profiles);
    const created = (await action('createSession')({})) as { id: string };

    const got = (await action('getInheritance')({ sessionId: created.id })) as Record<string, unknown>;
    expect(got.platform).toBe('webui');
    expect(got.values).toEqual({ persona: 'from-defaults', paperName: '<网页白纸名>', memoryRecallScope: 'all' });
    await app.stop();
  });

  it('会话 metadata 记了平台时以它为准（子任务建档时写入）', async () => {
    const { app, sm, action } = await setup(profiles);
    const child = await sm.createChildSession('parent-x', { metadata: { platform: 'onebot' } });

    const got = (await action('getInheritance')({ sessionId: child.id })) as Record<string, unknown>;
    expect(got.platform).toBe('onebot');
    await app.stop();
  });

  it('父会话 sessionDefaults 覆盖的键来源为 parent', async () => {
    const { app, sm, action } = await setup(profiles);
    const room = 'onebot:bot:group:g2';
    await sm.ensureSession(room, {
      config: { sessionDefaults: { paperName: '<父会话给的名>', memoryRecallScope: 'session' } },
    });
    const child = await sm.createChildSession(room, {});

    const got = (await action('getInheritance')({ sessionId: child.id })) as {
      values: Record<string, unknown>;
      sources: Record<string, unknown>;
    };
    expect(got.values.paperName).toBe('<父会话给的名>');
    expect(got.sources).toEqual({
      persona: 'defaults',
      paperName: 'parent',
      remoteAgentTypes: 'platform',
      memoryRecallScope: 'parent',
    });
    await app.stop();
  });

  it('getInheritedDefaults 已删除', async () => {
    const { app, actions } = await setup(profiles);
    expect(actions.has('getInheritedDefaults')).toBe(false);
    await app.stop();
  });
});
