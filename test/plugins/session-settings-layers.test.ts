import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_LAYERS } from '../../packages/api-session-settings/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { registerFromDoc } from '../fixtures/app.js';
import {
  fieldsPlugin,
  ONEBOT_TYPES,
  OTHER_SCHEMA,
  SCHEMA,
  startSettings,
  traceOf,
} from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 层的解析：全局（插件配置）› 平台档 › 平台类型档 › 场所 › 本会话。子会话一律按根会话取平台、聊天窗口的类型与场所。会话种类不适用时只取全局层；场所层只在适用于场所种类时生效。不在会话表里的会话与按 id 兜底建档的
// 空记录只取全局层与平台档（平台按调用方给的入口平台），不落到默认工作区。严格字段的坏值原样交出，其余坏值按没设、只告警一次；
// 记录与 sessionConfig 形状不对的部分按缺失处理、告警一次。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const WINDOW = 'onebot:group:20001';
const OWNER_PRIVATE = 'onebot:10000:private:30001';
const OWNERS = [{ platform: 'onebot', userId: '30001' }];
const DEFAULT_PLACE = 'workspace:default';
const PROJECT = 'workspace:w1';
const at = { platform: 'onebot' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const A = () => fieldsPlugin('zz-a', SCHEMA);

async function setup(options: Parameters<typeof startSettings>[0] = {}) {
  const started = await startSettings({
    adapters: [
      { platform: 'onebot', sessionTypes: ONEBOT_TYPES },
      { platform: 'zz-im', sessionTypes: [{ name: 'group', multiParty: true }] },
    ],
    owners: OWNERS,
    ...options,
  });
  apps.push(started.app);
  const { inbound } = started;
  /** 一条群消息收录这个群 */
  const group = (sessionId = GROUP, platform = 'onebot') =>
    inbound({ sessionId, platform, sessionType: 'group', groupId: '20001', userId: '30002', selfId: '10000' });
  return { ...started, group };
}

/** 一个场所记录（带会话设置的值）与一条会话记录 */
const placeRecord = (key: string, values: unknown) => ({
  key,
  kind: key.startsWith('workspace:') ? 'workspace' : 'window',
  createdAt: 1,
  updatedAt: 1,
  metadata: { 'session-settings': { values } },
});
const sessionRecord = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  children: [],
  status: 'waiting',
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

describe('层的先后', () => {
  it('全局 › 平台档 › 平台类型档 › 场所 › 本会话，层表里没有类型档', async () => {
    expect(SESSION_LAYERS.map(layer => layer.name)).toEqual(['global', 'platform', 'platformType', 'place', 'session']);
    const a = A();
    const { admin, doc, group } = await setup({
      doc: {
        plugins: { 'zz-a': { persona: '<全局>' } },
        sessionConfig: { platforms: { onebot: { 'zz-a': { persona: '<平台档>' } } } },
      },
      fields: [a.definition],
    });
    await group();
    const persona = () => {
      const { values, sources } = traceOf(admin, 'zz-a', GROUP, at);
      return [values.persona, sources.persona];
    };
    expect(persona()).toEqual(['<平台档>', 'platform']);
    doc.set('sessionConfig', {
      ...doc.get('sessionConfig'),
      platformTypes: { onebot: { group: { 'zz-a': { persona: '<平台类型档>' } } } },
    });
    expect(persona()).toEqual(['<平台类型档>', 'platformType']);
    await admin.update({ layer: { scope: 'place', key: WINDOW } }, { plugin: 'zz-a', key: 'persona', value: '<场所>' });
    expect(persona()).toEqual(['<场所>', 'place']);
    await admin.update({ sessionId: GROUP }, { plugin: 'zz-a', key: 'persona', value: '<本会话>' });
    expect(persona()).toEqual(['<本会话>', 'session']);
    // 逐层恢复继承
    await admin.update({ sessionId: GROUP }, { plugin: 'zz-a', key: 'persona', value: null });
    await admin.update({ layer: { scope: 'place', key: WINDOW } }, { plugin: 'zz-a', key: 'persona', value: null });
    await admin.update(
      { layer: { scope: 'platformType', platform: 'onebot', type: 'group' } },
      { plugin: 'zz-a', key: 'persona', value: null },
    );
    expect(persona()).toEqual(['<平台档>', 'platform']);
  });

  it('平台类型档按根会话记下的平台与类型名取，子会话按根会话取，别的平台的同名类型不算；WebUI 与终端的会话没有这一层；文档里的 types 段不认识，告警一次、不生效', async () => {
    const a = A();
    const { admin, sm, group, warns } = await setup({
      doc: {
        plugins: { 'zz-a': { persona: '<全局>' } },
        sessionConfig: {
          types: { group: { 'zz-a': { persona: '<types 段>' } } },
          platformTypes: { onebot: { group: { 'zz-a': { persona: '<onebot 的群>' } } } },
        } as never,
      },
      fields: [a.definition],
    });
    await group();
    await group('zz-im:group:1', 'zz-im');
    const child = await sm.createSession({ parentId: GROUP });
    const webui = await sm.createSession({}, { createdFrom: 'webui' });
    expect(a.reader().get(GROUP, at).persona).toBe('<onebot 的群>');
    expect(a.reader().get(child.id, { platform: 'webui' }).persona).toBe('<onebot 的群>');
    expect(a.reader().get('zz-im:group:1', { platform: 'zz-im' }).persona).toBe('<全局>');
    expect(traceOf(admin, 'zz-a', webui.id, { platform: 'webui' }).sources.persona).toBe('global');
    expect(warns.filter(w => w.includes('sessionConfig.types'))).toHaveLength(1);
  });
});

describe('适用', () => {
  it('会话种类不适用时只取全局层：只给 owner 会话的项在群里、只给房间的项在 WebUI 会话里', async () => {
    const other = fieldsPlugin('zz-other', OTHER_SCHEMA);
    const a = A();
    const { sm, group } = await setup({
      doc: {
        sessionConfig: {
          platforms: {
            onebot: { 'zz-other': { ownerOnly: '<平台档>' } },
            webui: { 'zz-a': { language: ['<平台档语言>'] } },
          },
        },
      },
      fields: [other.definition, a.definition],
    });
    await group();
    const webui = await sm.createSession({}, { createdFrom: 'webui' });
    expect(other.reader().get(GROUP, at).ownerOnly, '只给 owner 会话的项在群里只取全局层').toBe('<默认>');
    expect(a.reader().get(webui.id, { platform: 'webui' }).language).toEqual(['en']);
  });

  it('场所层按场所种类判：owner 的 IM 私聊在默认工作区，只给房间的项不取那里的值，其余照取', async () => {
    const a = A();
    const { inbound } = await setup({
      places: {
        [DEFAULT_PLACE]: placeRecord(DEFAULT_PLACE, [
          { plugin: 'zz-a', key: 'persona', value: '<工作区人设>' },
          { plugin: 'zz-a', key: 'language', value: ['<工作区语言>'] },
        ]),
      },
      fields: [a.definition],
    });
    await inbound({ sessionId: OWNER_PRIVATE, platform: 'onebot', sessionType: 'private', userId: '30001' });
    const values = a.reader().get(OWNER_PRIVATE, at);
    expect(values.persona).toBe('<工作区人设>');
    expect(values.language).toEqual(['en']);
  });

  it('不在会话表里的会话与按 id 兜底建档的空记录：取全局层与入口平台的平台档，不取默认工作区的值', async () => {
    const a = A();
    const { sm } = await setup({
      doc: { sessionConfig: { platforms: { onebot: { 'zz-a': { persona: '<平台档>' } } } } },
      places: { [DEFAULT_PLACE]: placeRecord(DEFAULT_PLACE, [{ plugin: 'zz-a', key: 'persona', value: '<工作区>' }]) },
      fields: [a.definition],
    });
    expect(a.reader().get('onebot:10000:group:<没有>', at).persona).toBe('<平台档>');
    expect(a.reader().get('zz-not-filed', { platform: 'webui' }).persona).toBe('default');
    await sm.ensureSession('zz-unfiled');
    expect(a.reader().get('zz-unfiled', at).persona).toBe('<平台档>');
    // 空记录上开的子会话同样按空记录算：不按 appliesTo 筛，没有场所层
    const child = await sm.createChildSession('zz-unfiled');
    expect(a.reader().get(child.id, at).persona).toBe('<平台档>');
  });
});

describe('坏值与形状', () => {
  it('严格字段的坏值原样交出、不往下回落；非严格的坏值按没设处理，只告警一次', async () => {
    const a = A();
    const { admin, warns, group } = await setup({
      doc: {
        sessionConfig: {
          platforms: { onebot: { 'zz-a': { iterations: 20, scope: 'session' } } },
          platformTypes: { onebot: { group: { 'zz-a': { iterations: 0 } } } },
        },
      },
      stored: {
        [GROUP]: sessionRecord(GROUP, {
          originPlatform: 'onebot',
          originChat: { type: 'group', multiParty: true, selfId: '10000', targetId: '20001' },
          metadata: { 'session-settings': { values: [{ plugin: 'zz-a', key: 'scope', value: '<坏值>' }] } },
        }),
      },
      fields: [a.definition],
    });
    await group();
    for (let i = 0; i < 3; i++) {
      const { values, sources } = traceOf(admin, 'zz-a', GROUP, at);
      expect([values.scope, sources.scope]).toEqual(['<坏值>', 'session']);
      expect([values.iterations, sources.iterations]).toEqual([20, 'platform']);
    }
    expect(warns.filter(w => w.includes('iterations') && w.includes('平台类型档'))).toHaveLength(1);
  });

  it('记录形状不对的按缺失处理，每条记录告警一次；sessionConfig 里不认识的实例与不是对象的实例值各告警一次', async () => {
    const a = A();
    const { warns } = await setup({
      doc: {
        sessionConfig: {
          platforms: { webui: { 'zz-gone': { persona: '<没装>' }, 'zz-a': '<不是对象>' as never } },
        },
      },
      stored: {
        'zz-bad-values': sessionRecord('zz-bad-values', {
          createdFrom: 'webui',
          metadata: { 'session-settings': { values: '<不是数组>' } },
        }),
        'zz-bad-entries': sessionRecord('zz-bad-entries', {
          createdFrom: 'webui',
          metadata: {
            'session-settings': {
              values: [
                { plugin: 'zz-a', key: 'persona' },
                { plugin: 'zz-a', key: 'iterations', value: null },
                { plugin: 'zz-a', key: 'mode', value: 'on' },
              ],
            },
          },
        }),
      },
      fields: [a.definition],
    });
    for (let i = 0; i < 3; i++) {
      expect(a.reader().get('zz-bad-values', { platform: 'webui' }).persona).toBe('default');
      expect(a.reader().get('zz-bad-entries', { platform: 'webui' })).toMatchObject({
        persona: 'default',
        iterations: 30,
        mode: 'on',
      });
    }
    expect(warns.filter(w => w.includes('zz-bad-values'))).toHaveLength(1);
    expect(warns.filter(w => w.includes('zz-bad-entries'))).toHaveLength(1);
    expect(warns.filter(w => w.includes('zz-gone'))).toHaveLength(1);
    expect(warns.filter(w => w.includes('sessionConfig.platforms.webui') && w.includes('zz-a'))).toHaveLength(1);
  });
});

describe('一个实例写过的各处', () => {
  it('placements 列出全局之外的各处（含子会话）；读取器的 layers() 按层分组，全局在前，不含会话上的', async () => {
    const a = A();
    const { sm, admin, group } = await setup({
      doc: {
        plugins: { 'zz-a': { persona: '<全局>' } },
        sessionConfig: {
          platforms: { onebot: { 'zz-a': { persona: '<平台档>' } } },
          platformTypes: { onebot: { group: { 'zz-a': { mode: 'off' } } } },
        },
      },
      fields: [a.definition],
    });
    await group();
    const child = await sm.createSession({ parentId: GROUP });
    await admin.update(
      { layer: { scope: 'place', key: WINDOW } },
      { plugin: 'zz-a', key: 'roomNote', value: '<备注>' },
    );
    await admin.update({ sessionId: child.id }, { plugin: 'zz-a', key: 'persona', value: '<子会话>' });
    expect(admin.placements('zz-a')).toEqual(
      expect.arrayContaining([
        { key: 'persona', value: '<平台档>', at: { layer: { scope: 'platform', platform: 'onebot' } } },
        { key: 'mode', value: 'off', at: { layer: { scope: 'platformType', platform: 'onebot', type: 'group' } } },
        { key: 'roomNote', value: '<备注>', at: { layer: { scope: 'place', key: WINDOW }, placeKind: 'room' } },
        { key: 'persona', value: '<子会话>', at: { sessionId: child.id } },
      ]),
    );
    expect(admin.placements('zz-a')).toHaveLength(4);
    expect(a.reader().layers()).toEqual([
      { layer: { scope: 'global' }, values: { persona: '<全局>' } },
      { layer: { scope: 'platform', platform: 'onebot' }, values: { persona: '<平台档>' } },
      { layer: { scope: 'platformType', platform: 'onebot', type: 'group' }, values: { mode: 'off' } },
      { layer: { scope: 'place', key: WINDOW }, placeKind: 'room', values: { roomNote: '<备注>' } },
    ]);
  });

  it('同一模块的两个实例互不影响', async () => {
    const a = A();
    const { app, store, admin, sm } = await setup({
      doc: { plugins: { 'zz-a': { persona: '<一>' }, 'zz-a:two': { persona: '<二>' } } },
      fields: [a.definition],
    });
    await registerFromDoc(app, store, a.definition, 'zz-a:two');
    await app.plugins.idle();
    const { id } = await sm.createSession({}, { createdFrom: 'webui' });
    expect(a.reader().get(id).persona).toBe('<一>');
    expect(a.reader('zz-a:two').get(id).persona).toBe('<二>');
    await admin.update({ sessionId: id }, { plugin: 'zz-a:two', key: 'persona', value: '<二的会话>' });
    expect(a.reader().get(id).persona).toBe('<一>');
    expect(a.reader('zz-a:two').get(id).persona).toBe('<二的会话>');
  });

  it('停用的实例不列、值保留，重新启用后恢复', async () => {
    const a = A();
    const { app, admin, sm } = await setup({ fields: [a.definition] });
    const { id } = await sm.createSession({}, { createdFrom: 'webui' });
    await admin.update({ sessionId: id }, { plugin: 'zz-a', key: 'persona', value: '<会话人设>' });
    await app.plugins.disable('zz-a');
    expect(admin.rows({ sessionId: id }).filter(row => row.plugin === 'zz-a')).toEqual([]);
    expect(sm.getSession(id)?.metadata?.['session-settings']).toEqual({
      values: [{ plugin: 'zz-a', key: 'persona', value: '<会话人设>' }],
    });
    await app.plugins.enable('zz-a');
    expect(a.reader().get(id).persona).toBe('<会话人设>');
  });

  it('行的 actual 取声明字段的插件交来的闭包：会话的行按这个会话，层的行不给会话', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA, {
      llm: (sessionId, where) => ({
        value: { provider: 'zz-llm', model: 'm1' },
        label: `<${sessionId ?? '-'}|${where.platform ?? '-'}>`,
      }),
    });
    const { admin, sm } = await setup({ fields: [a.definition] });
    const { id } = await sm.createSession({}, { createdFrom: 'webui' });
    const llmRow = (rows: ReturnType<typeof admin.rows>) => rows.find(r => r.plugin === 'zz-a' && r.key === 'llm');
    expect(llmRow(admin.rows({ sessionId: id, at: { platform: 'webui' } }))?.actual).toEqual({
      value: { provider: 'zz-llm', model: 'm1' },
      label: `<${id}|webui>`,
    });
    expect(llmRow(admin.rows({ layer: { scope: 'global' } }))?.actual?.label).toBe('<-|->');
  });

  it('声明字段的插件交的 actual 与偏好的 fromText 抛错：只这一项受影响（行不带 actual、全局层按没有偏好，建子会话不写它），其余照常，同一个错只告警一次', async () => {
    const broken = () => {
      throw new Error('<插件坏了>');
    };
    const a = fieldsPlugin('zz-a', { ...SCHEMA, llm: { ...SCHEMA.llm, fromText: broken } }, { llm: broken });
    const { admin, host, sm, warns } = await setup({ fields: [a.definition], models: [['zz-llm', 'm1']] });
    host.services.use.prefer('llm', 'zz-llm/m1', { for: 'zz-a' });
    const { id } = await sm.createSession({}, { createdFrom: 'webui' });
    const rows = () => admin.rows({ sessionId: id, at: { platform: 'webui' } }).filter(r => r.plugin === 'zz-a');
    rows();
    const llm = rows().find(r => r.key === 'llm');
    expect(llm).toBeDefined();
    expect(llm).not.toHaveProperty('actual');
    expect(llm?.effective).toBeUndefined();
    expect(rows().find(r => r.key === 'persona')?.effective).toBe('default');
    const values = (admin.childMetadata(id) as { 'session-settings': { values: Array<{ key: string }> } })[
      'session-settings'
    ].values;
    expect(values.map(v => v.key)).toContain('persona');
    expect(values.map(v => v.key)).not.toContain('llm');
    expect(warns.filter(w => w.includes('<插件坏了>'))).toHaveLength(2);
  });
});

describe('可设的层', () => {
  it('全局；平台档是已装适配器的加文档里写过的；平台类型档按平台，是声明的加写过的，声明了显示名的带上它；没有类型档，文档里的 types 段告警一次；场所工作区在前（默认工作区最前）、称呼不带平台；名字不合写法的不列、告警一次', async () => {
    const { admin, warns, inbound } = await setup({
      places: { [PROJECT]: { key: PROJECT, kind: 'workspace', name: '论文', createdAt: 1, updatedAt: 1 } },
      doc: {
        sessionConfig: {
          platforms: { 'zz-doc': {}, 'a:b': {} },
          types: { 'zz-type': {} },
          platformTypes: { onebot: { 'zz-extra': {} } },
        } as never,
      },
    });
    await inbound({
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      groupId: '20001',
      groupName: '读书会',
      userId: '30002',
      selfId: '10000',
    });
    expect(admin.layers()).toEqual([
      { layer: { scope: 'global' } },
      { layer: { scope: 'platform', platform: 'onebot' } },
      { layer: { scope: 'platform', platform: 'zz-doc' } },
      { layer: { scope: 'platform', platform: 'zz-im' } },
      { layer: { scope: 'platformType', platform: 'onebot', type: 'channel' }, label: '频道' },
      { layer: { scope: 'platformType', platform: 'onebot', type: 'group' }, label: '群' },
      { layer: { scope: 'platformType', platform: 'onebot', type: 'private' }, label: '私聊' },
      { layer: { scope: 'platformType', platform: 'onebot', type: 'zz-extra' } },
      { layer: { scope: 'platformType', platform: 'zz-im', type: 'group' } },
      { layer: { scope: 'place', key: DEFAULT_PLACE }, label: expect.anything() },
      { layer: { scope: 'place', key: PROJECT }, label: expect.anything() },
      { layer: { scope: 'place', key: WINDOW }, label: expect.anything(), platform: 'onebot', type: 'group' },
    ]);
    // 场所的称呼不带平台（平台另给，界面在层的列表里补上）：默认工作区写「默认工作区」，取了名的工作区写「工作区「名字」」，
    // 窗口写声明里的类型称呼与窗口名
    expect(
      admin.layers().flatMap(({ layer, label }) => (layer.scope === 'place' ? [toSource(label ?? '')] : [])),
    ).toEqual(['默认工作区', '工作区「论文」', '群「读书会」']);
    admin.layers();
    expect(warns.filter(w => w.includes('a:b'))).toHaveLength(1);
    expect(warns.filter(w => w.includes('sessionConfig.types'))).toHaveLength(1);
  });
});
