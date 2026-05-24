import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import {
  type EvidenceRef,
  type PersonEventEdge,
  type PersonPersonEdge,
  RelationService,
  RelationStore,
} from '../../packages/plugin-user-relation/src/index.js';
import {
  clamp01,
  isEvidenceFullyCovered,
  isSymmetricRelation,
  normalizeRelationType,
  reinforceWeight,
  trimEvidence,
} from '../../packages/plugin-user-relation/src/service.js';
import { edgeKey, eventKey, personKey, RELATION_NAMESPACE } from '../../packages/plugin-user-relation/src/store.js';

async function makeService() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(memoryInMemoryModule);
  const mem = app.ctx.getService<MemoryService>('memory');
  if (!mem) throw new Error('memory service missing');
  const store = new RelationStore(mem);
  return { app, mem, store, service: new RelationService(store) };
}

const ev = (overrides: Partial<EvidenceRef> = {}): EvidenceRef => ({
  sessionId: 'sess1',
  messageIds: ['m1'],
  quote: 'hello',
  extractedAt: overrides.extractedAt ?? Date.now(),
  ...overrides,
});

describe('plugin-user-relation: key encoding', () => {
  it('encodes person/event/edge keys with type prefixes', () => {
    expect(personKey('onebot', '123')).toBe('person:onebot:123');
    expect(eventKey('uuid-1')).toBe('event:uuid-1');
    expect(edgeKey('uuid-2')).toBe('edge:uuid-2');
    expect(RELATION_NAMESPACE).toBe('user-relation');
  });
});

describe('plugin-user-relation: store error when metadata missing', () => {
  it('throws when memory service lacks metadata capability', () => {
    const fakeMemory = {
      saveMessage: async () => {},
      getHistory: async () => [],
    } as unknown as MemoryService;
    expect(() => new RelationStore(fakeMemory)).toThrowError(/metadata/);
  });
});

describe('plugin-user-relation: person CRUD', () => {
  it('observePerson creates then updates lastSeenAt', async () => {
    const { service } = await makeService();
    const a = await service.observePerson('onebot', 'u1', 'Alice');
    expect(a.id).toBe('onebot:u1');
    expect(a.displayName).toBe('Alice');
    expect(a.firstSeenAt).toBeGreaterThan(0);

    await new Promise(r => setTimeout(r, 2));
    const b = await service.observePerson('onebot', 'u1');
    expect(b.id).toBe('onebot:u1');
    expect(b.firstSeenAt).toBe(a.firstSeenAt);
    expect(b.lastSeenAt).toBeGreaterThanOrEqual(a.lastSeenAt);
    expect(b.displayName).toBe('Alice'); // 不传 displayName 时保留旧值
  });
});

describe('plugin-user-relation: event lifecycle', () => {
  it('createEvent + reinforceEvent merges evidence and updates fields', async () => {
    const { service } = await makeService();
    const e1 = await service.createEvent({
      title: '讨论 BWS 直播',
      summary: '群友讨论某次直播表现',
      category: 'discussion',
      evidence: [ev({ messageIds: ['m1'] })],
    });
    expect(e1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e1.evidence).toHaveLength(1);

    const e2 = await service.reinforceEvent(e1.id, {
      summary: '更新后的摘要',
      evidence: [ev({ messageIds: ['m2'], extractedAt: e1.firstSeenAt + 100 })],
    });
    expect(e2).toBeDefined();
    expect(e2!.summary).toBe('更新后的摘要');
    expect(e2!.title).toBe('讨论 BWS 直播'); // 未传 title 时保留
    expect(e2!.evidence).toHaveLength(2);
    expect(e2!.lastReinforcedAt).toBeGreaterThanOrEqual(e1.lastReinforcedAt);
  });

  it('reinforceEvent returns undefined for unknown event', async () => {
    const { service } = await makeService();
    const result = await service.reinforceEvent('nonexistent', {});
    expect(result).toBeUndefined();
  });
});

describe('plugin-user-relation: person-event edges', () => {
  it('idempotently adds and reinforces same (person, event, role)', async () => {
    const { service } = await makeService();
    const event = await service.createEvent({ title: 'foo', evidence: [ev()] });
    const e1 = await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: event.id,
      role: 'participant',
      weight: 0.5,
      evidence: [ev({ messageIds: ['m1'] })],
    });
    const e2 = await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: event.id,
      role: 'participant',
      weight: 0.2,
      evidence: [ev({ messageIds: ['m2'] })],
    });
    expect(e2.id).toBe(e1.id); // 同一条边被强化
    expect(e2.weight).toBeGreaterThan(e1.weight); // weight 应被强化
    expect(e2.evidence).toHaveLength(2);

    // 同人同事件但不同 role → 独立的边
    const eDifferentRole = await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: event.id,
      role: 'target',
    });
    expect(eDifferentRole.id).not.toBe(e1.id);
  });
});

describe('plugin-user-relation: person-person edges', () => {
  it('directed=false (explicit) merges both directions into one edge', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    const e1 = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'friend',
      directed: false,
    });
    expect((e1 as PersonPersonEdge).directed).toBe(false);

    const e2 = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:b',
      toPersonId: 'onebot:a',
      relationType: 'friend',
      directed: false,
    });
    expect(e2.id).toBe(e1.id); // 对称：方向反过来命中同一条
  });

  it('person-person edges default to directed=true (single-direction declaration)', async () => {
    // 默认语义变为单向：A 说「和 B 是朋友」不代表 B 也认同。
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    const a2b = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'friend',
    });
    expect(a2b.directed).toBe(true);

    const b2a = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:b',
      toPersonId: 'onebot:a',
      relationType: 'friend',
    });
    expect(b2a.id).not.toBe(a2b.id); // 默认有向 → 反方向是独立边
  });

  it('directed relation keeps direction distinct', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    const a2b = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'mentor',
    });
    expect(a2b.directed).toBe(true);

    const b2a = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:b',
      toPersonId: 'onebot:a',
      relationType: 'mentor',
    });
    expect(b2a.id).not.toBe(a2b.id); // 有向：反方向是新边
  });

  it('normalizes synonyms before storage', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    const edge = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'Best Friend',
    });
    expect((edge as PersonPersonEdge).relationType).toBe('friend');
  });

  it('rejects edge when toPersonId does not exist as PersonNode (anti-orphan)', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await expect(
      service.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:ghost',
        relationType: 'friend',
      }),
    ).rejects.toThrow(/不存在/);
  });
});

describe('plugin-user-relation: cascade delete', () => {
  it('deletePerson removes all related edges', async () => {
    const { service, store } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    const event = await service.createEvent({ title: 't', evidence: [ev()] });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:a',
      toEventId: event.id,
      role: 'participant',
    });
    await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'friend',
    });
    // 不涉及 a 的边
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:b',
      toEventId: event.id,
      role: 'witness',
    });

    const result = await service.deletePerson('onebot', 'a');
    expect(result.deletedEdges).toBe(2);

    const snapshot = await store.loadAll();
    expect(snapshot.persons.find(p => p.id === 'onebot:a')).toBeUndefined();
    expect(snapshot.persons.find(p => p.id === 'onebot:b')).toBeDefined();
    // 仅剩 b 参与的那条 person-event 边
    expect(snapshot.edges).toHaveLength(1);
    expect((snapshot.edges[0] as PersonEventEdge).fromPersonId).toBe('onebot:b');
  });

  it('deleteEvent removes person-event edges pointing to it', async () => {
    const { service, store } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    const event = await service.createEvent({ title: 't', evidence: [ev()] });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:a',
      toEventId: event.id,
      role: 'participant',
    });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:b',
      toEventId: event.id,
      role: 'witness',
    });
    await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'friend',
    });

    const result = await service.deleteEvent(event.id);
    expect(result.deletedEdges).toBe(2);

    const snapshot = await store.loadAll();
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.edges).toHaveLength(1); // 仅剩人-人边
  });
});

describe('plugin-user-relation: snapshot + neighborhood', () => {
  it('loadAll returns persons/events/edges separated by key prefix', async () => {
    const { service, store } = await makeService();
    await service.observePerson('onebot', 'a');
    const ev1 = await service.createEvent({ title: 'e1', evidence: [ev()] });
    await service.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev1.id, role: 'initiator' });
    const snap = await store.loadAll();
    expect(snap.persons).toHaveLength(1);
    expect(snap.events).toHaveLength(1);
    expect(snap.edges).toHaveLength(1);
  });

  it('getNeighborhood returns events the person participates in', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    const ev1 = await service.createEvent({ title: 'e1', evidence: [ev()] });
    const ev2 = await service.createEvent({ title: 'e2', evidence: [ev()] });
    await service.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev1.id, role: 'participant' });
    await service.addPersonEventEdge({ fromPersonId: 'onebot:b', toEventId: ev2.id, role: 'participant' });

    const nb = await service.getNeighborhood('onebot:a');
    expect(nb.person?.id).toBe('onebot:a');
    expect(nb.events.map(e => e.id)).toEqual([ev1.id]);
    expect(nb.edges).toHaveLength(1);
  });
});

describe('plugin-user-relation: helpers', () => {
  it('reinforceWeight converges toward 1 without overshooting', () => {
    expect(reinforceWeight(0, 0.5)).toBeCloseTo(0.5);
    expect(reinforceWeight(0.5, 0.5)).toBeCloseTo(0.75);
    expect(reinforceWeight(0.99, 0.5)).toBeLessThan(1);
  });

  it('clamp01 clamps invalid / out-of-range values', () => {
    expect(clamp01(-0.1)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(0.3)).toBe(0.3);
  });

  it('trimEvidence keeps most recent N entries by extractedAt', () => {
    const list: EvidenceRef[] = Array.from({ length: 15 }, (_, i) =>
      ev({ extractedAt: i * 10, messageIds: [`m${i}`] }),
    );
    const trimmed = trimEvidence(list);
    expect(trimmed).toHaveLength(10);
    // 最大的 extractedAt 应被保留
    expect(trimmed[0].extractedAt).toBe(140);
  });

  it('normalizeRelationType collapses synonyms', () => {
    expect(normalizeRelationType('Best Friend')).toBe('friend');
    expect(normalizeRelationType('TEACHER')).toBe('mentor');
    expect(normalizeRelationType('senpai')).toBe('senpai'); // 未知词原样保留（lowercased）
  });

  it('isSymmetricRelation recognizes symmetric vs directed', () => {
    expect(isSymmetricRelation('friend')).toBe(true);
    expect(isSymmetricRelation('cp')).toBe(true);
    expect(isSymmetricRelation('mentor')).toBe(false);
    expect(isSymmetricRelation('admirer')).toBe(false);
  });

  it('trimEvidence dedup by sessionId + messageIds key', () => {
    const list: EvidenceRef[] = [
      ev({ sessionId: 's1', messageIds: ['m1'], extractedAt: 100 }),
      ev({ sessionId: 's1', messageIds: ['m1'], extractedAt: 200 }), // 重复
      ev({ sessionId: 's1', messageIds: ['m2', 'm3'], extractedAt: 300 }),
      ev({ sessionId: 's1', messageIds: ['m3', 'm2'], extractedAt: 400 }), // 顺序不同但 sorted 后相同 → 重复
      ev({ sessionId: 's2', messageIds: ['m1'], extractedAt: 500 }), // 不同 session
    ];
    const trimmed = trimEvidence(list);
    expect(trimmed).toHaveLength(3);
    // 按 extractedAt DESC 保留 + 取首次出现 → 500, 400, 200
    expect(trimmed.map(e => e.extractedAt)).toEqual([500, 400, 200]);
  });

  it('isEvidenceFullyCovered detects fully-covered batch', () => {
    const existing: EvidenceRef[] = [
      ev({ sessionId: 's1', messageIds: ['m1'] }),
      ev({ sessionId: 's1', messageIds: ['m2'] }),
    ];
    expect(isEvidenceFullyCovered([ev({ sessionId: 's1', messageIds: ['m1'] })], existing)).toBe(true);
    expect(isEvidenceFullyCovered([ev({ sessionId: 's1', messageIds: ['m3'] })], existing)).toBe(false);
    expect(isEvidenceFullyCovered([], existing)).toBe(false); // 空 incoming 不算覆盖
  });
});

describe('plugin-user-relation: edge dedup vs double-write', () => {
  it('addPersonEntityEdge with identical evidence batch does NOT double-reinforce weight', async () => {
    const { service } = await makeService();
    const entity = await service.createEntity({ name: 'd', entityKind: 'work', evidence: [] });
    const evRef = ev({ sessionId: 's1', messageIds: ['m1'], extractedAt: 1000 });
    const e1 = await service.addPersonEntityEdge({
      fromPersonId: 'onebot:u1',
      toEntityId: entity.id,
      role: 'enthusiast',
      weight: 0.5,
      evidence: [evRef],
    });
    // 模拟"agent 与 extractor 看到同一条消息后各写一次"——同 messageId
    const e2 = await service.addPersonEntityEdge({
      fromPersonId: 'onebot:u1',
      toEntityId: entity.id,
      role: 'enthusiast',
      weight: 0.5,
      evidence: [evRef],
    });
    expect(e2.id).toBe(e1.id);
    expect(e2.weight).toBe(e1.weight); // 未重复强化
    expect(e2.evidence).toHaveLength(1); // 未重复堆积
  });

  it('addPersonEntityEdge still reinforces when evidence is different (new message)', async () => {
    const { service } = await makeService();
    const entity = await service.createEntity({ name: 'd', entityKind: 'work', evidence: [] });
    const e1 = await service.addPersonEntityEdge({
      fromPersonId: 'onebot:u1',
      toEntityId: entity.id,
      role: 'enthusiast',
      weight: 0.5,
      evidence: [ev({ messageIds: ['m1'] })],
    });
    const e2 = await service.addPersonEntityEdge({
      fromPersonId: 'onebot:u1',
      toEntityId: entity.id,
      role: 'enthusiast',
      weight: 0.5,
      evidence: [ev({ messageIds: ['m2'] })],
    });
    expect(e2.id).toBe(e1.id);
    expect(e2.weight).toBeGreaterThan(e1.weight); // 新证据 → 仍强化
    expect(e2.evidence).toHaveLength(2);
  });
});

describe('plugin-user-relation: node dedup on create', () => {
  it('createEvent with same normalized title merges into existing event', async () => {
    const { service } = await makeService();
    const e1 = await service.createEvent({
      title: ' 讨论 BWS 直播 ',
      evidence: [ev({ messageIds: ['m1'] })],
    });
    await new Promise(r => setTimeout(r, 2));
    const e2 = await service.createEvent({
      title: '讨论  BWS  直播', // 大小写/空白差异
      evidence: [ev({ messageIds: ['m2'] })],
    });
    expect(e2.id).toBe(e1.id); // 同 id
    expect(e2.evidence.length).toBe(2);
    expect((e2.occurrences ?? []).length).toBe(2);
    expect(e2.weight).toBeGreaterThan(0.5); // 权重已 +0.3
    expect(e2.lastReinforcedAt).toBeGreaterThanOrEqual(e1.lastReinforcedAt);
  });

  it('createEntity with same (kind, name) merges into existing entity', async () => {
    const { service } = await makeService();
    const ent1 = await service.createEntity({
      name: '三角洲',
      entityKind: 'work',
      aliases: ['Delta Force'],
      evidence: [ev({ messageIds: ['m1'] })],
    });
    const ent2 = await service.createEntity({
      name: '三角洲',
      entityKind: 'work',
      aliases: ['DF', '三角洲'],
      evidence: [ev({ messageIds: ['m2'] })],
    });
    expect(ent2.id).toBe(ent1.id);
    expect(ent2.aliases).toEqual(expect.arrayContaining(['Delta Force', 'DF']));
    expect(ent2.evidence.length).toBe(2);
    expect(ent2.weight).toBeGreaterThan(0.5);
  });

  it('createEntity with same name but different kind does NOT merge', async () => {
    const { service } = await makeService();
    const a = await service.createEntity({ name: '北京', entityKind: 'place', evidence: [] });
    const b = await service.createEntity({ name: '北京', entityKind: 'work', evidence: [] });
    expect(b.id).not.toBe(a.id);
  });

  it('findEventByTitle / findEntityByKindAndName helpers', async () => {
    const { service } = await makeService();
    const e = await service.createEvent({ title: '里程碑事件', evidence: [] });
    expect((await service.findEventByTitle('里程碑事件'))?.id).toBe(e.id);
    expect(await service.findEventByTitle('不存在')).toBeUndefined();

    const ent = await service.createEntity({ name: 'X', entityKind: 'topic', evidence: [] });
    expect((await service.findEntityByKindAndName('topic', 'X'))?.id).toBe(ent.id);
    expect(await service.findEntityByKindAndName('place', 'X')).toBeUndefined();
  });
});

describe('plugin-user-relation: evictByQuota', () => {
  it('removes orphan event/entity unconditionally', async () => {
    const { service } = await makeService();
    const orphan = await service.createEvent({ title: 'orphan-evt', evidence: [] });
    const orphanEnt = await service.createEntity({ name: 'orphan-ent', entityKind: 'topic', evidence: [] });
    // 给 orphan2 挂一条边，使其不再是孤儿
    const linked = await service.createEvent({ title: 'linked-evt', evidence: [] });
    await service.observePerson('onebot', 'u1');
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: linked.id,
      role: 'participant',
      evidence: [ev()],
    });

    const result = await service.evictByQuota({
      maxEvents: 0,
      maxEntities: 0,
      maxEdges: 0,
    });
    expect(result.deletedEvents).toBe(1);
    expect(result.deletedEntities).toBe(1);
    const snap = await service.loadAll();
    expect(snap.events.find(e => e.id === orphan.id)).toBeUndefined();
    expect(snap.events.find(e => e.id === linked.id)).toBeDefined();
    expect(snap.entities.find(e => e.id === orphanEnt.id)).toBeUndefined();
  });

  it('respects protection: high-weight or rich-evidence nodes are kept', async () => {
    const { service } = await makeService();
    const protectedEvent = await service.createEvent({
      title: 'important',
      evidence: [ev({ messageIds: ['m1'] }), ev({ messageIds: ['m2'] }), ev({ messageIds: ['m3'] })],
    });
    // 该节点 evidence=3 → 受保护，即使是孤儿也不删
    const result = await service.evictByQuota({ maxEvents: 0, maxEntities: 0, maxEdges: 0 });
    expect(result.deletedEvents).toBe(0);
    const snap = await service.loadAll();
    expect(snap.events.find(e => e.id === protectedEvent.id)).toBeDefined();
  });

  it('enforces quota by removing oldest+lowest-weight nodes first', async () => {
    const { service } = await makeService();
    // 创建 5 个有边的事件（不是孤儿）
    await service.observePerson('onebot', 'u1');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await service.createEvent({ title: `evt-${i}`, evidence: [] });
      ids.push(e.id);
      await service.addPersonEventEdge({
        fromPersonId: 'onebot:u1',
        toEventId: e.id,
        role: 'participant',
        evidence: [ev()],
      });
      await new Promise(r => setTimeout(r, 1));
    }
    const result = await service.evictByQuota({ maxEvents: 3, maxEntities: 0, maxEdges: 0 });
    expect(result.deletedEvents).toBe(2);
    const snap = await service.loadAll();
    expect(snap.events.length).toBe(3);
    // 老的两个先删
    expect(snap.events.find(e => e.id === ids[0])).toBeUndefined();
    expect(snap.events.find(e => e.id === ids[1])).toBeUndefined();
  });
});
