import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { type GraphData, type TableRow, webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, logger, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import relationPlugin, { RelationService, RelationStore } from '../../packages/plugin-user-relation/src/index.js';
import { registerRelationPages } from '../../packages/plugin-user-relation/src/webui.js';
import { localize, resolveText, toSource } from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 关系图页与原始数据页：经 webui-server 的真实登记表登记（质量门槛）、取数与调动作（闸门）。
// 关系图给节点与边、按类别取色、疏密取插件配置；选中节点看属性与连着它的关系。原始数据三张表，删除连同相关的边，
// 删除扑空回错误，删除后两页都重取。种类、关系名、实体类型与事件类别显示字典里的名字（值照旧），按读者的语言。memory 用内存实现。
// ════════════════════════════════════════════════════════════

/** 按英文渲染页面数据或回包里的文字对象 */
const english = <T>(value: T) => localize(value, text => resolveText(text, ['en']));

const running: Array<{ app: App; pages: PageHost }> = [];
afterEach(async () => {
  for (const { app, pages } of running.splice(0)) {
    await app.stop();
    pages.dispose();
  }
});

async function boot() {
  const app = new App({ name: 'T', logLevel: 'error' });
  const pages = pageHost();
  running.push({ app, pages });
  app.bind({ provide }).provide.use(webuiServer, pages.service);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const mem = app.bind({ memory }).memory.use;
  const service = new RelationService(new RelationStore(mem));
  await app.plugin(
    definePlugin({
      name: 'zz-relation-pages',
      uses: { webui: webuiServer, logger },
      apply: ({ webui, logger }) => registerRelationPages(webui.use, service, logger.use, 90),
    }),
  );
  await app.plugins.idle();
  const alice = await service.observePerson('onebot', 'u1', 'Alice');
  const event = await service.createEvent({
    title: '周末爬山',
    category: 'collaboration',
    summary: '一起去爬山',
    evidence: [{ sessionId: 's1', messageIds: ['m1'], quote: '周末去爬山吗', extractedAt: 1 }],
  });
  const edge = await service.addPersonEventEdge({
    fromPersonId: alice.id,
    toEventId: event.id,
    role: 'initiator',
    evidence: [{ sessionId: 's1', messageIds: ['m1'], quote: '我来组织', extractedAt: 2 }],
  });
  return { pages, service, alice, event, edge };
}

describe('关系图页', () => {
  it('两页都过登记门槛；关系图按类别取色、疏密取插件配置', async () => {
    const { pages } = await boot();
    expect(pages.logs).toEqual([]);
    expect(pages.pages().map(page => [page.key, toSource(page.title)])).toEqual([
      ['user-relation', '人物关系图'],
      ['user-relation-raw', '关系图原始数据'],
    ]);
    const [graph] = pages.view('user-relation').content as Array<Record<string, unknown>>;
    expect(graph).toMatchObject({ type: 'graph', spacing: 90 });
    expect(toSource(graph.nodeKinds)).toEqual([
      { kind: 'person', label: '人物', tone: 1 },
      { kind: 'event', label: '事件', tone: 2 },
      { kind: 'entity', label: '实体', tone: 3 },
    ]);
  });

  it('全图：节点带类别，边带关系名（按读者的语言）与类别', async () => {
    const { pages, alice, event } = await boot();
    const graph = await pages.data<GraphData>('user-relation', 'graph');
    expect(toSource(graph)).toEqual({
      nodes: [
        { id: alice.id, label: 'Alice', kind: 'person' },
        { id: event.id, label: '周末爬山', kind: 'event' },
      ],
      edges: [{ source: alice.id, target: event.id, label: '发起者', kind: 'person-event' }],
    });
    expect(english(graph.edges[0].label)).toBe('Initiator');
  });

  it('词表之外的关系词原样显示，恰好是 Object 原型上的名字（constructor）也一样', async () => {
    const { pages, service, alice } = await boot();
    const bob = await service.observePerson('onebot', 'u2', 'Bob');
    await service.addPersonPersonEdge({ fromPersonId: alice.id, toPersonId: bob.id, relationType: 'constructor' });
    const graph = await pages.data<GraphData>('user-relation', 'graph');
    expect(graph.edges.find(edge => edge.target === bob.id)?.label).toBe('constructor');
  });

  it('选中节点：详情给属性与连着它的关系；不在图里的节点回错误', async () => {
    const { pages, alice, event, edge } = await boot();
    const node = await pages.data('user-relation', 'node', { rowKey: event.id });
    expect(toSource(node)).toEqual([
      { label: '种类', value: '事件' },
      { label: '标题', value: '周末爬山' },
      { label: '类别', value: '合作' },
      { label: '会话', value: 's1' },
      { label: '摘要', value: '一起去爬山', kind: 'long-text' },
      { label: '证据数', value: 1 },
      { label: '最近强化', value: expect.any(Number), kind: 'time' },
    ]);
    expect(english(node)).toEqual(
      expect.arrayContaining([
        { label: 'Kind', value: 'Event' },
        { label: 'Category', value: 'Collaboration' },
      ]),
    );
    expect(toSource(await pages.data('user-relation', 'relations', { rowKey: alice.id }))).toEqual([
      {
        id: edge.id,
        other: '周末爬山',
        relation: '发起者',
        weight: expect.any(Number),
        lastReinforcedAt: expect.any(Number),
        evidence: '我来组织',
      },
    ]);
    await expect(pages.data('user-relation', 'node', { rowKey: 'zz-none' })).rejects.toThrow('关系图里没有节点');
  });
});

describe('关系图原始数据页', () => {
  it('人物、事件、实体三张表；事件类别、实体类型与别名按读者的语言', async () => {
    const { pages, service, alice, event } = await boot();
    const entity = await service.createEntity({
      name: '三角洲',
      entityKind: 'work',
      aliases: ['三角洲行动', '三角'],
      evidence: [],
    });
    expect(await pages.data('user-relation-raw', 'persons')).toMatchObject([
      { id: alice.id, displayName: 'Alice', platform: 'onebot', userId: 'u1' },
    ]);
    const events = await pages.data<TableRow[]>('user-relation-raw', 'events');
    expect(toSource(events)).toMatchObject([
      { id: event.id, title: '周末爬山', category: '合作', evidence: '周末去爬山吗', evidenceCount: 1 },
    ]);
    const entities = await pages.data<TableRow[]>('user-relation-raw', 'entities');
    expect(toSource(entities)).toMatchObject([
      { id: entity.id, name: '三角洲', entityKind: '作品', aliases: '三角洲行动、三角', evidenceCount: 0 },
    ]);
    expect(english([events[0].category, entities[0].entityKind, entities[0].aliases])).toEqual([
      'Collaboration',
      'Work',
      '三角洲行动, 三角',
    ]);
  });

  it('落盘的实体类型不在表里（第一方之外写进的值）：类型单元格显示原值', async () => {
    const { pages, service } = await boot();
    const entity = await service.createEntity({ name: '外来实体', entityKind: 'zz-kind' as never, evidence: [] });
    expect(await pages.data('user-relation-raw', 'entities')).toMatchObject([
      { id: entity.id, name: '外来实体', entityKind: 'zz-kind' },
    ]);
  });

  it('删除：连同相关的边，两页都重取；种类不对或已不在的回错误', async () => {
    const { pages, service, alice, event } = await boot();
    const wrongKind = await pages.act('user-relation-raw', 'deletePerson', { rowKey: event.id });
    expect(toSource(wrongKind)).toEqual({ status: 500, body: { error: '没有这个人物' } });
    const before = pages.invalidations.length;
    const deleted = await pages.act('user-relation-raw', 'deleteEvent', { rowKey: event.id });
    expect(toSource(deleted)).toEqual({ status: 200, body: { message: '已删除 周末爬山 及其相关的边' } });
    expect(pages.invalidations.slice(before)).toEqual(
      expect.arrayContaining([
        { instance: 'zz-relation-pages', pageKey: 'user-relation' },
        { instance: 'zz-relation-pages', pageKey: 'user-relation-raw' },
      ]),
    );
    expect((await service.loadAll()).edges).toEqual([]);
    const gone = await pages.act('user-relation-raw', 'deleteEvent', { rowKey: event.id });
    expect(toSource(gone)).toEqual({ status: 500, body: { error: '没有这个事件' } });
    expect(toSource(await pages.act('user-relation-raw', 'deletePerson', { rowKey: alice.id }))).toEqual({
      status: 200,
      body: { message: '已删除 Alice 及其相关的边' },
    });
    expect(english([wrongKind.body, deleted.body, gone.body])).toEqual([
      { error: 'No such person' },
      { message: 'Deleted 周末爬山 and its related edges' },
      { error: 'No such event' },
    ]);
    expect(await pages.data('user-relation', 'graph')).toEqual({ nodes: [], edges: [] });
  });
});

describe('关系图的疏密配置', () => {
  async function spacingWith(config: Record<string, unknown>) {
    const app = new App({ name: 'T', logLevel: 'error' });
    const pages = pageHost();
    running.push({ app, pages });
    await registerHubs(app);
    app.bind({ provide }).provide.use(webuiServer, pages.service);
    await app.plugin(memoryInMemory);
    await app.plugin(relationPlugin, { extractionEnabled: false, ...config });
    await app.plugins.idle();
    expect(pages.logs).toEqual([]);
    const [graph] = pages.view('user-relation').content as Array<Record<string, unknown>>;
    return graph.spacing;
  }

  it('graphSpacing 经关系图组件带到界面；不写取默认 120，越界的按默认', async () => {
    expect(await spacingWith({ graphSpacing: 200 })).toBe(200);
    expect(await spacingWith({})).toBe(120);
    expect(await spacingWith({ graphSpacing: 0 })).toBe(120);
  });
});
