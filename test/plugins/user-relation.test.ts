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
});
