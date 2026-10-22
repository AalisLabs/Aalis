import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { userRelation } from '../../packages/api-user-relation/src/index.js';
import { App, definePlugin, logger, provide } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userRelationPlugin, { type RelationService } from '../../packages/plugin-user-relation/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { sessionValuesPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 关系图范围（user-relation 的 recallScope，可按会话设）：为「仅本会话」时，关系图注入跳过全局热点与跨会话事件（别的会话里
// 抽出的事件、所属跨会话话题），只留本会话的事件；人际关系与关注的事物照常注入（它们是按人的摘要，与 user-profile 的参与者
// 事实同类）。写坏了按「仅本会话」；为「全部」或会话设置不在时维持现状。关系图工具的会话作用域参数同样不超过
// 它：为「仅本会话」时只能是调用所在的会话，模型传别的会话或不传都按它；没有这个参数的工具（解析节点、最短路径、联系分数、
// 共同邻居、列边）同样不带别的会话的事件。
// ════════════════════════════════════════════════════════════

const CUR = 'onebot:10000:group:20001';
const OTHER_GROUP = 'onebot:10000:group:20002';
const PRIV = 'onebot:10000:private:30001';

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 装上关系图插件（只开注入），备好图，跑一次当前群里 u1 的注入，返回注入块正文 */
async function inject(pluginConfig: Record<string, unknown> = {}, sessions?: Record<string, Record<string, unknown>>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  if (sessions) await app.plugin(sessionValuesPlugin(sessions));
  await app.plugin(userRelationPlugin, {
    extractionEnabled: false,
    toolsEnabled: false,
    commandsEnabled: false,
    agentInjection: true,
    injectionMaxDepth: 2,
    injectionMaxBreadth: 10,
    maxInjectedEvents: 10,
    maxInjectedRelations: 10,
    maxParticipantsPerEvent: 5,
    maxCooccurrencePartners: 5,
    maxGlobalHotEvents: 10,
    maxGlobalHotEntities: 10,
    groupOnly: false,
    ...pluginConfig,
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userRelationPlugin.name)?.state !== 'active')
    throw new Error('plugin-user-relation 未激活');
  const host = app.bind({ contributions, logger, relation: userRelation });
  const service = host.relation.use as RelationService;

  await service.observePerson('onebot', 'u1', 'Alice');
  await service.observePerson('onebot', 'u2', 'Bob');
  await service.addPersonPersonEdge({ fromPersonId: 'onebot:u1', toPersonId: 'onebot:u2', relationType: 'friend' });
  const here = await service.createEvent({ title: '本群开黑', sessionScope: CUR, evidence: [] });
  const elsewhere = await service.createEvent({ title: '私聊约饭', sessionScope: PRIV, evidence: [] });
  for (const ev of [here, elsewhere]) {
    await service.addPersonEventEdge({ fromPersonId: 'onebot:u1', toEventId: ev.id, role: 'participant' });
  }
  // 本群事件挂在一个跨会话话题下，兄弟事件来自别的群
  const hub = await service.createEvent({ title: '跨群话题', sessionScope: 'global', evidence: [] });
  const sibling = await service.createEvent({ title: '别群分支', sessionScope: OTHER_GROUP, evidence: [] });
  for (const ev of [here, sibling]) {
    await service.addEventEventEdge({ fromEventId: ev.id, toEventId: hub.id, relationType: 'part-of' });
  }
  // 与当前发言者无关的全局热点
  await service.createEvent({ title: '全网热点', sessionScope: 'global', evidence: [] });
  await service.createEntity({ entityKind: 'work', name: '热门游戏', evidence: [] });

  const messages: Message[] = [
    { role: 'system', content: '人设' },
    { role: 'user', content: '你好', metadata: { groupId: '20001', sessionType: 'group' } },
  ];
  await assemblePromptContributions(host, {
    messages,
    sessionId: CUR,
    userId: 'u1',
    platform: 'onebot',
    triggerType: 'direct',
  });
  const block = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'));
  return typeof block?.content === 'string' ? block.content : '';
}

/** 不收窄时注入块里应有的全部内容 */
function expectUnnarrowed(text: string): void {
  expect(text).toContain('本群开黑');
  expect(text).toContain('私聊约饭');
  expect(text).toContain('所属跨会话话题');
  expect(text).toContain('最近热点');
  expect(text).toContain('全网热点');
  expect(text).toContain('热门游戏');
}

/** 收窄到本会话时的注入块 */
function expectSessionOnly(text: string): void {
  expect(text).toContain('本群开黑');
  expect(text).toContain('friend');
  expect(text).not.toContain('私聊约饭');
  expect(text).not.toContain('所属跨会话话题');
  expect(text).not.toContain('别群分支');
  expect(text).not.toContain('最近热点');
  expect(text).not.toContain('全网热点');
  expect(text).not.toContain('热门游戏');
}

describe('plugin-user-relation：关系图范围', () => {
  it('这个会话设成仅本会话：跳过全局热点与跨会话事件，本会话事件与人际关系照常', async () => {
    expectSessionOnly(await inject({}, { [CUR]: { recallScope: 'session' } }));
  });

  it('插件配置设成仅本会话、会话设置不在：同样收窄', async () => {
    expectSessionOnly(await inject({ recallScope: 'session' }));
  });

  it('写坏了按仅本会话：会话层或插件配置里的坏值都收窄', async () => {
    expectSessionOnly(await inject({}, { [CUR]: { recallScope: 'everything' } }));
    expectSessionOnly(await inject({ recallScope: 'everything' }));
  });

  it('默认全部、别的会话设成仅本会话、会话设置不在时：维持现状', async () => {
    expectUnnarrowed(await inject());
    expectUnnarrowed(await inject({}, { [PRIV]: { recallScope: 'session' } }));
    expectUnnarrowed(await inject({ recallScope: 'session' }, { [CUR]: { recallScope: 'all' } }));
  });
});

/**
 * 装上关系图插件（只开工具），工具登记在一个记下处理函数的替身上；备好两个会话里的事件，返回按会话调工具的函数与事件 id。
 * u1、u2、u3、u5 一起在本群开黑，u1、u2、u4 一起私聊约饭，u3 → u4 是朋友：u1 到 u4 的最短路经私聊约饭，只走本群的要经 u3
 */
async function relationTools(sessions: Record<string, Record<string, unknown>>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  const handlers = new Map<string, RegisteredTool['handler']>();
  app.bind({ provide }).provide.use(tools, {
    registerGroup: () => () => {},
    register: (tool: RegisteredTool) => {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => handlers.delete(tool.definition.function.name);
    },
  } as never);
  await app.plugin(sessionValuesPlugin(sessions));
  await app.plugin(userRelationPlugin, {
    extractionEnabled: false,
    toolsEnabled: true,
    commandsEnabled: false,
    agentInjection: false,
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userRelationPlugin.name)?.state !== 'active')
    throw new Error('plugin-user-relation 未激活');
  const service = app.bind({ relation: userRelation }).relation.use as RelationService;
  for (const [userId, name] of [
    ['u1', 'Alice'],
    ['u2', 'Bob'],
    ['u3', 'Carol'],
    ['u4', 'Dave'],
    ['u5', 'Eve'],
  ]) {
    await service.observePerson('onebot', userId, name);
  }
  const ids: Record<string, string> = {};
  for (const [title, sessionScope, people] of [
    ['本群开黑', CUR, ['u1', 'u2', 'u3', 'u5']],
    ['私聊约饭', PRIV, ['u1', 'u2', 'u4']],
  ] as const) {
    const event = await service.createEvent({ title, summary: '周末', sessionScope, evidence: [] });
    ids[title] = event.id;
    for (const userId of people) {
      await service.addPersonEventEdge({ fromPersonId: `onebot:${userId}`, toEventId: event.id, role: 'participant' });
    }
  }
  await service.addPersonPersonEdge({ fromPersonId: 'onebot:u3', toPersonId: 'onebot:u4', relationType: 'friend' });
  const call = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`工具未登记：${name}`);
    const out = await handler(args, { sessionId, platform: 'onebot', userId: 'u1' });
    return typeof out === 'string' ? out : out.content;
  };
  return { call, ids };
}

describe('plugin-user-relation：关系图工具的会话作用域', () => {
  const SCOPED: Array<[string, Record<string, unknown>]> = [
    ['user_relation_search_events', {}],
    ['user_relation_timeline', { node_id: 'onebot:u1' }],
    ['user_relation_expand_node', { node_id: 'onebot:u1' }],
    ['user_relation_gossip', { days: 0 }],
    ['user_relation_recommend_persons', { node_id: 'onebot:u1', max_depth: 2 }],
  ];

  /** 没有会话作用域参数的工具：仅本会话时只在去掉别的会话事件的图上取 */
  const UNSCOPED: Array<[string, Record<string, unknown>]> = [
    ['user_relation_resolve_node', { keyword: '周末', kinds: ['event'] }],
    ['user_relation_shared', { a_id: 'onebot:u1', b_id: 'onebot:u2' }],
    ['user_relation_score', { from_node_id: 'onebot:u1', to_node_id: 'onebot:u2', top_paths: 20 }],
    ['user_relation_find_path', { from_node_id: 'onebot:u1', to_node_id: 'onebot:u4' }],
  ];

  it('仅本会话：带会话作用域的工具只取调用所在会话的事件，模型传别的会话或不传都一样', async () => {
    const { call } = await relationTools({ [CUR]: { recallScope: 'session' } });
    for (const [name, args] of SCOPED) {
      for (const scope of [{}, { session_scope: PRIV }, { session_scope: 'global' }]) {
        const out = await call(CUR, name, { ...args, ...scope });
        expect(out, `${name} ${JSON.stringify(scope)}`).toContain('本群开黑');
        expect(out, `${name} ${JSON.stringify(scope)}`).not.toContain('私聊约饭');
      }
    }
    const overview = await call(CUR, 'user_relation_community_overview', { session_scope: PRIV });
    expect(overview).not.toContain('私聊约饭');
    // 推荐的分数同样只经本会话的事件：两跳内只经私聊约饭连上的 u4 不进推荐
    expect(await call(CUR, 'user_relation_recommend_persons', SCOPED[4][1])).not.toContain('onebot:u4');
    // 展开同样在裁过的图上走：两跳内只经私聊约饭连上的 u4 不在子图里
    const expanded = await call(CUR, 'user_relation_expand_node', { node_id: 'onebot:u1', max_depth: 2 });
    expect(expanded).not.toContain('onebot:u4');
  });

  it('仅本会话：解析节点、共同邻居、联系分数、最短路径与列边不带别的会话的事件', async () => {
    const { call, ids } = await relationTools({ [CUR]: { recallScope: 'session' } });
    for (const [name, args] of UNSCOPED) {
      const out = await call(CUR, name, args);
      expect.soft(out, name).toContain('本群开黑');
      expect.soft(out, name).not.toContain('私聊约饭');
    }
    // 最短路绕开私聊约饭，经本群开黑与 u3 到 u4
    expect.soft(JSON.parse(await call(CUR, 'user_relation_find_path', UNSCOPED[3][1]))).toMatchObject({
      found: true,
      length: 3,
    });
    const edges = await call(CUR, 'user_relation_list_edges', { node_id: 'onebot:u1' });
    expect.soft(edges, 'user_relation_list_edges').toContain(ids.本群开黑);
    expect.soft(edges, 'user_relation_list_edges').not.toContain(ids.私聊约饭);
  });

  it('全部（默认）：照模型传的作用域取，不传不过滤', async () => {
    const { call, ids } = await relationTools({ [PRIV]: { recallScope: 'session' } });
    expect(await call(CUR, 'user_relation_search_events', { session_scope: PRIV })).toContain('私聊约饭');
    const all = await call(CUR, 'user_relation_search_events');
    expect(all).toContain('本群开黑');
    expect(all).toContain('私聊约饭');
    for (const [name, args] of UNSCOPED) expect(await call(CUR, name, args), name).toContain('私聊约饭');
    expect(await call(CUR, 'user_relation_list_edges', { node_id: 'onebot:u1' })).toContain(ids.私聊约饭);
    const recommended = await call(CUR, 'user_relation_recommend_persons', SCOPED[4][1]);
    expect(recommended).toContain('私聊约饭');
    expect(recommended).toContain('onebot:u4');
    expect(await call(CUR, 'user_relation_expand_node', { node_id: 'onebot:u1', max_depth: 2 })).toContain('onebot:u4');
    // 共同邻居不按解释路径的条数截：两件事都在
    expect(await call(CUR, 'user_relation_shared', UNSCOPED[1][1])).toContain('本群开黑');
  });
});

describe('plugin-user-relation：关系图范围的登记', () => {
  /** 按这份配置装上关系图插件，返回它有没有向会话设置登记按会话字段 */
  async function registers(config: Record<string, unknown>): Promise<boolean> {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    await app.plugin(memoryInMemory);
    const registered: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'zz-session-settings',
        provides: [sessionSettings],
        uses: { provide },
        apply: ({ provide }) => {
          provide.use(sessionSettings, {
            register: (plugin: string) => {
              registered.push(plugin);
              return () => {};
            },
            chain: () => ({ parts: [] }),
          } as never);
        },
      }),
    );
    await app.plugin(userRelationPlugin, { extractionEnabled: false, commandsEnabled: false, ...config });
    await app.plugins.idle();
    if (app.plugins.getPlugin(userRelationPlugin.name)?.state !== 'active')
      throw new Error('plugin-user-relation 未激活');
    return registered.includes(userRelationPlugin.name);
  }

  it('注入与工具都关着时不登记（这一项不影响任何东西）；开着其中一个时登记', async () => {
    expect(await registers({ agentInjection: false, toolsEnabled: false })).toBe(false);
    expect(await registers({ agentInjection: true, toolsEnabled: false })).toBe(true);
    expect(await registers({ agentInjection: false, toolsEnabled: true })).toBe(true);
  });
});
