import { describe, expect, it, vi } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import { type EvidenceRef, RelationService, RelationStore } from '../../packages/plugin-user-relation/src/index.js';

async function makeService() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  // biome-ignore lint/suspicious/noExplicitAny: src/dist 类型路径差异
  await app.ctx.useModule(memoryInMemoryModule as any);
  const mem = app.ctx.getService<MemoryService>('memory');
  if (!mem) throw new Error('memory service missing');
  const store = new RelationStore(mem);
  return { app, store, service: new RelationService(store) };
}

const ev = (overrides: Partial<EvidenceRef> = {}): EvidenceRef => ({
  sessionId: 'sessA',
  messageIds: ['m1'],
  quote: 'hello',
  extractedAt: Date.now(),
  ...overrides,
});

describe('user-relation: event sessionScope 隔离', () => {
  it('同 title 不同 session 视为不同事件', async () => {
    const { service } = await makeService();
    const a = await service.createEvent({ title: '约定下周聚餐', evidence: [ev({ sessionId: 'group:1' })] });
    const b = await service.createEvent({ title: '约定下周聚餐', evidence: [ev({ sessionId: 'group:2' })] });
    expect(a.id).not.toBe(b.id);
    expect(a.sessionScope).toBe('group:1');
    expect(b.sessionScope).toBe('group:2');
  });

  it('同 title 同 session 合并', async () => {
    const { service } = await makeService();
    const a = await service.createEvent({ title: '约定下周聚餐', evidence: [ev({ sessionId: 'group:1' })] });
    const b = await service.createEvent({
      title: '约定下周聚餐',
      evidence: [ev({ sessionId: 'group:1', messageIds: ['m2'] })],
    });
    expect(a.id).toBe(b.id);
  });

  it('老数据（无 scope）兼容：与任何 scope 都视为同事件', async () => {
    const { service, store } = await makeService();
    const a = await service.createEvent({ title: 'legacy 事件', evidence: [ev({ sessionId: 'group:1' })] });
    // 模拟老数据：抹掉 sessionScope
    const raw = await store.getEvent(a.id);
    if (raw) {
      delete (raw as { sessionScope?: string }).sessionScope;
      await store.upsertEvent(raw);
    }
    const b = await service.createEvent({ title: 'legacy 事件', evidence: [ev({ sessionId: 'group:2' })] });
    expect(b.id).toBe(a.id);
    // 回填了新 scope
    expect(b.sessionScope).toBe('group:2');
  });

  it("显式 sessionScope='global' 跨 session 合并", async () => {
    const { service } = await makeService();
    const a = await service.createEvent({
      title: '双十一',
      sessionScope: 'global',
      evidence: [ev({ sessionId: 'group:1' })],
    });
    const b = await service.createEvent({
      title: '双十一',
      sessionScope: 'global',
      evidence: [ev({ sessionId: 'group:2' })],
    });
    expect(b.id).toBe(a.id);
    expect(a.sessionScope).toBe('global');
  });

  it("'global' 与具体 sessionId 不合并", async () => {
    const { service } = await makeService();
    const a = await service.createEvent({
      title: '热点',
      sessionScope: 'global',
      evidence: [ev({ sessionId: 'group:1' })],
    });
    const b = await service.createEvent({
      title: '热点',
      evidence: [ev({ sessionId: 'group:1' })],
    });
    expect(a.id).not.toBe(b.id);
    expect(a.sessionScope).toBe('global');
    expect(b.sessionScope).toBe('group:1');
  });

  it("createEvent 未传 sessionScope 且无 evidence sessionId → 回落 'global' + audit", async () => {
    const { service } = await makeService();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await service.createEvent({
      title: '裸事件',
      evidence: [],
    });
    expect(a.sessionScope).toBe('global');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('user-relation: event-event is-alias-of 跨 sessionScope 防护', () => {
  it('两个属于不同 session 的同名事件被 LLM 标 is-alias-of → 降级为 related，不合并', async () => {
    const { service, store } = await makeService();
    const a = await service.createEvent({ title: '聊三角洲', evidence: [ev({ sessionId: 'group:A' })] });
    const b = await service.createEvent({ title: '聊三角洲', evidence: [ev({ sessionId: 'group:B' })] });
    expect(a.id).not.toBe(b.id);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const edge = await service.addEventEventEdge({
      fromEventId: a.id,
      toEventId: b.id,
      relationType: 'is-alias-of',
      evidence: [ev({ sessionId: 'group:A' })],
    });
    // 边被降级
    expect(edge.relationType).toBe('related');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    // 两个 event 仍独立存在（未被 mergeAlias 吞掉）
    expect(await store.getEvent(a.id)).toBeDefined();
    expect(await store.getEvent(b.id)).toBeDefined();
  });

  it('同 session 的两事件 is-alias-of 仍可正常合并', async () => {
    const { service, store } = await makeService();
    const a = await service.createEvent({ title: '约定聚餐', evidence: [ev({ sessionId: 'group:A' })] });
    const b = await service.createEvent({ title: '约定吃饭', evidence: [ev({ sessionId: 'group:A' })] });
    expect(a.id).not.toBe(b.id);
    const edge = await service.addEventEventEdge({
      fromEventId: a.id,
      toEventId: b.id,
      relationType: 'is-alias-of',
      evidence: [ev({ sessionId: 'group:A' })],
    });
    expect(edge.relationType).toBe('is-alias-of');
    // mergeAlias 已被触发：alias 端的非 alias 边被改写到 canonical
    expect(await store.getEvent(b.id)).toBeDefined();
  });

  it('global hub 与 specific scope event 的 is-alias-of 允许（global 表示已显式跨会话）', async () => {
    const { service } = await makeService();
    const hub = await service.createEvent({
      title: '三角洲赛季',
      sessionScope: 'global',
      evidence: [ev({ sessionId: 'group:A' })],
    });
    const child = await service.createEvent({ title: '三角洲赛季', evidence: [ev({ sessionId: 'group:B' })] });
    const edge = await service.addEventEventEdge({
      fromEventId: child.id,
      toEventId: hub.id,
      relationType: 'is-alias-of',
      evidence: [ev({ sessionId: 'group:B' })],
    });
    expect(edge.relationType).toBe('is-alias-of');
  });
});

describe('user-relation: deleteNode 守门', () => {
  it('person 节点禁止删除（id 含冒号）', async () => {
    const { service } = await makeService();
    await service.observePerson('pf', 'u1');
    await expect(service.deleteNode({ kind: 'event', id: 'pf:u1', reason: 'test', by: 'agent' })).rejects.toThrow();
  });

  it('weight ≥ 0.8 的节点禁止删除', async () => {
    const { service, store } = await makeService();
    const e = await service.createEvent({ title: '重要事件', evidence: [ev()] });
    e.weight = 0.85;
    await store.upsertEvent(e);
    await expect(service.deleteNode({ kind: 'event', id: e.id, reason: 'test', by: 'agent' })).rejects.toThrow();
  });

  it('evidence ≥ 5 的节点禁止删除', async () => {
    const { service, store } = await makeService();
    const e = await service.createEvent({ title: '富证据事件', evidence: [ev()] });
    e.evidence = Array.from({ length: 6 }, (_, i) => ev({ messageIds: [`m${i}`] }));
    await store.upsertEvent(e);
    await expect(service.deleteNode({ kind: 'event', id: e.id, reason: 'test', by: 'agent' })).rejects.toThrow();
  });

  it('普通节点可删 + 级联清理边', async () => {
    const { service, store } = await makeService();
    const p = await service.observePerson('pf', 'u1');
    const e = await service.createEvent({ title: '可清理事件', evidence: [ev()] });
    await service.addPersonEventEdge({
      personId: p.id,
      eventId: e.id,
      role: 'participant',
      evidence: [ev()],
    });
    await service.deleteNode({ kind: 'event', id: e.id, reason: 'test', by: 'agent' });
    expect(await store.getEvent(e.id)).toBeUndefined();
    // 级联：相关边被清
    const snap = await store.loadAll();
    expect(
      snap.edges.find(x => {
        const e2 = x as { to?: string; toId?: string };
        return (e2.to ?? e2.toId) === e.id;
      }),
    ).toBeUndefined();
  });
});

describe('user-relation: changeEntityKind', () => {
  it('切换 entityKind 字段', async () => {
    const { service, store } = await makeService();
    const ent = await service.createEntity({ name: '玩具', entityKind: 'thing', evidence: [ev()] });
    await service.changeEntityKind({ entityId: ent.id, newKind: 'work', reason: 'reclassify', by: 'agent' });
    const after = await store.getEntity(ent.id);
    expect(after?.entityKind).toBe('work');
  });
});

describe('user-relation: computeNodeScore', () => {
  it('不存在节点返回 null', async () => {
    const { service } = await makeService();
    expect(await service.computeNodeScore('nope:nope')).toBeNull();
  });

  it('event 节点返回完整结构', async () => {
    const { service } = await makeService();
    const e = await service.createEvent({ title: '打分事件', evidence: [ev()] });
    const s = await service.computeNodeScore(e.id);
    expect(s).not.toBeNull();
    expect(s?.kind).toBe('event');
    expect(typeof s?.compositeScore).toBe('number');
    expect(s?.evidenceCount).toBeGreaterThanOrEqual(1);
  });

  it('返回 rank / percentile / tier / pagerankFresh', async () => {
    const { service } = await makeService();
    const e1 = await service.createEvent({ title: '事件A', evidence: [ev()] });
    await service.createEvent({ title: '事件B', evidence: [ev()] });
    await service.createEvent({ title: '事件C', evidence: [ev()] });
    const s = await service.computeNodeScore(e1.id);
    expect(s).not.toBeNull();
    // rank 字符串形如 "k/N"，同 kind 共 3 个 event
    expect(s?.rankInKind).toMatch(/^[1-3]\/3$/);
    expect(s?.rankInGlobal).toMatch(/^[1-3]\/3$/);
    expect(s?.percentileInKind).toBeGreaterThanOrEqual(0);
    expect(s?.percentileInKind).toBeLessThanOrEqual(1);
    expect(['core', 'active', 'normal', 'edge']).toContain(s?.tier);
    // 从未跑过 PR job → pagerankFresh=false
    expect(s?.pagerankFresh).toBe(false);
  });
});

describe('user-relation: computeDirectionalDegree', () => {
  it('不存在节点返回 null', async () => {
    const { service } = await makeService();
    expect(await service.computeDirectionalDegree('nope:nope')).toBeNull();
  });

  it('admirer 入度多 → fan-idol verdict = idol-leaning, dominance=incoming', async () => {
    const { service } = await makeService();
    const idol = await service.observePerson('pf', 'star');
    const fan1 = await service.observePerson('pf', 'f1');
    const fan2 = await service.observePerson('pf', 'f2');
    const fan3 = await service.observePerson('pf', 'f3');
    for (const f of [fan1, fan2, fan3]) {
      await service.addPersonPersonEdge({
        fromPersonId: f.id,
        toPersonId: idol.id,
        relationType: 'admirer',
        evidence: [ev()],
      });
    }
    const r = await service.computeDirectionalDegree(idol.id);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe('person');
    expect(r?.inTotal).toBe(3);
    expect(r?.outTotal).toBe(0);
    expect(r?.inByType.admirer?.count).toBe(3);
    expect(r?.dominance).toBe('incoming');
    expect(r?.fanIdolHint.fansCount).toBe(3);
    expect(r?.fanIdolHint.idolsCount).toBe(0);
    expect(r?.fanIdolHint.verdict).toBe('idol-leaning');
  });

  it('admirer 出度多 → verdict = fan-leaning, dominance=outgoing', async () => {
    const { service } = await makeService();
    const fan = await service.observePerson('pf', 'fan');
    const idolA = await service.observePerson('pf', 'idolA');
    const idolB = await service.observePerson('pf', 'idolB');
    const idolC = await service.observePerson('pf', 'idolC');
    for (const i of [idolA, idolB, idolC]) {
      await service.addPersonPersonEdge({
        fromPersonId: fan.id,
        toPersonId: i.id,
        relationType: 'admirer',
        evidence: [ev()],
      });
    }
    const r = await service.computeDirectionalDegree(fan.id);
    expect(r?.outTotal).toBe(3);
    expect(r?.inTotal).toBe(0);
    expect(r?.dominance).toBe('outgoing');
    expect(r?.fanIdolHint.idolsCount).toBe(3);
    expect(r?.fanIdolHint.verdict).toBe('fan-leaning');
  });

  it('对称无向边（friend directed=false）不计入 in/out 剖面', async () => {
    const { service } = await makeService();
    const a = await service.observePerson('pf', 'a');
    const b = await service.observePerson('pf', 'b');
    await service.addPersonPersonEdge({
      fromPersonId: a.id,
      toPersonId: b.id,
      relationType: 'friend',
      directed: false,
      evidence: [ev()],
    });
    const r = await service.computeDirectionalDegree(a.id);
    expect(r?.outTotal).toBe(0);
    expect(r?.inTotal).toBe(0);
    expect(r?.dominance).toBe('balanced');
    expect(r?.fanIdolHint.verdict).toBe('none');
  });

  it('桥型边（person-event）不计入有向剖面', async () => {
    const { service } = await makeService();
    const p = await service.observePerson('pf', 'p');
    const e1 = await service.createEvent({ title: '事件1', evidence: [ev()] });
    await service.addPersonEventEdge({
      fromPersonId: p.id,
      toEventId: e1.id,
      role: 'initiator',
      evidence: [ev()],
    });
    const r = await service.computeDirectionalDegree(p.id);
    expect(r?.outTotal).toBe(0);
    expect(r?.inTotal).toBe(0);
  });

  it('event 节点：caused-by 入度反映 sink 性质', async () => {
    const { service } = await makeService();
    const cause = await service.createEvent({ title: '起因事件', evidence: [ev()] });
    const sink = await service.createEvent({ title: '结果事件', evidence: [ev()] });
    await service.addEventEventEdge({
      fromEventId: cause.id,
      toEventId: sink.id,
      relationType: 'caused-by',
      evidence: [ev()],
    });
    const r = await service.computeDirectionalDegree(sink.id);
    expect(r?.kind).toBe('event');
    expect(r?.inByType['caused-by']?.count).toBe(1);
    expect(r?.inByType['caused-by']?.top[0]?.otherId).toBe(cause.id);
  });

  it('top_per_type 控制返回 top-K', async () => {
    const { service } = await makeService();
    const idol = await service.observePerson('pf', 'i');
    for (let i = 0; i < 5; i++) {
      const f = await service.observePerson('pf', `fan${i}`);
      await service.addPersonPersonEdge({
        fromPersonId: f.id,
        toPersonId: idol.id,
        relationType: 'admirer',
        evidence: [ev()],
      });
    }
    const r = await service.computeDirectionalDegree(idol.id, { topPerType: 2 });
    expect(r?.inByType.admirer?.count).toBe(5);
    expect(r?.inByType.admirer?.top.length).toBe(2);
  });
});

describe('user-relation: 首次建边默认权按 role/relationType 区分', () => {
  it('person-entity: enthusiast 起始 0.55，mentioned 起始 0.1', async () => {
    const { service } = await makeService();
    const ent = await service.createEntity({ name: '原神', entityKind: 'work', evidence: [ev()] });
    const ent2 = await service.createEntity({ name: '某游戏', entityKind: 'work', evidence: [ev()] });
    const e1 = await service.addPersonEntityEdge({
      fromPersonId: 'onebot:p1',
      toEntityId: ent.id,
      role: 'enthusiast',
      evidence: [ev()],
    });
    const e2 = await service.addPersonEntityEdge({
      fromPersonId: 'onebot:p1',
      toEntityId: ent2.id,
      role: 'mentioned',
      evidence: [ev()],
    });
    expect(e1.weight).toBeCloseTo(0.55, 5);
    expect(e2.weight).toBeCloseTo(0.1, 5);
  });

  it('person-event: initiator 起始 0.5，witness 起始 0.15', async () => {
    const { service } = await makeService();
    const ev1 = await service.createEvent({ title: '开会', evidence: [ev()] });
    const ev2 = await service.createEvent({ title: '路过', evidence: [ev()] });
    const e1 = await service.addPersonEventEdge({
      fromPersonId: 'onebot:p2',
      toEventId: ev1.id,
      role: 'initiator',
      evidence: [ev()],
    });
    const e2 = await service.addPersonEventEdge({
      fromPersonId: 'onebot:p2',
      toEventId: ev2.id,
      role: 'witness',
      evidence: [ev()],
    });
    expect(e1.weight).toBeCloseTo(0.5, 5);
    expect(e2.weight).toBeCloseTo(0.15, 5);
  });

  it('entity-entity: is-alias-of 起始 0.6（强声明），未知关系起始 0.3', async () => {
    const { service } = await makeService();
    const a = await service.createEntity({ name: 'A', entityKind: 'work', evidence: [ev()] });
    const b = await service.createEntity({ name: 'B', entityKind: 'work', evidence: [ev()] });
    const c = await service.createEntity({ name: 'C', entityKind: 'work', evidence: [ev()] });
    const e1 = await service.addEntityEntityEdge({
      fromEntityId: a.id,
      toEntityId: b.id,
      relationType: 'is-alias-of',
      directed: true,
      evidence: [ev()],
    });
    const e2 = await service.addEntityEntityEdge({
      fromEntityId: a.id,
      toEntityId: c.id,
      relationType: 'inspired-by',
      directed: true,
      evidence: [ev()],
    });
    expect(e1.weight).toBeCloseTo(0.6, 5);
    expect(e2.weight).toBeCloseTo(0.3, 5);
  });

  it('显式传 weight 仍然覆盖默认值', async () => {
    const { service } = await makeService();
    const ent = await service.createEntity({ name: '某物', entityKind: 'work', evidence: [ev()] });
    const e1 = await service.addPersonEntityEdge({
      fromPersonId: 'onebot:p3',
      toEntityId: ent.id,
      role: 'mentioned',
      weight: 0.9,
      evidence: [ev()],
    });
    expect(e1.weight).toBeCloseTo(0.9, 5);
  });
});
