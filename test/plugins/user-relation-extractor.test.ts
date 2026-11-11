import { App, events, LogHub, lifecycle, logger, provide, services } from '@aalis/core';
import { describe, expect, it, vi } from 'vitest';
import { type ChatModelRequest, type ChatResponse, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { persona } from '../../packages/api-persona/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import type { ExtractorConfig } from '../../packages/plugin-user-relation/src/extractor.js';
import { EXTRACTOR_CONFIG_DEFAULTS, RelationExtractor } from '../../packages/plugin-user-relation/src/extractor.js';
import { RelationService } from '../../packages/plugin-user-relation/src/service.js';
import { RelationStore } from '../../packages/plugin-user-relation/src/store.js';
import type { IncomingMessage, Message } from '../../packages/schema-message/src/index.js';

/**
 * ExtractorConfig 中测试用例普遍不关心的字段，统一从 extractor.ts 导出的单一真源
 * `EXTRACTOR_CONFIG_DEFAULTS` 继承。新增字段时只需改 extractor.ts，TS 编译期会拦下遗漏。
 *
 * 此处仅按测试惯例覆写少数关键开关（关闭淘汰/quota，避免误触发清理逻辑干扰断言）。
 */
const EXTRACTOR_DEFAULTS = {
  ...EXTRACTOR_CONFIG_DEFAULTS,
  evictionEnabled: false,
  maxPersons: 0,
  maxEvents: 0,
  maxEntities: 0,
  maxEdges: 0,
  consolidateAfterEviction: false,
  consolidateAutoLink: false,
  consolidateSkipLowScorePairs: false,
  consolidateLowScoreThreshold: 0,
} satisfies ExtractorConfig;

/** 构造可注入的 fake LLM model。chat() 返回 cannedResponse（给的是回复列表时按次序回，用完了回最后一条）；记录每次请求供断言。
 *  fail.remaining > 0 时调用 reject（模拟超时/网络故障，供退避用例；Infinity=持续故障）。 */
function makeFakeLLM(cannedResponse: string | ChatResponse[]): {
  model: LLMModel;
  calls: ChatModelRequest[];
  fail: { remaining: number };
} {
  const calls: ChatModelRequest[] = [];
  const fail = { remaining: 0 };
  const model: LLMModel = {
    id: 'fake-extractor',
    contextLength: 8000,
    capabilities: ['chat'],
    chat(req: ChatModelRequest): Promise<ChatResponse> {
      calls.push(req);
      if (fail.remaining > 0) {
        fail.remaining -= 1;
        return Promise.reject(new Error('fake LLM timeout'));
      }
      if (typeof cannedResponse === 'string') return Promise.resolve({ content: cannedResponse });
      return Promise.resolve(cannedResponse[Math.min(calls.length, cannedResponse.length) - 1]);
    },
  } as unknown as LLMModel;
  return { model, calls, fail };
}

/** 宿主侧能力：provide 种桩服务，其余六样正是 RelationExtractor 声明要用的（lifecycle 是根激活的，停机时中止） */
function bindHost(app: App) {
  return app.bind({ provide, events, logger, memory, llm, persona, lifecycle });
}

/** 直驱一轮提取（私有方法；插件不提供手动触发入口，生产上只由消息计数触发） */
function extractNow(extractor: RelationExtractor, sessionId: string): Promise<void> {
  return (extractor as unknown as { extractSession(sid: string): Promise<void> }).extractSession(sessionId);
}

async function setup(llmContent: string | ChatResponse[], cfg: Partial<ExtractorConfig> = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = bindHost(app);
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.idle();
  if (!host.memory.present) throw new Error('no memory');
  const mem = app.bind({ services }).services.use.get(memory)!;
  const store = new RelationStore(mem);
  const service = new RelationService(store);
  const { model, calls, fail } = makeFakeLLM(llmContent);
  host.provide.use(llm, model, {
    label: 'fake-llm',
    entryId: 'fake/extractor',
  });
  const extractor = new RelationExtractor(host, service, {
    ...EXTRACTOR_DEFAULTS,
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
    ...cfg,
  });
  extractor.start();
  return { app, host, mem, service, extractor, calls, fail };
}

const mkUserMsg = (messageId: string, userId: string, content: string, nickname?: string): Message => ({
  role: 'user',
  content,
  metadata: { messageId, userId, nickname, platform: 'onebot' },
});

/** 一条真人入站落库之后的事件（计数只看入站本身） */
const archivedEvent = (sessionId: string, userId = 'a') => ({
  sessionId,
  incoming: { content: '在吗', sessionId, platform: 'onebot', userId },
  archivedMessage: { role: 'user' as const, content: '在吗' },
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
    await extractNow(extractor, 'sess1');
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

  // ⚠️ 这条守的是「读次数」这个没人看的维度。热路径上每次 listMetadata 读回整个
  // user-relation 命名空间并全量反序列化——生产图实测中位 177ms（3352 文档 / 38.7MB），
  // 而 triggerEveryNMessages=1 时它每条消息都跑。此前 pickCandidates 与 pickSenderNeighbors
  // 各自 loadAll 一次，两次之间只有纯函数调用、零写操作，纯属重复。
  //
  // 138 条既有 user-relation 用例没有一条关心读次数：把这次合并整个回滚，测试照样全绿。
  // 这正是它当初能长出来的原因，所以断言必须落在**次数**上。
  it('提取一轮内只读一次全图（候选与邻居共享同一份快照）', async () => {
    const { app, host, mem, service } = await setup(JSON.stringify({ persons: [], events: [], entities: [] }));
    try {
      await service.observePerson('onebot', 'a', 'A');
      for (const m of [mkUserMsg('m1', 'a', '随便说点什么'), mkUserMsg('m2', 'a', '再说一句')]) {
        await mem.saveMessage('sess-count', m);
      }
      let reads = 0;
      const orig = mem.listMetadata.bind(mem);
      mem.listMetadata = async (ns: string) => {
        if (ns === 'user-relation') reads++;
        return orig(ns);
      };
      const extractor = new RelationExtractor(host, service, {
        ...EXTRACTOR_DEFAULTS,
        triggerEveryNMessages: 1,
        readWindowSize: 10,
        mode: 'incremental',
        senderNeighborhoodEdgeLimit: 100, // 打开邻居采集，否则它自己就跳过了
        disableThinking: true,
        debug: false,
      });
      extractor.start();
      reads = 0;
      await extractNow(extractor, 'sess-count');
      // 精确值而非上界：这条断言的全部意义就在次数上，松一格就测不出回归
      //（实测合并=1、拆开=2，写 <=2 两种情形都会过——第一版就踩了这个假绿）。
      // 日后若确有必要多读一次，请连同理由一起改这个数字，别放宽成不等式。
      expect(reads, `提取一轮的全图读次数=${reads}，两个消费者必须共享同一份快照`).toBe(1);
    } finally {
      await app.stop();
    }
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
      personEventEdges: [{ personPlatform: 'onebot', personUserId: 'a', eventRefKey: 'e1', role: 'participant' }],
    });
    const { mem, service, extractor } = await setup(llmJson);
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', 'hello'));
    await extractNow(extractor, 'sess1');
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
      personEventEdges: [{ personPlatform: 'onebot', personUserId: 'a', eventRefKey: 'e1', role: 'participant' }],
    });
    const { mem, service, extractor } = await setup(llmJson);
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', '完全无关的内容'));
    await extractNow(extractor, 'sess1');
    const snap = await service.loadAll();
    expect(snap.events[0].evidence).toHaveLength(0);
  });

  it('inFlight 防并发：同 session 第二次调用立即返回，不重复调 LLM', async () => {
    // 用慢 LLM 让首次调用还在飞
    let chatCalls = 0;
    const slowLLM: LLMModel = {
      id: 'slow',
      capabilities: ['chat'],
      chat: () => {
        chatCalls++;
        return new Promise<ChatResponse>(r => setTimeout(() => r({ content: '{}' }), 30));
      },
    } as unknown as LLMModel;
    const app = new App({ name: 'T', logLevel: 'error' });
    const host = bindHost(app);
    await app.plugins.register(memoryInMemory, {});
    await app.plugins.idle();
    if (!host.memory.present) throw new Error('no memory');
    const mem = app.bind({ services }).services.use.get(memory)!;
    const service = new RelationService(new RelationStore(mem));
    host.provide.use(llm, slowLLM, { entryId: 'slow/x' });
    const extractor = new RelationExtractor(host, service, {
      ...EXTRACTOR_DEFAULTS,
      triggerEveryNMessages: 1,
      readWindowSize: 5,
      mode: 'incremental',
      allNewMaxMessages: 100,
      candidateEventDays: 7,
      candidateEventLimit: 10,
      senderNeighborhoodEdgeLimit: 0,
      disableThinking: true,
      strictSelfAssertion: false,
      debug: false,
    });
    extractor.start();
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', 'hi'));
    const p1 = extractNow(extractor, 'sess1');
    await extractNow(extractor, 'sess1');
    await p1;
    expect(chatCalls).toBe(1);
  });

  it('messageId 缺失的消息不触发提取（窗口内无可提取消息）', async () => {
    const { mem, service, extractor, calls } = await setup('{}');
    await mem.saveMessage('sess1', { role: 'user', content: 'no metadata' });
    await extractNow(extractor, 'sess1');
    expect(calls).toHaveLength(0); // 无可提取消息，未调 LLM
    const snap = await service.loadAll();
    expect(snap.persons).toHaveLength(0);
  });

  it('LLM 报了 length（被输出上限截断）：JSON 完整也不收，重试一次、提示写明被截断；重试仍截断就跳过这一批', async () => {
    const llmJson = JSON.stringify({
      persons: [{ platform: 'onebot', userId: 'a', displayName: 'Alice' }],
      events: [{ refKey: 'e1', title: '讨论直播计划', summary: 'A 在群里说要直播', category: 'discussion' }],
      personEventEdges: [{ personPlatform: 'onebot', personUserId: 'a', eventRefKey: 'e1', role: 'initiator' }],
    });
    const truncated: ChatResponse = { content: llmJson, finishReason: 'length' };
    const { mem, service, extractor, calls } = await setup([truncated, truncated]);
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', '我们安排一下本周直播', 'Alice'));
    await extractNow(extractor, 'sess1');
    expect(calls).toHaveLength(2);
    expect(String(calls[1].messages.at(-1)?.content)).toContain('在长度上限处被截断');
    const snap = await service.loadAll();
    expect(snap.events).toHaveLength(0);
    expect(snap.edges).toHaveLength(0);
  });

  it('LLM 返回非 JSON → 重试提示写明不是合法的 JSON 对象、不猜原因，重试仍不是就静默跳过', async () => {
    const { mem, service, extractor, calls } = await setup('我不会输出 JSON');
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', 'hi'));
    await extractNow(extractor, 'sess1');
    const retry = String(calls[1].messages.at(-1)?.content);
    expect(retry).toContain('不是合法的 JSON 对象');
    expect(retry).not.toContain('很可能');
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
    const { host, mem, service, calls } = await setup(llmJson);
    await mem.saveMessage('sess2', mkUserMsg('m1', 'c', '消息1'));
    // 阈值 3：emit 两次不触发
    host.events.use.emit('inbound:message:archived', archivedEvent('sess2'));
    host.events.use.emit('inbound:message:archived', archivedEvent('sess2'));
    expect(calls).toHaveLength(0);
    // 第三次触发
    host.events.use.emit('inbound:message:archived', archivedEvent('sess2'));
    // 提取是异步的，等一拍
    await new Promise(r => setTimeout(r, 20));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const snap = await service.loadAll();
    expect(snap.persons.some(p => p.userId === 'c')).toBe(true);
  });

  // LLM 表示"无可提取"的合法空输出：每次尝试恰好一次 chat 调用，便于退避用例数调用次数
  const EMPTY_EXTRACTION = JSON.stringify({
    persons: [],
    events: [],
    entities: [],
    personEventEdges: [],
    personEntityEdges: [],
    personPersonEdges: [],
    eventEventEdges: [],
    eventEntityEdges: [],
    entityEntityEdges: [],
  });

  it('连续失败退避：跳过触发点几何加深、封顶，LLM 恢复后一次成功即归位', async () => {
    const { host, mem, calls, fail } = await setup(EMPTY_EXTRACTION);
    await mem.saveMessage('sb', mkUserMsg('m1', 'a', 'hi'));
    // 逐个触发点推进（阈值 3 → 每点 3 条消息），点间等提取落定，保证时序确定
    const advance = async (points: number) => {
      for (let p = 0; p < points; p++) {
        for (let i = 0; i < 3; i++) host.events.use.emit('inbound:message:archived', archivedEvent('sb'));
        await new Promise(r => setTimeout(r, 15));
      }
    };

    fail.remaining = Number.POSITIVE_INFINITY;
    await advance(1); // 尝试 1 失败 → penalty=2，跳过 1 个触发点
    expect(calls).toHaveLength(1);
    await advance(1); // 被跳过
    expect(calls).toHaveLength(1);
    await advance(1); // 尝试 2 失败 → penalty=4，跳过 3 个触发点
    expect(calls).toHaveLength(2);
    await advance(3); // 全部被跳过
    expect(calls).toHaveLength(2);
    await advance(1); // 尝试 3 失败 → penalty=8（封顶），跳过 7 个触发点
    expect(calls).toHaveLength(3);
    await advance(7);
    expect(calls).toHaveLength(3);
    await advance(1); // 尝试 4 失败 → penalty 仍为 8（封顶不再翻倍）
    expect(calls).toHaveLength(4);

    fail.remaining = 0; // LLM 恢复
    await advance(7); // 上次失败留下的 7 个跳过点仍生效
    expect(calls).toHaveLength(4);
    await advance(1); // 尝试 5 成功 → 退避整体清除
    expect(calls).toHaveLength(5);
    await advance(1); // 恢复正常节奏：下一个触发点即尝试
    expect(calls).toHaveLength(6);

    // 钉住"整体清除"的 penalty 半边：归位后再次失败须从 penalty=2 重新起步
    //（若成功只清了 skip、残留 penalty=8，这里会跳 7 个触发点而非 1 个）
    fail.remaining = 1;
    await advance(1); // 尝试 7 失败 → penalty=2，跳过 1 个触发点
    expect(calls).toHaveLength(7);
    await advance(1); // 被跳过
    expect(calls).toHaveLength(7);
    await advance(1); // 即恢复尝试
    expect(calls).toHaveLength(8);
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
    await extractNow(extractor, 'sN');
    const snapAfterSeed = await service.loadAll();
    expect(snapAfterSeed.entities.some(e => e.name === '三角洲')).toBe(true);

    // 切换 fake LLM 的 canned response 到 probe（替换 model 内部回应）
    // 改提供者交出的实例本身：业务句柄是转发句柄，在它上面改方法落不到提供者
    const llmHandle = app.bind({ services }).services.use.get(llm);
    // 简单 hack: 用新的 fake 替换原本的；改用直接修改原 chat 行为
    type LlmInternal = { chat: (req: unknown) => Promise<{ content: string }> };
    (llmHandle as unknown as LlmInternal).chat = (req: unknown) => {
      calls.push(req as never);
      return Promise.resolve({ content: probeJson });
    };

    // 第二轮：再 alice 发一条新消息，触发 neighbor 注入
    await mem.saveMessage('sN', mkUserMsg('s2', 'alice', '今晚开黑', 'Alice'));
    await extractNow(extractor, 'sN');

    const lastCall = calls.at(-1);
    expect(lastCall).toBeDefined();
    const userMsg = (lastCall as unknown as { messages: Array<{ role: string; content: string }> }).messages.find(
      m => m.role === 'user',
    );
    expect(userMsg?.content).toMatch(/候选人已有 1 跳邻居子图/);
    expect(userMsg?.content).toMatch(/三角洲/);
    expect(userMsg?.content).toMatch(/role=enthusiast/);
  });

  it('人物只认窗口发言者、被 @ 的人与图里已有的人：模型凭空写出的人（自指的 aalis:aalis、mia:mia、编的账号）连同他的边一起丢，图里已有的人照常连边', async () => {
    const outsiders = ['aalis:aalis', 'mia:mia', 'onebot:stranger'];
    const people = ['onebot:a', 'onebot:old', ...outsiders].map(id => ({
      platform: id.split(':')[0],
      userId: id.split(':')[1],
    }));
    const llmJson = JSON.stringify({
      persons: people,
      entities: [{ refKey: 'e1', name: '绝航', entityKind: 'work', evidence: { messageIds: ['m1'], quote: '绝航' } }],
      personEntityEdges: people.map(p => ({
        personPlatform: p.platform,
        personUserId: p.userId,
        entityRefKey: 'e1',
        role: 'participant',
        evidence: { messageIds: ['m1'], quote: '绝航' },
      })),
      personPersonEdges: people.slice(1).map(p => ({
        fromPlatform: 'onebot',
        fromUserId: 'a',
        toPlatform: p.platform,
        toUserId: p.userId,
        relationType: 'friend',
        evidence: { messageIds: ['m1'], quote: '绝航' },
      })),
    });
    const { mem, service, extractor } = await setup(llmJson);
    await service.observePerson('onebot', 'old', '老朋友');
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', '今晚玩绝航', 'Alice'));
    await extractNow(extractor, 'sess1');

    const snap = await service.loadAll();
    expect(snap.persons.map(p => p.id).sort()).toEqual(['onebot:a', 'onebot:old']);
    const linked = snap.edges.flatMap(e => (e.kind === 'person-entity' ? [e.fromPersonId] : []));
    expect(linked.sort()).toEqual(['onebot:a', 'onebot:old']);
    const friends = snap.edges.flatMap(e => (e.kind === 'person-person' ? [e.toPersonId] : []));
    expect(friends).toEqual(['onebot:old']);
  });

  it('不按名单认人：账号恰好是 self 的发言者照常是人，他与他的边保留', async () => {
    const llmJson = JSON.stringify({
      persons: [{ platform: 'onebot', userId: 'self', displayName: '群友' }],
      entities: [{ refKey: 'e1', name: '测试', entityKind: 'topic', evidence: { messageIds: ['m1'], quote: '测试' } }],
      personEntityEdges: [
        {
          personPlatform: 'onebot',
          personUserId: 'self',
          entityRefKey: 'e1',
          role: 'mentioned',
          evidence: { messageIds: ['m1'], quote: '测试' },
        },
      ],
    });
    const { mem, service, extractor } = await setup(llmJson);
    await mem.saveMessage('sess1', mkUserMsg('m1', 'self', '测试', '群友'));
    await extractNow(extractor, 'sess1');

    const snap = await service.loadAll();
    expect(snap.persons.map(p => p.id)).toEqual(['onebot:self']);
    expect(snap.edges.filter(e => e.kind === 'person-entity')).toHaveLength(1);
  });

  it('带账号的她自己是窗口发言者：图里还没有她，她与发言者的边照常落库', async () => {
    const llmJson = JSON.stringify({
      persons: [
        { platform: 'onebot', userId: 'a', displayName: 'Alice' },
        { platform: 'onebot', userId: '10000', displayName: '<人设名占位>' },
      ],
      personPersonEdges: [
        {
          fromPlatform: 'onebot',
          fromUserId: 'a',
          toPlatform: 'onebot',
          toUserId: '10000',
          relationType: 'friend',
          evidence: { messageIds: ['m1'], quote: '谢谢你' },
        },
      ],
    });
    const { mem, service, extractor } = await setup(llmJson);
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', '谢谢你', 'Alice'));
    await mem.saveMessage('sess1', {
      role: 'assistant',
      content: '不客气',
      metadata: { messageId: 'm2', platform: 'onebot', userId: '10000' },
    });
    await extractNow(extractor, 'sess1');

    const snap = await service.loadAll();
    expect(snap.persons.map(p => p.id).sort()).toEqual(['onebot:10000', 'onebot:a']);
    const edge = snap.edges.find(e => e.kind === 'person-person');
    expect(edge?.kind === 'person-person' && [edge.fromPersonId, edge.toPersonId]).toEqual([
      'onebot:a',
      'onebot:10000',
    ]);
  });

  it('被 @ 但没发言、图里也没有的人按存档记下的 Mentions 收下：A→B 边与 B 节点落库', async () => {
    const llmJson = JSON.stringify({
      persons: [
        { platform: 'onebot', userId: 'a', displayName: 'Alice' },
        { platform: 'onebot', userId: '<占位账号B>', displayName: 'B' },
      ],
      personPersonEdges: [
        {
          fromPlatform: 'onebot',
          fromUserId: 'a',
          toPlatform: 'onebot',
          toUserId: '<占位账号B>',
          relationType: 'friend',
          evidence: { messageIds: ['m1'], quote: '是我兄弟' },
        },
      ],
    });
    const { mem, service, extractor } = await setup(llmJson);
    const said = mkUserMsg('m1', 'a', '<at id="<占位账号B>">B</at> 是我兄弟', 'Alice');
    await mem.saveMessage('sess1', { ...said, metadata: { ...said.metadata, mentions: ['<占位账号B>'] } });
    await extractNow(extractor, 'sess1');

    const snap = await service.loadAll();
    expect(snap.persons.map(p => p.id).sort()).toEqual(['onebot:<占位账号B>', 'onebot:a']);
    const edge = snap.edges.find(e => e.kind === 'person-person');
    expect(edge?.kind === 'person-person' && [edge.fromPersonId, edge.toPersonId]).toEqual([
      'onebot:a',
      'onebot:<占位账号B>',
    ]);
  });

  it('跨会话的窗口里被 @ 的账号按各自那条消息的平台收下', async () => {
    const llmJson = JSON.stringify({
      persons: [
        { platform: 'onebot', userId: 'a' },
        { platform: 'onebot', userId: '<占位账号B>' },
        { platform: 'zz-chat', userId: 'c' },
        { platform: 'zz-chat', userId: '<占位账号D>' },
      ],
      personPersonEdges: [
        ['onebot', 'a', '<占位账号B>', 'm1'],
        ['zz-chat', 'c', '<占位账号D>', 'm2'],
      ].map(([platform, from, to, mid]) => ({
        fromPlatform: platform,
        fromUserId: from,
        toPlatform: platform,
        toUserId: to,
        relationType: 'friend',
        evidence: { messageIds: [mid], quote: '是我兄弟' },
      })),
    });
    const { mem, service, extractor } = await setup(llmJson, {
      readScope: 'cross-platform',
      crossSessionMaxAgeMinutes: 0,
    });
    await mem.saveMessage('sessA', {
      role: 'user',
      content: '<at id="<占位账号B>">B</at> 是我兄弟',
      metadata: { messageId: 'm1', userId: 'a', platform: 'onebot', mentions: ['<占位账号B>'] },
    });
    await mem.saveMessage('sessB', {
      role: 'user',
      content: '<at id="<占位账号D>">D</at> 是我兄弟',
      metadata: { messageId: 'm2', userId: 'c', platform: 'zz-chat', mentions: ['<占位账号D>'] },
    });
    await extractNow(extractor, 'sessA');

    const snap = await service.loadAll();
    expect(snap.persons.map(p => p.id).sort()).toEqual([
      'onebot:<占位账号B>',
      'onebot:a',
      'zz-chat:<占位账号D>',
      'zz-chat:c',
    ]);
    expect(snap.edges.filter(e => e.kind === 'person-person')).toHaveLength(2);
  });

  it('整理不按登记的平台删人：人与边都还在', async () => {
    const { service } = await setup('{}');
    await service.observePerson('onebot', '<占位账号>', '群友');
    const entity = await service.createEntity({ name: '绝航', entityKind: 'work', evidence: [] });
    await service.addPersonEntityEdge({ fromPersonId: 'onebot:<占位账号>', toEntityId: entity.id, role: 'enthusiast' });
    await service.consolidate({ autoLink: false });

    const snap = await service.loadAll();
    expect(snap.persons.map(p => p.id)).toEqual(['onebot:<占位账号>']);
    expect(snap.edges.filter(e => e.kind === 'person-entity')).toHaveLength(1);
  });

  it('提取提示里机器人的称呼取人设名：缺账号的 assistant 行与系统提示同一个名字，一次提取只取一次', async () => {
    const { host, mem, extractor, calls } = await setup('{}');
    const getPersonaName = vi.fn(() => '<人设名占位>');
    host.provide.use(persona, { getSystemPrompt: () => '', getPersonaName }, { entryId: 'stub/persona' });
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', '在吗'));
    await mem.saveMessage('sess1', {
      role: 'assistant',
      content: '在的',
      metadata: { messageId: 'm2', platform: 'onebot' },
    });
    await extractNow(extractor, 'sess1');

    const prompt = calls[0].messages.map(m => String(m.content)).join('\n');
    expect(prompt).toContain('[m2] (<人设名占位>) 在的');
    expect(prompt).toContain('你是 <人设名占位> 的「社会关系神经」');
    expect(prompt).not.toContain('Aalis');
    expect(getPersonaName.mock.calls).toEqual([[{ sessionId: 'sess1', platform: 'onebot' }]]);
  });

  it('没有人设服务时机器人的称呼用中性的「机器人」', async () => {
    const { mem, extractor, calls } = await setup('{}');
    await mem.saveMessage('sess1', mkUserMsg('m1', 'a', '在吗'));
    await mem.saveMessage('sess1', {
      role: 'assistant',
      content: '在的',
      metadata: { messageId: 'm2', platform: 'onebot' },
    });
    await extractNow(extractor, 'sess1');

    const prompt = calls[0].messages.map(m => String(m.content)).join('\n');
    expect(prompt).toContain('[m2] (机器人) 在的');
    expect(prompt).not.toContain('Aalis');
  });

  it('跨会话 hub 建模：readScope=same-platform 时，prompt 含 hub 规则段 + candidate 含 scope 标签 + 消息行带 [sid:] 前缀', async () => {
    // 用空 LLM 输出（不落任何节点），只断言 prompt 内容
    const { host, mem, service, calls } = await setup('{}');
    // 先在 sessA 写一条消息触发自动建一个 current 事件
    await mem.saveMessage('sessA', mkUserMsg('mA1', 'a', 'A 群约工会战', 'Alice'));
    // 手动建一个 sessA 的 current event 作为已有候选
    await service.createEvent({
      title: 'A群工会战集结',
      sessionScope: 'sessA',
      evidence: [{ sessionId: 'sessA', messageIds: ['mA1'], quote: 'A 群约工会战', extractedAt: Date.now() }],
    });
    // sessB 写消息，准备从 sessB 触发跨会话提取
    await mem.saveMessage('sessB', mkUserMsg('mB1', 'b', 'B 群也聊工会战', 'Bob'));

    // 跨平台拉取的 extractor
    const xExtractor = new RelationExtractor(host, service, {
      ...EXTRACTOR_DEFAULTS,
      triggerEveryNMessages: 999,
      readWindowSize: 10,
      mode: 'incremental',
      allNewMaxMessages: 200,
      candidateEventDays: 7,
      candidateEventLimit: 20,
      senderNeighborhoodEdgeLimit: 0,
      disableThinking: true,
      strictSelfAssertion: false,
      debug: false,
      readScope: 'same-platform',
      crossSessionMaxAgeMinutes: 0,
    });

    await extractNow(xExtractor, 'sessB');
    expect(calls).toHaveLength(1);

    const userMsg = calls[0].messages.find(m => m.role === 'user');
    expect(userMsg, 'user prompt 存在').toBeTruthy();
    const userContent = typeof userMsg!.content === 'string' ? userMsg!.content : JSON.stringify(userMsg!.content);

    // 1. hub 规则段被注入
    expect(userContent).toContain('跨会话 hub 建模规则');
    expect(userContent).toContain('part-of');
    // 2. candidate 行带 scope 标签（sessA 事件相对 sessB 是 other）
    expect(userContent).toMatch(/A群工会战集结.*scope=other:sessA/);
    // 3. 消息行带 [sid:] 前缀（两个 session 都获取到了）
    expect(userContent).toContain('[sid:sessA]');
    expect(userContent).toContain('[sid:sessB]');
  });
});

describe('plugin-user-relation: extractor 随停用中止', () => {
  it('提取的模型调用途中停机：交给它的中止信号随之断开，不记提取失败', async () => {
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry(entry => {
      if (entry.level === 'warn') warns.push(entry.message);
    });
    const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
    const host = bindHost(app);
    await app.plugins.register(memoryInMemory, {});
    await app.plugins.idle();
    const mem = app.bind({ services }).services.use.get(memory)!;
    const service = new RelationService(new RelationStore(mem));
    const calls: ChatModelRequest[] = [];
    const chat = (req: ChatModelRequest) =>
      new Promise<ChatResponse>((_, reject) => {
        calls.push(req);
        req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true });
      });
    host.provide.use(llm, { id: 'fake-extractor', contextLength: 8000, capabilities: ['chat'], chat } as never, {
      entryId: 'fake/extractor',
    });
    new RelationExtractor(host, service, {
      ...EXTRACTOR_DEFAULTS,
      triggerEveryNMessages: 1,
      readWindowSize: 10,
      mode: 'incremental',
      senderNeighborhoodEdgeLimit: 0,
      disableThinking: true,
      debug: false,
    }).start();
    await mem.saveMessage('sess-stop', mkUserMsg('m1', 'u1', '我喜欢猫', '甲'));
    await host.events.use.emit('inbound:message:archived', {
      sessionId: 'sess-stop',
      incoming: { userId: 'u1', platform: 'onebot' } as IncomingMessage,
    } as never);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await app.stop();
    expect(calls[0].signal?.aborted).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(warns.filter(line => line.includes('提取失败'))).toEqual([]);
  });
});

describe('plugin-user-relation: 淘汰前的整理随停用中止', () => {
  it('整理的模型调用途中停机：交给它的中止信号随之断开，不记整理失败，也不接着淘汰', async () => {
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry(entry => {
      if (entry.level === 'warn') warns.push(entry.message);
    });
    const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
    const host = bindHost(app);
    await app.plugins.register(memoryInMemory, {});
    await app.plugins.idle();
    const mem = app.bind({ services }).services.use.get(memory)!;
    const store = new RelationStore(mem);
    const service = new RelationService(store, undefined, undefined, host.lifecycle.use.signal);
    // 两个同名实体：超出实体配额，整理的严格等价段拿它们去问模型
    for (let i = 0; i < 2; i++) {
      await store.upsertEntity({
        id: `zz-entity-${i}`,
        entityKind: 'work',
        name: '三角洲行动',
        aliases: [],
        firstSeenAt: 1,
        lastReinforcedAt: 1,
        lastMentionedAt: 1,
        mentionCount: 1,
        weight: 0.5,
        evidence: [],
      });
    }
    const consolidateCalls: ChatModelRequest[] = [];
    const chat = (req: ChatModelRequest) => {
      if (!String(req.messages[0]?.content).includes('实体消歧')) {
        return Promise.resolve({
          content: JSON.stringify({ persons: [{ platform: 'onebot', userId: 'u1', displayName: '甲' }] }),
        });
      }
      return new Promise<ChatResponse>((_, reject) => {
        consolidateCalls.push(req);
        req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true });
      });
    };
    host.provide.use(llm, { id: 'fake-extractor', contextLength: 8000, capabilities: ['chat'], chat } as never, {
      entryId: 'fake/extractor',
    });
    new RelationExtractor(host, service, {
      ...EXTRACTOR_DEFAULTS,
      triggerEveryNMessages: 1,
      readWindowSize: 10,
      mode: 'incremental',
      senderNeighborhoodEdgeLimit: 0,
      disableThinking: true,
      debug: false,
      evictionEnabled: true,
      maxEntities: 1,
      evictHysteresisPct: 0,
      consolidateAfterEviction: true,
      consolidateAutoLink: true,
      consolidateLLMModelRef: {},
    }).start();
    await mem.saveMessage('sess-stop', mkUserMsg('m1', 'u1', '今晚打三角洲行动', '甲'));
    await host.events.use.emit('inbound:message:archived', {
      sessionId: 'sess-stop',
      incoming: { userId: 'u1', platform: 'onebot' } as IncomingMessage,
    } as never);
    await vi.waitFor(() => expect(consolidateCalls).toHaveLength(1));
    await app.stop();
    expect(consolidateCalls[0].signal?.aborted).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(warns).toEqual([]);
  });
});

describe('plugin-user-relation: extractor 只算真人的话（有账号且不带来源，与用户档案同一判据）', () => {
  const PARENT = 'onebot:10000:group:20001';
  const SUB = 'subtask-1';

  /** 再挂上消息归档：输入经它落库，与生产同一形态（入站的 source 记进元数据，落库之后发 inbound:message:archived） */
  async function withArchive(app: App) {
    await app.plugins.register(messageArchivePlugin, { debugLogs: false });
    await app.plugins.idle();
    return app.bind({ messageArchive }).messageArchive.use;
  }

  it('子任务会话里累计到阈值条任务消息：不计数、不提取，不建出 parent:<父会话> 这个「人」', async () => {
    // 跨会话读的窗口里有群里带消息 id 的真人发言，任务消息随之进了窗口；模型的输出里有发任务的这个「人」
    const parent = `parent:${PARENT}`;
    const llmJson = JSON.stringify({
      persons: [{ platform: 'onebot', userId: parent }],
      entities: [{ refKey: 'w', name: '天气', entityKind: 'topic' }],
      personEntityEdges: [{ personPlatform: 'onebot', personUserId: parent, entityRefKey: 'w', role: 'mentioned' }],
    });
    const { app, mem, service, calls } = await setup(llmJson, {
      readScope: 'same-platform',
      crossSessionMaxAgeMinutes: 0,
    });
    const archive = await withArchive(app);
    await mem.saveMessage(PARENT, mkUserMsg('m1', '30001', '明天去爬山'));
    for (const content of ['查一下明天的天气', '再查一下后天的', '列个出行清单']) {
      const task: IncomingMessage = { content, sessionId: SUB, platform: 'onebot', userId: parent, source: 'subtask' };
      await archive.archiveIncoming(task);
    }
    await new Promise(r => setTimeout(r, 20));

    expect(calls).toHaveLength(0);
    expect((await service.loadAll()).persons.map(p => `${p.platform}:${p.userId}`)).not.toContain(`onebot:${parent}`);
  });

  it.each([
    ['同会话读', 'same-session', true],
    ['跨会话读', 'same-platform', true],
    ['跨会话读降级到同会话', 'same-platform', false],
  ] as const)('%s：提取窗口不含带来源的输入（入群申请通知），真人的话照常在', async (_name, readScope, acrossSessions) => {
    const { app, mem, extractor, calls } = await setup('{}', { readScope, crossSessionMaxAgeMinutes: 0 });
    if (!acrossSessions)
      (mem as { getRecentMessagesAcrossSessions?: unknown }).getRecentMessagesAcrossSessions = undefined;
    const archive = await withArchive(app);
    await mem.saveMessage(PARENT, mkUserMsg('m1', '30001', '<真人的话>'));
    const notice: IncomingMessage = {
      content: '<入群申请>',
      sessionId: PARENT,
      platform: 'onebot',
      userId: '30009',
      source: 'onebot-request',
    };
    await archive.archiveIncoming(notice);
    await extractNow(extractor, PARENT);

    expect(calls).toHaveLength(1);
    const prompt = JSON.stringify(calls[0].messages);
    expect(prompt).toContain('<真人的话>');
    expect(prompt).not.toContain('<入群申请>');
  });
});
