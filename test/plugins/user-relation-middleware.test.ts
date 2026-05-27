import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import type { Message } from '../../packages/plugin-message-api/src/index.js';
import { registerRelationMiddleware } from '../../packages/plugin-user-relation/src/middleware.js';
import { RelationService } from '../../packages/plugin-user-relation/src/service.js';
import { RelationStore } from '../../packages/plugin-user-relation/src/store.js';

async function setup() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(memoryInMemoryModule);
  const mem = app.ctx.getService<MemoryService>('memory');
  if (!mem) throw new Error('no memory');
  const service = new RelationService(new RelationStore(mem));
  return { app, service };
}

/** 让 middleware 跑一次：返回最终 messages 数组 */
async function runMiddleware(
  app: App,
  service: RelationService,
  opts: {
    userId?: string;
    platform?: string;
    triggerType?: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive';
    initialMessages?: Message[];
    groupOnly?: boolean;
    maxDepth?: number;
  },
): Promise<Message[]> {
  registerRelationMiddleware(app.ctx, service, {
    enabled: true,
    maxDepth: opts.maxDepth ?? 1,
    maxBreadth: 5,
    maxEvents: 5,
    maxRelations: 5,
    maxParticipantsPerEvent: 5,
    maxCooccurrencePartners: 5,
    groupOnly: opts.groupOnly ?? false,
    debug: false,
  });
  const data = {
    messages: opts.initialMessages ?? [
      { role: 'system' as const, content: '原 system' },
      { role: 'user' as const, content: '你好', metadata: { groupId: 'g1', sessionType: 'group' } },
    ],
    tools: [],
    sessionId: 'sess1',
    userId: opts.userId,
    platform: opts.platform,
    triggerType: opts.triggerType,
  };
  await app.ctx.hooks.run('agent:llm:before', data);
  return data.messages;
}

describe('plugin-user-relation: middleware', () => {
  it('无 userId / platform → 不注入', async () => {
    const { app, service } = await setup();
    const messages = await runMiddleware(app, service, { triggerType: 'direct' });
    expect(messages.some(m => m.metadata?.injector === 'user-relation')).toBe(false);
  });

  it('triggerType=interval → 不注入（focus 不在该用户）', async () => {
    const { app, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    await service.createEvent({ title: '事件', evidence: [] });
    const messages = await runMiddleware(app, service, {
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'interval',
    });
    expect(messages.some(m => m.metadata?.injector === 'user-relation')).toBe(false);
  });

  it('用户在关系图中有事件 → 注入摘要 system 块', async () => {
    const { app, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    const ev = await service.createEvent({ title: '讨论直播', summary: 'A 提议直播', evidence: [] });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: ev.id,
      role: 'initiator',
      sentiment: 'positive',
    });
    const messages = await runMiddleware(app, service, {
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
    });
    const injected = messages.find(m => m.metadata?.injector === 'user-relation');
    expect(injected).toBeDefined();
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('讨论直播');
    expect(content).toContain('initiator');
  });

  it('用户有人-人关系 → 注入关系列表', async () => {
    const { app, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    await service.observePerson('onebot', 'u2', 'Bob');
    await service.addPersonPersonEdge({
      fromPersonId: 'onebot:u1',
      toPersonId: 'onebot:u2',
      relationType: 'friend',
    });
    const messages = await runMiddleware(app, service, {
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'immediate',
    });
    const injected = messages.find(m => m.metadata?.injector === 'user-relation');
    expect(injected).toBeDefined();
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('friend');
    expect(content).toContain('u2');
  });

  it('groupOnly=true 且 messages 无 group 标记 → 不注入', async () => {
    const { app, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    const ev = await service.createEvent({ title: 'x', evidence: [] });
    await service.addPersonEventEdge({ fromPersonId: 'onebot:u1', toEventId: ev.id, role: 'participant' });
    const messages = await runMiddleware(app, service, {
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
      groupOnly: true,
      initialMessages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '你好' }, // 无 groupId
      ],
    });
    expect(messages.some(m => m.metadata?.injector === 'user-relation')).toBe(false);
  });

  it('实体别名 → 注入显示「（别名: …）」', async () => {
    const { app, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    const ent = await service.createEntity({
      entityKind: 'work',
      name: '文明6',
      aliases: ['Civ6', 'civ6'],
      evidence: [],
    });
    await service.addPersonEntityEdge({
      fromPersonId: 'onebot:u1',
      toEntityId: ent.id,
      relationType: 'interested-in',
    });
    const messages = await runMiddleware(app, service, {
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
    });
    const injected = messages.find(m => m.metadata?.injector === 'user-relation');
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('别名:');
    expect(content).toContain('Civ6');
  });

  it('event part-of global hub → 注入「所属跨会话话题」', async () => {
    const { app, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    const child = await service.createEvent({ title: '群1 聊直播', evidence: [] });
    const hub = await service.createEvent({
      title: '直播相关讨论',
      sessionScope: 'global',
      evidence: [],
    });
    await service.addPersonEventEdge({ fromPersonId: 'onebot:u1', toEventId: child.id, role: 'participant' });
    await service.addEventEventEdge({
      fromEventId: child.id,
      toEventId: hub.id,
      relationType: 'part-of',
    });
    const messages = await runMiddleware(app, service, {
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
      maxDepth: 2,
    });
    const injected = messages.find(m => m.metadata?.injector === 'user-relation');
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('所属跨会话话题');
    expect(content).toContain('直播相关讨论');
  });

  it('共现伙伴附「共同关注」实体', async () => {
    const { app, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    await service.observePerson('onebot', 'u2', 'Bob');
    const ent = await service.createEntity({ entityKind: 'work', name: '文明6', evidence: [] });
    // 双方都关注同一 entity（关系不能是 mentioned）
    await service.addPersonEntityEdge({
      fromPersonId: 'onebot:u1',
      toEntityId: ent.id,
      role: 'enthusiast',
    });
    await service.addPersonEntityEdge({
      fromPersonId: 'onebot:u2',
      toEntityId: ent.id,
      role: 'enthusiast',
    });
    // 通过事件共现：u1 + u2 一起参加两次同样事件（共现需≥2）
    const ev1 = await service.createEvent({ title: '一起开黑', evidence: [] });
    const ev2 = await service.createEvent({ title: '一起复盘', evidence: [] });
    for (const ev of [ev1, ev2]) {
      await service.addPersonEventEdge({ fromPersonId: 'onebot:u1', toEventId: ev.id, role: 'participant' });
      await service.addPersonEventEdge({ fromPersonId: 'onebot:u2', toEventId: ev.id, role: 'participant' });
    }

    const messages = await runMiddleware(app, service, {
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
      maxDepth: 2,
    });
    const injected = messages.find(m => m.metadata?.injector === 'user-relation');
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('共同关注');
    expect(content).toContain('文明6');
  });
});
