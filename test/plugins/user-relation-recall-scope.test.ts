import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { userRelation } from '../../packages/api-user-relation/src/index.js';
import { App, logger } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userRelationPlugin, { type RelationService } from '../../packages/plugin-user-relation/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { sessionValuesPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 关系图范围（user-relation 的 recallScope，可按会话设）：为「仅本会话」时，关系图注入跳过全局热点与跨会话事件（别的会话里
// 抽出的事件、所属跨会话话题），只留本会话的事件；人际关系与关注的事物照常注入（它们是按人的摘要，与 user-profile 的参与者
// 事实同类，owner 定为保留）。写坏了按「仅本会话」；为「全部」或会话设置不在时维持现状。
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
