import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import type { ChatModelRequest, ChatResponse, LLMModel } from '../../packages/plugin-llm-api/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import type { Message } from '../../packages/plugin-message-api/src/index.js';
import { RelationExtractor } from '../../packages/plugin-user-relation/src/extractor.js';
import { RelationService } from '../../packages/plugin-user-relation/src/service.js';
import { RelationStore } from '../../packages/plugin-user-relation/src/store.js';

/** 构造可注入的 fake LLM model。chat() 返回 cannedResponse；记录最后一次请求供断言 */
function makeFakeLLM(cannedResponse: string): { model: LLMModel; calls: ChatModelRequest[] } {
  const calls: ChatModelRequest[] = [];
  const model: LLMModel = {
    id: 'fake-extractor',
    contextLength: 8000,
    capabilities: ['chat'],
    chat(req: ChatModelRequest): Promise<ChatResponse> {
      calls.push(req);
      return Promise.resolve({ content: cannedResponse });
    },
  } as unknown as LLMModel;
  return { model, calls };
}

async function setup(llmContent: string) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(memoryInMemoryModule);
  const mem = app.ctx.getService<MemoryService>('memory');
  if (!mem) throw new Error('no memory');
  const store = new RelationStore(mem);
  const service = new RelationService(store);
  const { model, calls } = makeFakeLLM(llmContent);
  app.ctx.provide('llm', model, {
    capabilities: ['chat'],
    label: 'fake-llm',
    entryId: 'fake/extractor',
  });
  const extractor = new RelationExtractor(app.ctx, service, {
    triggerEveryNMessages: 3,
    readWindowSize: 10,
    mode: 'incremental',
    allNewMaxMessages: 200,
    candidateEventDays: 7,
    candidateEventLimit: 20,
    senderNeighborhoodEdgeLimit: 0,
    disableThinking: true,
    strictSelfAssertion: false,
    debug: false,
  });
  extractor.start();
  service.setTriggerExtractionHandler(sid => extractor.triggerNow(sid));
  return { app, mem, service, extractor, calls };
}

const mkUserMsg = (messageId: string, userId: string, content: string, nickname?: string): Message => ({
  role: 'user',
  content,
  metadata: { messageId, userId, nickname, platform: 'onebot' },
});

describe('plugin-user-relation: extractor', () => {
  it('LLM 输出落到关系图（人物 / 事件 / 人-事件 / 人-人 边）', async () => {
    const llmJson = JSON.stringify({
      persons: [
        { platform: 'onebot', userId: 'a', displayName: 'Alice' },
        { platform: 'onebot', userId: 'b', displayName: 'Bob' },
      ],
      events: [
        {
          refKey: 'e1',
          title: '讨论直播计划',
          summary: 'A 与 B 在群里讨论本周直播',
          category: 'discussion',
          evidence: { messageIds: ['m1'], quote: '本周直播' },
        },
      ],
      personEventEdges: [
        {
          personPlatform: 'onebot',
          personUserId: 'a',
          eventRefKey: 'e1',
          role: 'initiator',
          sentiment: 'positive',
          evidence: { messageIds: ['m1'], quote: '本周直播' },
        },
        {
          personPlatform: 'onebot',
          personUserId: 'b',
          eventRefKey: 'e1',
          role: 'participant',
          evidence: { messageIds: ['m2'], quote: '我也来' },
        },
      ],
      personPersonEdges: [
        {
          fromPlatform: 'onebot',
          fromUserId: 'a',
          toPlatform: 'onebot',
          toUserId: 'b',
          relationType: 'friend',
          evidence: { messageIds: ['m1'], quote: '本周直播' },
        },
      ],
    });
    const { mem, service, extractor, calls } = await setup(llmJson);
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', '我们安排一下本周直播', 'Alice'));
    await mem.saveMessage('sess1', mkUserMsg('m2', 'b', '好啊，我也来', 'Bob'));
    const res = await extractor.triggerNow('sess1');
    expect(res.status).toBe('ok');
    expect(calls).toHaveLength(1);

    const snap = await service.loadAll();
    expect(snap.persons).toHaveLength(2);
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].title).toBe('讨论直播计划');
    expect(snap.events[0].evidence[0]?.quote).toBe('本周直播');

    const peEdges = snap.edges.filter(e => e.kind === 'person-event');
    expect(peEdges).toHaveLength(2);
    expect(peEdges.map(e => e.kind === 'person-event' && e.role).sort()).toEqual(['initiator', 'participant']);

    const ppEdges = snap.edges.filter(e => e.kind === 'person-person');
    expect(ppEdges).toHaveLength(1);
    expect(ppEdges[0].kind === 'person-person' && ppEdges[0].relationType).toBe('friend');
  });

  it('evidence 验证：messageId 不在窗口 → evidence 为空（事件仍创建）', async () => {
    const llmJson = JSON.stringify({
      events: [
        {
          refKey: 'e1',
          title: '伪事件',
          evidence: { messageIds: ['nonexistent'], quote: '不存在' },
        },
      ],
      // 给一条边让 event 通过反孤儿守卫
      personEventEdges: [{ personPlatform: 'test', personUserId: 'a', eventRefKey: 'e1', role: 'participant' }],
    });
    const { mem, service, extractor } = await setup(llmJson);
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', 'hello'));
    await extractor.triggerNow('sess1');
    const snap = await service.loadAll();
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].evidence).toHaveLength(0);
  });

  it('evidence 验证：quote 不是窗口任何消息的子串 → evidence 为空', async () => {
    const llmJson = JSON.stringify({
      events: [
        {
          refKey: 'e1',
          title: '事件',
          evidence: { messageIds: ['m1'], quote: '幻觉文本' },
        },
      ],
      personEventEdges: [{ personPlatform: 'test', personUserId: 'a', eventRefKey: 'e1', role: 'participant' }],
    });
    const { mem, service, extractor } = await setup(llmJson);
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', '完全无关的内容'));
    await extractor.triggerNow('sess1');
    const snap = await service.loadAll();
    expect(snap.events[0].evidence).toHaveLength(0);
  });

  it('inFlight 防并发：同 session 第二次调用立即 skipped', async () => {
    // 用慢 LLM 让首次调用还在飞
    const slowLLM: LLMModel = {
      id: 'slow',
      capabilities: ['chat'],
      chat: () => new Promise<ChatResponse>(r => setTimeout(() => r({ content: '{}' }), 30)),
    } as unknown as LLMModel;
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(memoryInMemoryModule);
    const mem = app.ctx.getService<MemoryService>('memory');
    if (!mem) throw new Error('no memory');
    const service = new RelationService(new RelationStore(mem));
    app.ctx.provide('llm', slowLLM, { capabilities: ['chat'], entryId: 'slow/x' });
    const extractor = new RelationExtractor(app.ctx, service, {
      triggerEveryNMessages: 1,
      readWindowSize: 5,
      mode: 'incremental',
      allNewMaxMessages: 100,
      candidateEventDays: 7,
      candidateEventLimit: 10,
      disableThinking: true,
      strictSelfAssertion: false,
      debug: false,
    });
    extractor.start();
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', 'hi'));
    const p1 = extractor.triggerNow('sess1');
    const p2 = await extractor.triggerNow('sess1');
    expect(p2.status).toBe('skipped');
    await p1;
  });

  it('messageId 缺失的消息不触发提取（窗口内无可提取消息）', async () => {
    const { mem, service, extractor, calls } = await setup('{}');
    await mem.saveMessage('sess1', { role: 'user', content: 'no metadata' });
    const res = await extractor.triggerNow('sess1');
    expect(res.status).toBe('ok');
    expect(calls).toHaveLength(0); // 无可提取消息，未调 LLM
    const snap = await service.loadAll();
    expect(snap.persons).toHaveLength(0);
  });

  it('LLM 返回非 JSON → 静默跳过', async () => {
    const { mem, service, extractor } = await setup('我不会输出 JSON');
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', 'hi'));
    const res = await extractor.triggerNow('sess1');
    expect(res.status).toBe('ok');
    const snap = await service.loadAll();
    expect(snap.persons).toHaveLength(0);
  });

  it('计数器：emit inbound:message:archived 累积到阈值才触发', async () => {
    // person 必须被边引用才能通过反孤儿守卫，所以给条 entity 边
    const llmJson = JSON.stringify({
      persons: [{ platform: 'onebot', userId: 'c' }],
      entities: [{ refKey: 'g1', name: '游戏', entityKind: 'work' }],
      personEntityEdges: [{ personPlatform: 'onebot', personUserId: 'c', entityRefKey: 'g1', role: 'mentioned' }],
    });
    const { app, mem, service, calls } = await setup(llmJson);
    await mem.saveMessage('sess2', mkUserMsg('m1', 'c', '消息1'));
    // 阈值 3：emit 两次不触发
    app.ctx.emit('inbound:message:archived', { sessionId: 'sess2' } as never);
    app.ctx.emit('inbound:message:archived', { sessionId: 'sess2' } as never);
    expect(calls).toHaveLength(0);
    // 第三次触发
    app.ctx.emit('inbound:message:archived', { sessionId: 'sess2' } as never);
    // 提取是异步的，等一拍
    await new Promise(r => setTimeout(r, 20));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const snap = await service.loadAll();
    expect(snap.persons.some(p => p.userId === 'c')).toBe(true);
  });

  it('senderNeighborhoodEdgeLimit>0：把已知发言人的 1 跳邻居子图注入到 LLM prompt', async () => {
    // 先用一轮提取把 alice→三角洲(entity) 关系写进去
    const seedJson = JSON.stringify({
      persons: [{ platform: 'onebot', userId: 'alice', displayName: 'Alice' }],
      entities: [
        {
          refKey: 'g1',
          name: '三角洲',
          entityKind: 'work',
          evidence: { messageIds: ['s1'], quote: '三角洲' },
        },
      ],
      personEntityEdges: [
        {
          personPlatform: 'onebot',
          personUserId: 'alice',
          entityRefKey: 'g1',
          role: 'enthusiast',
          sentiment: 'positive',
          evidence: { messageIds: ['s1'], quote: '我喜欢三角洲' },
        },
      ],
    });
    // 第二轮用空 LLM 输出，只为捕获 prompt 中的 neighbor 渲染
    const probeJson = '{}';
    const { app, mem, service, extractor, calls } = await setup(seedJson);
    // 把 cfg 中的 senderNeighborhoodEdgeLimit 改成 5（setup 默认为 0）
    (extractor as unknown as { cfg: { senderNeighborhoodEdgeLimit: number } }).cfg.senderNeighborhoodEdgeLimit = 5;

    await mem.saveMessage('sN', mkUserMsg('s1', 'alice', '我喜欢三角洲', 'Alice'));
    let res = await extractor.triggerNow('sN');
    expect(res.status).toBe('ok');
    const snapAfterSeed = await service.loadAll();
    expect(snapAfterSeed.entities.some(e => e.name === '三角洲')).toBe(true);

    // 切换 fake LLM 的 canned response 到 probe（替换 model 内部回应）
    const llmHandle = app.ctx.getService<{ chat(): Promise<{ content: string }> }>('llm');
    // 简单 hack: 用新的 fake 替换原本的；改用直接修改原 chat 行为
    type LlmInternal = { chat: (req: unknown) => Promise<{ content: string }> };
    (llmHandle as unknown as LlmInternal).chat = (req: unknown) => {
      calls.push(req as never);
      return Promise.resolve({ content: probeJson });
    };

    // 第二轮：再 alice 发一条新消息，触发 neighbor 注入
    await mem.saveMessage('sN', mkUserMsg('s2', 'alice', '今晚开黑', 'Alice'));
    res = await extractor.triggerNow('sN');
    expect(res.status).toBe('ok');

    const lastCall = calls.at(-1);
    expect(lastCall).toBeDefined();
    const userMsg = (lastCall as unknown as { messages: Array<{ role: string; content: string }> }).messages.find(
      m => m.role === 'user',
    );
    expect(userMsg?.content).toMatch(/候选人已有 1 跳邻居子图/);
    expect(userMsg?.content).toMatch(/三角洲/);
    expect(userMsg?.content).toMatch(/role=enthusiast/);
  });

  it('self-placeholder 守卫：LLM 误抽出的 aalis:aalis 占位 person + 边一律丢弃', async () => {
    // 模拟 LLM 把 assistant 自身误抽成占位 person，并尝试给它建 person-entity 边
    const llmJson = JSON.stringify({
      persons: [
        { platform: 'aalis', userId: 'aalis', displayName: 'Aalis' },
        { platform: 'onebot', userId: 'a', displayName: 'Alice' },
      ],
      entities: [
        { refKey: 'e1', name: '三角洲', entityKind: 'work', evidence: { messageIds: ['m1'], quote: '三角洲' } },
      ],
      personEntityEdges: [
        // 占位 self → 应被丢弃
        {
          personPlatform: 'aalis',
          personUserId: 'aalis',
          entityRefKey: 'e1',
          role: 'mentioned',
          evidence: { messageIds: ['m1'], quote: '三角洲' },
        },
        // 真实用户 → 应保留
        {
          personPlatform: 'onebot',
          personUserId: 'a',
          entityRefKey: 'e1',
          role: 'enthusiast',
          evidence: { messageIds: ['m1'], quote: '三角洲' },
        },
      ],
      personPersonEdges: [
        // 占位 self 任一端 → 整条丢弃
        {
          fromPlatform: 'onebot',
          fromUserId: 'a',
          toPlatform: 'aalis',
          toUserId: 'aalis',
          relationType: 'friend',
          evidence: { messageIds: ['m1'], quote: '三角洲' },
        },
      ],
    });
    const { mem, service, extractor } = await setup(llmJson);
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', '我玩三角洲', 'Alice'));
    const res = await extractor.triggerNow('sess1');
    expect(res.status).toBe('ok');

    const snap = await service.loadAll();
    // aalis:aalis 不应入库
    expect(snap.persons.find(p => p.id === 'aalis:aalis')).toBeUndefined();
    // alice 入库，其对实体 e1 的 enthusiast 边保留
    expect(snap.persons.find(p => p.id === 'onebot:a')).toBeDefined();
    const peEnt = snap.edges.filter(e => e.kind === 'person-entity');
    expect(peEnt).toHaveLength(1);
    expect(peEnt[0].kind === 'person-entity' && peEnt[0].fromPersonId).toBe('onebot:a');
    // person-person 边因含 self 占位 → 不应有
    expect(snap.edges.filter(e => e.kind === 'person-person')).toHaveLength(0);
  });
});
