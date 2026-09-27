import { describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type MemoryRecallScope, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, logger, optional, provide } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { registerRelationContribution } from '../../packages/plugin-user-relation/src/middleware.js';
import { RelationService } from '../../packages/plugin-user-relation/src/service.js';
import { RelationStore } from '../../packages/plugin-user-relation/src/store.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { roomScopeManager } from '../fixtures/room-scope.js';

// ════════════════════════════════════════════════════════════
// 召回按房间收窄（user-relation）：房间 memoryRecallScope 为 session 时，关系图注入
// 跳过全局热点与跨会话事件（别的会话里抽出的事件、所属跨会话话题），只留本会话的事件；
// 人际关系与关注的事物照常注入（它们是按人的摘要，与 user-profile 的参与者事实同类，owner 定为保留）。
// 其余取值、房间未设置或 session-manager 不在场时维持现状。
// ════════════════════════════════════════════════════════════

const CUR = 'onebot:10000:group:20001';
const OTHER_GROUP = 'onebot:10000:group:20002';
const PRIV = 'onebot:10000:private:30001';

async function setup(room?: {
  rooms?: Record<string, MemoryRecallScope>;
  profiles?: Record<string, MemoryRecallScope>;
}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ contributions, logger, memory, provide, sessionManager: optional(sessionManager) });
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.idle();
  if (room) host.provide(sessionManager, roomScopeManager(room.rooms, room.profiles));
  const mem = host.memory.current;
  if (!mem) throw new Error('no memory');
  const service = new RelationService(new RelationStore(() => mem));

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

  registerRelationContribution(host, service, {
    maxDepth: 2,
    maxBreadth: 10,
    maxEvents: 10,
    maxRelations: 10,
    maxParticipantsPerEvent: 5,
    maxCooccurrencePartners: 5,
    maxGlobalHotEvents: 10,
    maxGlobalHotEntities: 10,
    groupOnly: false,
  });
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
  await app.stop();
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

describe('plugin-user-relation: 召回按房间收窄', () => {
  it('房间 session：跳过全局热点与跨会话事件，本会话事件与人际关系照常', async () => {
    const text = await setup({ rooms: { [CUR]: 'session' } });
    expect(text).toContain('本群开黑');
    expect(text).toContain('friend');
    expect(text).not.toContain('私聊约饭');
    expect(text).not.toContain('所属跨会话话题');
    expect(text).not.toContain('别群分支');
    expect(text).not.toContain('最近热点');
    expect(text).not.toContain('全网热点');
    expect(text).not.toContain('热门游戏');
  });

  it('平台档写 session、房间未写：按会话所属平台解析，同样收窄', async () => {
    const text = await setup({ profiles: { onebot: 'session' } });
    expect(text).toContain('本群开黑');
    expect(text).not.toContain('私聊约饭');
    expect(text).not.toContain('全网热点');
  });

  it('房间 platform 或 all：维持现状', async () => {
    expectUnnarrowed(await setup({ rooms: { [CUR]: 'platform' } }));
    expectUnnarrowed(await setup({ rooms: { [CUR]: 'all' } }));
  });

  it('session-manager 不在场：维持现状', async () => {
    expectUnnarrowed(await setup());
  });
});
