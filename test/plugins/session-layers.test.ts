import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import {
  isSessionConfigError,
  SESSION_LAYERS,
  type SessionConfigLayer,
} from '../../packages/api-session-manager/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { layersWith } from '../../packages/plugin-paper/src/rooms.js';
import {
  ITERATIONS,
  ONEBOT_TYPES,
  PERSONA,
  startSessionManager,
  THINK,
  TOOL_GROUPS,
} from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 会话设置的层由一张层表定义：全局默认 → 平台档 → 平台类型档 → 场所 → 父会话 → 本会话，后面的压过前面的。
// 继承链、来源、可设的层与按层读写都照它走。前三层在宿主配置的 sessionConfig（defaults、platforms、types），场所层是
// 会话管理存在记忆后端里的场所记录；平台档按出生平台（没有的按入口平台），平台类型档按聊天窗口的类型名，场所按 placeOf，
// 子会话一律按根会话取。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const WINDOW = 'onebot:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(
  layers?: AalisConfig['sessionConfig'],
  options: Partial<Parameters<typeof startSessionManager>[0]> = {},
) {
  const started = await startSessionManager({
    layers,
    settings: [PERSONA, TOOL_GROUPS, ITERATIONS, THINK],
    adapters: [{ platform: 'onebot', sessionTypes: ONEBOT_TYPES }],
    ...options,
  });
  apps.push(started.app);
  return started;
}

describe('层表', () => {
  it('六层按先后列出，名字与称呼都在表里', () => {
    expect(SESSION_LAYERS.map(layer => layer.name)).toEqual([
      'defaults',
      'platform',
      'type',
      'place',
      'parent',
      'session',
    ]);
    for (const layer of SESSION_LAYERS) expect(layer.label, layer.name).not.toBe('');
  });

  it('继承链与来源按表的先后：同一项写在几层时取最后的一层，本会话压过全部', async () => {
    const { sm, inbound } = await setup({
      defaults: { persona: '<默认>', enabledToolGroups: ['a'], maxToolIterations: 1, think: 'off' },
      platforms: { onebot: { persona: '<平台>', enabledToolGroups: ['b'], maxToolIterations: 2 } },
      types: { onebot: { group: { persona: '<类型>', enabledToolGroups: ['c'] } } },
    });
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    await sm.updateLayer({ scope: 'place', key: WINDOW }, { persona: '<场所>' });

    const inheritance = sm.resolveInheritance(GROUP, 'webui');
    expect(inheritance).toMatchObject({
      platform: 'onebot',
      type: 'group',
      values: { persona: '<场所>', enabledToolGroups: ['c'], maxToolIterations: 2, think: 'off' },
      sources: { persona: 'place', enabledToolGroups: 'type', maxToolIterations: 'platform', think: 'defaults' },
    });
    await sm.updateSession(GROUP, { config: { persona: '<本会话>' } });
    expect(sm.resolveConfig(GROUP).persona).toBe('<本会话>');
  });

  it('父会话给子会话的默认值（旧数据）压过场所；子会话按根会话的平台、类型与场所取', async () => {
    const record = { children: [], status: 'waiting', createdAt: 1, updatedAt: 1 };
    const CHILD = `${GROUP}::a`;
    const GRANDCHILD = `${GROUP}::a::b`;
    const { sm } = await setup(
      { types: { onebot: { group: { enabledToolGroups: ['c'] } } } },
      {
        stored: {
          [GROUP]: {
            ...record,
            id: GROUP,
            name: '<群名>',
            config: {},
            children: [CHILD],
            originPlatform: 'onebot',
            originChat: { type: 'group', multiParty: true, targetId: '20001' },
          },
          [CHILD]: {
            ...record,
            id: CHILD,
            name: '<子任务>',
            parentId: GROUP,
            children: [GRANDCHILD],
            config: { sessionDefaults: { think: 'off' } },
          },
          [GRANDCHILD]: { ...record, id: GRANDCHILD, name: '<孙任务>', parentId: CHILD, config: {} },
        },
        places: {
          [WINDOW]: {
            key: WINDOW,
            kind: 'window',
            name: '<群名>',
            config: { persona: '<场所>', think: 'high' },
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
    );

    expect(sm.resolveInheritance(GRANDCHILD, 'webui')).toMatchObject({
      platform: 'onebot',
      type: 'group',
      values: { persona: '<场所>', think: 'off', enabledToolGroups: ['c'] },
      sources: { persona: 'place', think: 'parent', enabledToolGroups: 'type' },
    });
  });

  it('没有聊天窗口的会话没有平台类型档，平台档按入口平台；会话表里没有的 id 不从 id 推出生平台', async () => {
    const { sm } = await setup({
      platforms: { webui: { persona: '<webui>' }, onebot: { persona: '<onebot>' } },
      types: { webui: { private: { enabledToolGroups: ['x'] } }, onebot: { group: { enabledToolGroups: ['y'] } } },
    });
    const mine = await sm.createSession({}, { createdFrom: 'webui' });

    expect(sm.resolveInheritance(mine.id, 'webui')).toMatchObject({
      platform: 'webui',
      values: { persona: '<webui>' },
    });
    expect(sm.resolveInheritance(mine.id, 'webui').type).toBeUndefined();
    expect(sm.resolveInheritance(GROUP, 'webui')).toMatchObject({ platform: 'webui', values: { persona: '<webui>' } });
  });

  it('owner 的 IM 私聊：平台档、平台类型档照常取，场所是默认工作区', async () => {
    const { sm, inbound } = await setup(
      { types: { onebot: { private: { enabledToolGroups: ['p'] } } } },
      { owners: [{ platform: 'onebot', userId: '30001' }] },
    );
    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', userId: '30001' });
    await sm.updateLayer({ scope: 'place', key: 'workspace:default' }, { persona: '<默认工作区>' });

    expect(sm.resolveInheritance(PRIVATE, 'onebot')).toMatchObject({
      platform: 'onebot',
      type: 'private',
      values: { enabledToolGroups: ['p'], persona: '<默认工作区>' },
      sources: { enabledToolGroups: 'type', persona: 'place' },
    });
  });
});

describe('宿主配置里的三层', () => {
  it('types 里写了适配器没声明的类型名照样能读写、能清掉', async () => {
    const save = vi.fn(async () => {});
    const { sm, host } = await setup({ types: { onebot: { thread: { persona: '<帖子>' } } } }, { save });
    const thread = { scope: 'type', platform: 'onebot', type: 'thread' } as const;

    expect(sm.listLayers()).toContainEqual(thread);
    expect(sm.getLayer(thread)).toEqual({ persona: '<帖子>' });
    await sm.updateLayer({ scope: 'type', platform: 'forum', type: 'dm' }, { think: 'high' });
    expect(host.hostConfig.use.get('sessionConfig')).toEqual({
      types: { onebot: { thread: { persona: '<帖子>' } }, forum: { dm: { think: 'high' } } },
    });

    await sm.updateLayer(thread, { persona: null });
    expect(sm.listLayers()).not.toContainEqual(thread);
    expect(host.hostConfig.use.get('sessionConfig')).toEqual({ types: { forum: { dm: { think: 'high' } } } });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('audiences 段不再认：按不认识的段告警一次后忽略，按层写时从文档删掉', async () => {
    const save = vi.fn(async () => {});
    const { sm, host, inbound, warns } = await setup(
      { audiences: { onebot: { group: { persona: '<旧受众条目>' } } } } as never,
      { save },
    );
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });

    expect(sm.resolveConfig(GROUP)).toEqual({});
    expect(sm.resolveConfig(GROUP)).toEqual({});
    expect(warns.filter(w => w.includes('sessionConfig.audiences'))).toHaveLength(1);
    await sm.updateLayer({ scope: 'defaults' }, { persona: '<默认>' });
    expect(host.hostConfig.use.get('sessionConfig')).toEqual({ defaults: { persona: '<默认>' } });
  });

  it('平台名、类型名不合层标识写法的（空串、*、带冒号）告警后忽略：不列出、读得到的层都能读，按层写时从文档删掉；适配器给的同样不列', async () => {
    const save = vi.fn(async () => {});
    const { sm, host, warns } = await setup(
      {
        platforms: { '*': { persona: '<通配>' }, '': { persona: '<空>' }, onebot: { think: 'off' } },
        types: { onebot: { 'a:b': { persona: '<带冒号>' } }, '*': { group: { persona: '<通配>' } } },
      },
      {
        save,
        adapters: [
          { platform: 'onebot', sessionTypes: [...ONEBOT_TYPES, { name: 'x:y', multiParty: true }] },
          { platform: '*', sessionTypes: [{ name: 'group', multiParty: true }] },
        ],
      },
    );

    const layers = sm.listLayers();
    expect(layers.filter(layer => layer.scope === 'platform' || layer.scope === 'type')).toEqual([
      { scope: 'platform', platform: 'onebot' },
      { scope: 'type', platform: 'onebot', type: 'channel' },
      { scope: 'type', platform: 'onebot', type: 'group' },
      { scope: 'type', platform: 'onebot', type: 'private' },
    ]);
    for (const layer of layers) expect(() => sm.getLayer(layer), JSON.stringify(layer)).not.toThrow();
    expect(() => layersWith(sm, 'paperName')).not.toThrow();
    expect(warns.filter(w => w.includes('sessionConfig.platforms'))).toHaveLength(2);
    expect(warns.filter(w => w.includes('sessionConfig.types'))).toHaveLength(2);

    await sm.updateLayer({ scope: 'platform', platform: 'onebot' }, { persona: '<平台>' });
    expect(host.hostConfig.use.get('sessionConfig')).toEqual({
      platforms: { onebot: { think: 'off', persona: '<平台>' } },
    });
  });

  it('取值无效的告警按层表的称呼点名这一层', async () => {
    const { sm, inbound, warns } = await setup({ types: { onebot: { group: { think: 'max' } } } });
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });

    expect(sm.resolveConfig(GROUP).think).toBeUndefined();
    expect(warns.filter(w => w.includes('设置项 think（平台类型档 onebot · group）取值无效'))).toHaveLength(1);
  });

  it('types 里形状不对的部分告警后忽略', async () => {
    const { sm, inbound, warns } = await setup({
      types: { onebot: { group: 'x', private: { persona: '<私聊>' } }, forum: 3 },
    } as never);
    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', userId: '30002' });

    expect(sm.resolveConfig(PRIVATE).persona).toBe('<私聊>');
    expect(warns.filter(w => w.includes('sessionConfig.types'))).toHaveLength(2);
  });
});

describe('层标识的校验', () => {
  it('平台名与类型名非空、不含冒号、不是 *、不是原型链上的名字；场所键必须是已有的场所记录；不认识的层被拒', async () => {
    const save = vi.fn(async () => {});
    const { sm } = await setup({}, { save });
    const bad: SessionConfigLayer[] = [
      { scope: 'platform', platform: '' },
      { scope: 'platform', platform: 'a:b' },
      { scope: 'platform', platform: '*' },
      { scope: 'platform', platform: '__proto__' },
      { scope: 'type', platform: 'onebot', type: '' },
      { scope: 'type', platform: 'onebot', type: 'a:b' },
      { scope: 'type', platform: 'onebot', type: '*' },
      { scope: 'type', platform: 'onebot', type: 'constructor' },
      { scope: 'type', platform: '*', type: 'group' },
      { scope: 'place', key: 'onebot:group:<没有记录>' },
      { scope: 'audience', platform: 'onebot', audience: 'group' } as never,
    ];
    for (const layer of bad) {
      const write = sm.updateLayer(layer, { persona: '<人设>' });
      await expect(write, JSON.stringify(layer)).rejects.toThrow();
      await write.catch(err => expect(isSessionConfigError(err), JSON.stringify(layer)).toBe(true));
      expect(() => sm.getLayer(layer), JSON.stringify(layer)).toThrow();
      expect(() => sm.resolveLayer(layer), JSON.stringify(layer)).toThrow();
    }
    expect(save).not.toHaveBeenCalled();
  });
});

describe('可设的层', () => {
  it('按层表的先后：全局默认、各平台档、各平台类型档、各场所；平台是已装适配器的加配置里写过的，类型是声明的加配置里写过的', async () => {
    const { sm, inbound } = await setup(
      {
        platforms: { webui: { persona: '<webui>' } },
        types: { bare: { private: { persona: '<写过的>' } } },
      },
      {
        adapters: [
          { platform: 'onebot', sessionTypes: ONEBOT_TYPES },
          { platform: 'forum', sessionTypes: [{ name: 'thread', multiParty: true }] },
          { platform: 'terminal', sessionTypes: [] },
          { platform: 'bare' },
        ],
      },
    );
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    const added = sm.addWorkspace('/zz-slice2-layers/proj');

    expect(sm.listLayers()).toEqual([
      { scope: 'defaults' },
      { scope: 'platform', platform: 'bare' },
      { scope: 'platform', platform: 'forum' },
      { scope: 'platform', platform: 'onebot' },
      { scope: 'platform', platform: 'terminal' },
      { scope: 'platform', platform: 'webui' },
      { scope: 'type', platform: 'bare', type: 'private' },
      { scope: 'type', platform: 'forum', type: 'thread' },
      { scope: 'type', platform: 'onebot', type: 'channel' },
      { scope: 'type', platform: 'onebot', type: 'group' },
      { scope: 'type', platform: 'onebot', type: 'private' },
      { scope: 'place', key: 'workspace:default' },
      { scope: 'place', key: WINDOW },
      { scope: 'place', key: `workspace:${added.workspace.id}` },
    ]);
  });
});

describe('按层读写', () => {
  it('resolveLayer 解析到这一层为止：窗口场所在它的平台档与平台类型档之上，工作区场所只在全局默认之上', async () => {
    const { sm, inbound } = await setup({
      defaults: { think: 'off' },
      platforms: { onebot: { persona: '<平台>' }, webui: { persona: '<webui>' } },
      types: { onebot: { group: { enabledToolGroups: ['c'] } } },
    });
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    await sm.updateLayer({ scope: 'place', key: WINDOW }, { maxToolIterations: 4 });
    await sm.updateLayer({ scope: 'place', key: 'workspace:default' }, { maxToolIterations: 5 });

    expect(sm.getLayer({ scope: 'place', key: WINDOW })).toEqual({ maxToolIterations: 4 });
    expect(sm.resolveLayer({ scope: 'place', key: WINDOW })).toEqual({
      values: { think: 'off', persona: '<平台>', enabledToolGroups: ['c'], maxToolIterations: 4 },
      sources: { think: 'defaults', persona: 'platform', enabledToolGroups: 'type', maxToolIterations: 'place' },
    });
    expect(sm.resolveLayer({ scope: 'place', key: 'workspace:default' })).toEqual({
      values: { think: 'off', maxToolIterations: 5 },
      sources: { think: 'defaults', maxToolIterations: 'place' },
    });
    expect(sm.resolveLayer({ scope: 'type', platform: 'onebot', type: 'group' })).toEqual({
      values: { think: 'off', persona: '<平台>', enabledToolGroups: ['c'] },
      sources: { think: 'defaults', persona: 'platform', enabledToolGroups: 'type' },
    });
  });

  it('场所层写进会话管理的场所记录，不进宿主配置；随记录落盘，重启后仍在；改了发 session:config:changed', async () => {
    const save = vi.fn(async () => {});
    const first = await setup({}, { save });
    await first.inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    let changes = 0;
    first.host.events.use.on('session:config:changed', () => void changes++);

    await first.sm.updateLayer({ scope: 'place', key: WINDOW }, { persona: '<场所>' });
    expect(changes).toBe(1);
    expect(save).not.toHaveBeenCalled();
    expect(first.host.hostConfig.use.get('sessionConfig')).toEqual({});
    const unknown = first.sm.updateLayer({ scope: 'place', key: WINDOW }, { bogus: 1 } as never);
    await expect(unknown).rejects.toThrow('bogus');
    await first.app.stop();

    const second = await setup(
      {},
      { stored: Object.fromEntries(first.mem.meta), places: Object.fromEntries(first.mem.places) },
    );
    expect(second.sm.getLayer({ scope: 'place', key: WINDOW })).toEqual({ persona: '<场所>' });
    expect(second.sm.resolveConfig(GROUP).persona).toBe('<场所>');
  });
});
