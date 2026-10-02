import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AalisConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import {
  isSessionConfigError,
  type SessionSetting,
  sessionManager,
} from '../../packages/api-session-manager/src/index.js';
import { App, events, type Logger, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import {
  ITERATIONS,
  MODEL,
  PAPER_NAME,
  PERSONA,
  ROOM_CENTS,
  settingsPlugin,
  TOOL_GROUPS,
} from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 会话设置项由插件登记：session-manager 只做通用的存储、继承链与校验，不认识任何具体的键。
//
// - 登记过的键才参与解析；插件停用后它的键不显示、不参与解析，值原样保留，重新启用后恢复；
// - 写入按登记的字段校验，没登记的键与不合字段的值拒绝，null 删掉这一项、恢复继承；
// - 同一个键可由几个插件以同一份定义登记；
// - 全局默认、平台档与受众条目存放在宿主配置文档的 sessionConfig 里，按层读写；
// - 登记表与各层的改动发 session:config:changed。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';
const SETTINGS = 'test-settings';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function recordingLogger(warns: string[]): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  return logger;
}

async function setup({
  doc,
  stored = {},
  plugins = [settingsPlugin(SETTINGS, [PERSONA, TOOL_GROUPS, ITERATIONS, PAPER_NAME])],
  save,
}: {
  /** 宿主配置文档；不给时没有 host-config */
  doc?: Partial<AalisConfig>;
  stored?: Record<string, Record<string, unknown>>;
  plugins?: PluginDefinition[];
  save?: (config: AalisConfig) => Promise<void>;
} = {}) {
  const warns: string[] = [];
  const logger = recordingLogger(warns);
  const app = doc
    ? hostedApp(doc, { logger, provider: save ? { save } : undefined }).app
    : new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, sessionManager });
  host.provide(memory, fakeMemory(stored) as never);
  let changes = 0;
  host.events.on('session:config:changed', () => void changes++);
  await app.plugin(sessionManagerPlugin);
  for (const plugin of plugins) await app.plugin(plugin);
  await app.plugins.idle();
  for (const name of [sessionManagerPlugin.name, ...plugins.map(p => p.name)]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  const layers = () => (doc ? app.bind({ hostConfig }).hostConfig.require().get('sessionConfig') : undefined);
  return { app, sm: host.sessionManager.require(), warns, changes: () => changes, layers };
}

describe('设置项登记', () => {
  it('登记过的键参与解析；插件停用后不列出、不参与解析，值原样保留；重新启用后恢复', async () => {
    const { app, sm } = await setup();
    await sm.ensureSession(GROUP, { config: { persona: '<人设>', paperName: '<白纸名>' } });

    expect(sm.listSettings().map(s => [s.key, s.plugin])).toEqual([
      ['persona', SETTINGS],
      ['enabledToolGroups', SETTINGS],
      ['maxToolIterations', SETTINGS],
      ['paperName', SETTINGS],
    ]);
    expect(sm.resolveConfig(GROUP)).toEqual({ persona: '<人设>', paperName: '<白纸名>' });

    await app.plugins.disable(SETTINGS);
    expect(sm.listSettings()).toEqual([]);
    expect(sm.resolveConfig(GROUP)).toEqual({});
    expect(sm.getOwnConfig(GROUP)).toEqual({});
    expect(sm.getSession(GROUP)?.config, '值原样保留').toEqual({ persona: '<人设>', paperName: '<白纸名>' });

    await app.plugins.enable(SETTINGS);
    expect(sm.resolveConfig(GROUP)).toEqual({ persona: '<人设>', paperName: '<白纸名>' });
  });

  it('没登记的键与不合字段的值拒绝写入，什么都不改；null 删掉这一项、恢复继承', async () => {
    const { sm } = await setup();
    const session = await sm.createSession({ config: { persona: '<人设>', maxToolIterations: 3 } });

    const unknown = sm.updateSession(session.id, { config: { persona: '<别的>', bogus: 1 } as never });
    await expect(unknown).rejects.toThrow('bogus');
    await unknown.catch(err => expect(isSessionConfigError(err)).toBe(true));
    const invalid = sm.updateSession(session.id, { config: { maxToolIterations: 0 } });
    await expect(invalid).rejects.toThrow('maxToolIterations');
    await invalid.catch(err => expect(isSessionConfigError(err)).toBe(true));
    expect(sm.getSession(session.id)?.config).toEqual({ persona: '<人设>', maxToolIterations: 3 });

    await sm.updateSession(session.id, { config: { persona: null } });
    expect(sm.getSession(session.id)?.config).toEqual({ maxToolIterations: 3 });

    const count = sm.listSessions().length;
    await expect(sm.createSession({ config: { bogus: true } as never })).rejects.toThrow('bogus');
    expect(sm.listSessions(), '建会话被拒时不留半条记录').toHaveLength(count);
  });

  it('存储里取值不合字段的当作没设置，同一处只告警一次', async () => {
    const stored = {
      [GROUP]: { id: GROUP, name: GROUP, children: [], status: 'waiting', config: { maxToolIterations: 0 } },
    };
    const { sm, warns } = await setup({ stored });

    expect(sm.resolveConfig(GROUP)).toEqual({});
    expect(sm.resolveConfig(GROUP)).toEqual({});
    expect(warns.filter(w => w.includes('maxToolIterations'))).toHaveLength(1);
  });

  it('字段标了 onInvalid: error 的不合法值原样交出、不回落到下面的层，写入照样被拒', async () => {
    const doc = {
      sessionConfig: {
        defaults: { remoteAgentRoomDailyCents: 100 },
        platforms: { onebot: { remoteAgentRoomDailyCents: -1 } },
      },
    };
    const { sm, warns } = await setup({ doc, plugins: [settingsPlugin(SETTINGS, [ROOM_CENTS])] });

    expect(sm.resolveConfig(GROUP)).toEqual({ remoteAgentRoomDailyCents: -1 });
    expect(sm.resolveInheritance(GROUP).sources).toEqual({ remoteAgentRoomDailyCents: 'platform' });
    expect(sm.resolveConfig(GROUP)).toEqual({ remoteAgentRoomDailyCents: -1 });
    expect(warns.filter(w => w.includes('remoteAgentRoomDailyCents'))).toHaveLength(1);
    await expect(sm.ensureSession(GROUP, { config: { remoteAgentRoomDailyCents: -1 } })).rejects.toThrow(
      'remoteAgentRoomDailyCents',
    );
  });

  it('同一个键可由几个插件以同一份内容的定义登记（进程里装了两份契约包时不是同一个对象），最后一个登记者停用后才失效；内容不同的拒绝登记', async () => {
    const { app, sm } = await setup({
      plugins: [settingsPlugin('first', [PERSONA]), settingsPlugin('second', [structuredClone(PERSONA)])],
    });
    await sm.ensureSession(GROUP, { config: { persona: '<人设>' } });
    expect(sm.listSettings().map(s => [s.key, s.plugin])).toEqual([['persona', 'first']]);

    await app.plugins.disable('first');
    expect(sm.listSettings().map(s => [s.key, s.plugin])).toEqual([['persona', 'second']]);
    expect(sm.resolveConfig(GROUP).persona).toBe('<人设>');
    await app.plugins.disable('second');
    expect(sm.resolveConfig(GROUP).persona).toBeUndefined();

    const other: SessionSetting = { ...PERSONA, field: { type: 'textarea', label: '另一份人设' } };
    await app.plugins.enable('first');
    await app.plugin(settingsPlugin('third', [other]));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('third')?.state).toBe('error');
    expect(sm.listSettings().map(s => [s.key, s.plugin])).toEqual([['persona', 'first']]);
  });

  it('外来字段类型的取值先过登记给的 validate：不合的拒绝写入、存储里的当作没设置；没给 validate 的登记被拒', async () => {
    const stored = {
      [GROUP]: { id: GROUP, name: GROUP, children: [], status: 'waiting', config: { llm: 'x' } },
    };
    const { app, sm, warns } = await setup({ stored, plugins: [settingsPlugin(SETTINGS, [MODEL])] });
    expect(sm.resolveConfig(GROUP)).toEqual({});
    expect(warns.filter(w => w.includes('llm'))).toHaveLength(1);

    const model = { provider: '<服务>', model: '<模型>' };
    const session = await sm.createSession({ config: { llm: model } });
    for (const llm of ['x', { provider: 1, model: {} }, { provider: '<服务>' }, [1, 2]]) {
      const write = sm.updateSession(session.id, { config: { llm } as never });
      await expect(write, JSON.stringify(llm)).rejects.toThrow('llm');
      await write.catch(err => expect(isSessionConfigError(err)).toBe(true));
    }
    expect(sm.getSession(session.id)?.config).toEqual({ llm: model });

    const { validate: _, ...unchecked } = MODEL;
    await app.plugin(settingsPlugin('unchecked', [{ ...unchecked, key: 'otherModel' as never }]));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('unchecked')?.state).toBe('error');
    expect(sm.listSettings().map(s => s.key)).toEqual(['llm']);
  });

  it('建子会话复制的配置不带 liveOnly 的项', async () => {
    const { sm } = await setup();
    await sm.ensureSession(GROUP, { config: { persona: '<人设>', paperName: '<白纸名>' } });
    expect(sm.childConfig(GROUP)).toEqual({ persona: '<人设>' });
  });

  it('登记、撤回、改会话的覆盖与改某一层都发 session:config:changed', async () => {
    const { app, sm, changes } = await setup({ doc: {} });
    const registered = changes();
    expect(registered, '四项登记各一次').toBe(4);

    await app.plugins.disable(SETTINGS);
    expect(changes() - registered, '四项撤回各一次').toBe(4);
    await app.plugins.enable(SETTINGS);

    const before = changes();
    const session = await sm.createSession({});
    await sm.updateSession(session.id, { name: '<改名>' });
    expect(changes(), '不改配置不发').toBe(before);
    await sm.updateSession(session.id, { config: { persona: '<人设>' } });
    expect(changes()).toBe(before + 1);
    await sm.updateLayer({ scope: 'defaults' }, { persona: '<默认人设>' });
    expect(changes()).toBe(before + 2);
  });
});

describe('各层：全局默认、平台档与受众条目', () => {
  const DOC: Partial<AalisConfig> = {
    sessionConfig: {
      defaults: { persona: '<默认人设>' },
      platforms: { onebot: { enabledToolGroups: ['search'] }, webui: { enabledToolGroups: ['*'] } },
      audiences: { onebot: { private: { enabledToolGroups: ['search', 'scheduler'], paperName: '<私聊白纸>' } } },
    },
  };

  it('取自宿主配置文档的 sessionConfig：房间按出生平台与受众叠加，owner 的会话按入口平台，来源逐键记下', async () => {
    const { sm } = await setup({ doc: DOC });

    expect(sm.resolveInheritance(PRIVATE, 'webui')).toEqual({
      platform: 'onebot',
      audience: 'private',
      values: { persona: '<默认人设>', enabledToolGroups: ['search', 'scheduler'], paperName: '<私聊白纸>' },
      sources: { persona: 'defaults', enabledToolGroups: 'audience', paperName: 'audience' },
    });
    expect(sm.resolveConfig(GROUP, 'webui')).toEqual({ persona: '<默认人设>', enabledToolGroups: ['search'] });
    const mine = await sm.createSession({});
    expect(sm.resolveInheritance(mine.id, 'webui').sources).toEqual({
      persona: 'defaults',
      enabledToolGroups: 'platform',
    });
  });

  it('按层读：listLayers 列出有值的层，getLayer 是这一层自己的值，resolveLayer 解析到这一层为止', async () => {
    const { sm } = await setup({ doc: DOC });
    const priv = { scope: 'audience', platform: 'onebot', audience: 'private' } as const;

    expect(sm.listLayers()).toEqual([
      { scope: 'defaults' },
      { scope: 'platform', platform: 'onebot' },
      { scope: 'platform', platform: 'webui' },
      priv,
    ]);
    expect(sm.getLayer(priv)).toEqual({ enabledToolGroups: ['search', 'scheduler'], paperName: '<私聊白纸>' });
    expect(sm.resolveLayer(priv)).toEqual({
      values: { persona: '<默认人设>', enabledToolGroups: ['search', 'scheduler'], paperName: '<私聊白纸>' },
      sources: { persona: 'defaults', enabledToolGroups: 'audience', paperName: 'audience' },
    });
    expect(sm.resolveLayer({ scope: 'platform', platform: 'cli' })).toEqual({
      values: { persona: '<默认人设>' },
      sources: { persona: 'defaults' },
    });
  });

  it('按层写：校验后写进文档并保存，null 删掉这一项；没启用的插件写在这一层的键不受影响', async () => {
    const save = vi.fn(async () => {});
    const doc = { sessionConfig: { platforms: { onebot: { remoteAgentTypes: ['<没启用的插件的值>'] } } } };
    const { sm, layers } = await setup({ doc, save });
    const onebot = { scope: 'platform', platform: 'onebot' } as const;

    await sm.updateLayer(onebot, { persona: '<群人设>', enabledToolGroups: ['search'] });
    expect(layers()).toEqual({
      platforms: {
        onebot: { remoteAgentTypes: ['<没启用的插件的值>'], persona: '<群人设>', enabledToolGroups: ['search'] },
      },
    });
    expect(save).toHaveBeenCalledTimes(1);

    await sm.updateLayer(onebot, { persona: null });
    await sm.updateLayer({ scope: 'audience', platform: 'onebot', audience: 'group' }, { paperName: '<群白纸>' });
    expect(layers()).toEqual({
      platforms: { onebot: { remoteAgentTypes: ['<没启用的插件的值>'], enabledToolGroups: ['search'] } },
      audiences: { onebot: { group: { paperName: '<群白纸>' } } },
    });
    expect(sm.resolveConfig(GROUP)).toEqual({ enabledToolGroups: ['search'], paperName: '<群白纸>' });
  });

  it('按层写被拒时文档不变：没登记的键、不合字段的值、不合法的层', async () => {
    const save = vi.fn(async () => {});
    const { sm, layers } = await setup({ doc: DOC, save });
    const original = structuredClone(layers());

    for (const [layer, patch] of [
      [{ scope: 'defaults' }, { bogus: 1 }],
      [{ scope: 'defaults' }, { maxToolIterations: 1.5 }],
      [{ scope: 'platform', platform: '' }, { persona: '<人设>' }],
      [{ scope: 'platform', platform: '__proto__' }, { persona: '<人设>' }],
      [{ scope: 'audience', platform: 'onebot', audience: 'owner' }, { persona: '<人设>' }],
    ] as const) {
      const write = sm.updateLayer(layer as never, patch as never);
      await expect(write, JSON.stringify(layer)).rejects.toThrow();
      await write.catch(err => expect(isSessionConfigError(err)).toBe(true));
    }
    expect(layers()).toEqual(original);
    expect(save).not.toHaveBeenCalled();
  });

  it('保存失败以拒绝传出：文档撤回原值，不发 session:config:changed', async () => {
    const { sm, layers, changes } = await setup({
      doc: { sessionConfig: { defaults: { persona: '<默认人设>' } } },
      save: async () => Promise.reject(new Error('ENOSPC: 磁盘已满')),
    });
    const before = changes();
    await expect(sm.updateLayer({ scope: 'defaults' }, { persona: '<人设>' })).rejects.toThrow('ENOSPC');
    expect(layers()).toEqual({ defaults: { persona: '<默认人设>' } });
    expect(sm.getLayer({ scope: 'defaults' })).toEqual({ persona: '<默认人设>' });
    expect(changes()).toBe(before);
  });

  it('文档里形状不对的部分与不认识的键告警一次后忽略，其余照常生效', async () => {
    const { sm, warns } = await setup({
      doc: {
        sessionConfig: {
          defaults: { persona: '<默认人设>' },
          platforms: { onebot: 'search' },
          audiences: 7,
          platfroms: { onebot: { persona: '<拼错的层>' } },
        } as never,
      },
    });
    expect(sm.resolveConfig(GROUP)).toEqual({ persona: '<默认人设>' });
    expect(sm.resolveConfig(PRIVATE)).toEqual({ persona: '<默认人设>' });
    expect(warns.filter(w => w.includes('sessionConfig'))).toHaveLength(3);
    expect(warns.filter(w => w.includes('sessionConfig.platfroms'))).toHaveLength(1);
  });

  it('旧数据里父会话给子会话的 sessionDefaults 照常生效，来源为 parent；它不是设置项，写不进去', async () => {
    const sessionDefaults = { persona: '<父会话给的人设>', paperName: '<父会话给的白纸>' };
    const stored = {
      [GROUP]: { id: GROUP, name: GROUP, children: [], status: 'waiting', config: { sessionDefaults } },
    };
    const { sm } = await setup({ doc: { sessionConfig: { defaults: { persona: '<默认人设>' } } }, stored });
    const child = await sm.createChildSession(GROUP, {});

    expect(sm.resolveInheritance(child.id)).toMatchObject({
      values: sessionDefaults,
      sources: { persona: 'parent', paperName: 'parent' },
    });
    await expect(sm.updateSession(GROUP, { config: { sessionDefaults } as never })).rejects.toThrow('sessionDefaults');
  });

  it('宿主没有提供配置文档：各层为空，按层写被拒', async () => {
    const { sm } = await setup();
    expect(sm.listLayers()).toEqual([{ scope: 'defaults' }]);
    expect(sm.resolveConfig(GROUP)).toEqual({});
    await expect(sm.updateLayer({ scope: 'defaults' }, { persona: '<人设>' })).rejects.toThrow('host-config');
  });
});
