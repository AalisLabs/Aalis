import { describe, expect, it, vi } from 'vitest';
import type { TurnInput } from '../../packages/api-agent/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, logger } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { registerRelationContribution } from '../../packages/plugin-user-relation/src/middleware.js';
import { RelationService } from '../../packages/plugin-user-relation/src/service.js';
import { RelationStore } from '../../packages/plugin-user-relation/src/store.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { turnInput } from '../fixtures/turn-input.js';

/**
 * 登记贡献（middleware）与收集贡献（组装器）共用宿主根激活绑定的 contributions + logger，
 * 注入块的 injector 全局键因此冠同一个激活 id；memory 只为给 RelationStore 一个后端。
 * 本文件只测不收窄的注入（关系图范围见 user-relation-recall-scope.test.ts，仅群聊见 user-relation-group-only.test.ts）。
 */
async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ contributions, logger, memory });
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.idle();
  if (!host.memory.present) throw new Error('no memory');
  const mem = host.memory.use;
  const service = new RelationService(new RelationStore(mem));
  return { host, service };
}

type Host = Awaited<ReturnType<typeof setup>>['host'];

/** 让 middleware 跑一次：返回最终 messages 数组 */
async function runMiddleware(
  host: Host,
  service: RelationService,
  opts: {
    /** 这一轮的输入 */
    inputs: TurnInput[];
    initialMessages?: Message[];
    maxDepth?: number;
    /** 全局热点的两条上限，缺省各 5；为 0 时不出全局热点 */
    maxGlobalHot?: number;
  },
): Promise<Message[]> {
  registerRelationContribution(
    { contributions: host.contributions, sessionOnly: () => false, multiParty: () => false },
    service,
    {
      maxDepth: opts.maxDepth ?? 1,
      maxBreadth: 5,
      maxEvents: 5,
      maxRelations: 5,
      maxParticipantsPerEvent: 5,
      maxCooccurrencePartners: 5,
      // 曾漏传这两个必填项 —— 于是全局热点的两条限流在本测试里从未生效
      maxGlobalHotEvents: opts.maxGlobalHot ?? 5,
      maxGlobalHotEntities: opts.maxGlobalHot ?? 5,
      groupOnly: false,
    },
  );
  const data = {
    messages: opts.initialMessages ?? [
      { role: 'system' as const, content: '原 system' },
      { role: 'user' as const, content: '你好', metadata: { groupId: 'g1', sessionType: 'group' } },
    ],
    sessionId: 'sess1',
    platform: 'onebot',
  };
  await assemblePromptContributions(host, data, opts.inputs);
  return data.messages;
}

/** onebot 上 userId 说的一句，triggerType 是触发判定写的方式 */
const said = (userId: string, triggerType: TurnInput['message']['triggerType']) =>
  turnInput({ userId, platform: 'onebot', triggerType });

describe('plugin-user-relation: middleware', () => {
  it('没有 userId → 不注入', async () => {
    const { host, service } = await setup();
    const messages = await runMiddleware(host, service, { inputs: [turnInput({ triggerType: 'direct' })] });
    expect(messages.some(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'))).toBe(false);
  });

  it('构建抛错（如全图读取失败）→ 本轮不注入，组装器记 warn，不看 debug 开关', async () => {
    const { host, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    vi.spyOn(service, 'loadAll').mockRejectedValue(new Error('关系图读取失败'));
    const warns: unknown[][] = [];
    vi.spyOn(host.logger.use, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args);
    });
    const messages = await runMiddleware(host, service, { inputs: [said('u1', 'direct')] });
    expect(messages.some(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'))).toBe(false);
    expect(
      warns.some(
        ([msg, err]) =>
          String(msg).includes('/user-relation') && (err as Error | undefined)?.message === '关系图读取失败',
      ),
    ).toBe(true);
  });

  it('triggerType=interval → 不注入（focus 不在该用户）', async () => {
    const { host, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    await service.createEvent({ title: '事件', evidence: [] });
    const messages = await runMiddleware(host, service, {
      inputs: [said('u1', 'interval')],
    });
    expect(messages.some(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'))).toBe(false);
  });

  it('用户在关系图中有事件 → 注入摘要 system 块', async () => {
    const { host, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    const ev = await service.createEvent({ title: '讨论直播', summary: 'A 提议直播', evidence: [] });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: ev.id,
      role: 'initiator',
      sentiment: 'positive',
    });
    const messages = await runMiddleware(host, service, {
      inputs: [said('u1', 'direct')],
    });
    const injected = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'));
    expect(injected).toBeDefined();
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('讨论直播');
    expect(content).toContain('initiator');
  });

  it('一轮两条点名的输入：两位的子图合在一块里，各人的小节标题注明是谁', async () => {
    const { host, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    await service.observePerson('onebot', 'u2', 'Bob');
    const ev1 = await service.createEvent({ title: '讨论直播', evidence: [] });
    const ev2 = await service.createEvent({ title: '组队开黑', evidence: [] });
    await service.addPersonEventEdge({ fromPersonId: 'onebot:u1', toEventId: ev1.id, role: 'initiator' });
    await service.addPersonEventEdge({ fromPersonId: 'onebot:u2', toEventId: ev2.id, role: 'initiator' });
    // 关掉全局热点：两个事件都会出现在「最近热点（全局）」里，按事件标题断言就分不出各人的子图有没有生成
    const messages = await runMiddleware(host, service, {
      inputs: [said('u1', 'direct'), said('u2', 'immediate')],
      maxGlobalHot: 0,
    });
    const injected = messages.filter(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'));
    expect(injected).toHaveLength(1);
    const content = String(injected[0]?.content);
    expect(content).toContain('## 近期参与的事件（Alice(u1)）\n- 讨论直播');
    expect(content).toContain('## 近期参与的事件（Bob(u2)）\n- 组队开黑');
  });

  it('用户有人-人关系 → 注入关系列表', async () => {
    const { host, service } = await setup();
    await service.observePerson('onebot', 'u1', 'Alice');
    await service.observePerson('onebot', 'u2', 'Bob');
    await service.addPersonPersonEdge({
      fromPersonId: 'onebot:u1',
      toPersonId: 'onebot:u2',
      relationType: 'friend',
    });
    const messages = await runMiddleware(host, service, {
      inputs: [said('u1', 'immediate')],
    });
    const injected = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'));
    expect(injected).toBeDefined();
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('friend');
    expect(content).toContain('u2');
  });

  it('实体别名 → 注入显示「（别名: …）」', async () => {
    const { host, service } = await setup();
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
      // 曾写作 `relationType: 'interested-in'` —— 该字段不存在（真名 role），
      // 且 'interested-in' 不在 PersonEntityRole 取值里；于是必填的 role 实际是 undefined。
      role: 'enthusiast',
    });
    const messages = await runMiddleware(host, service, {
      inputs: [said('u1', 'direct')],
    });
    const injected = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'));
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('别名:');
    expect(content).toContain('Civ6');
  });

  it('event part-of global hub → 注入「所属跨会话话题」', async () => {
    const { host, service } = await setup();
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
    const messages = await runMiddleware(host, service, {
      inputs: [said('u1', 'direct')],
      maxDepth: 2,
    });
    const injected = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'));
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('所属跨会话话题');
    expect(content).toContain('直播相关讨论');
  });

  it('共现伙伴附「共同关注」实体', async () => {
    const { host, service } = await setup();
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

    const messages = await runMiddleware(host, service, {
      inputs: [said('u1', 'direct')],
      maxDepth: 2,
    });
    const injected = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/user-relation'));
    const content = typeof injected?.content === 'string' ? injected.content : '';
    expect(content).toContain('共同关注');
    expect(content).toContain('文明6');
  });
});
