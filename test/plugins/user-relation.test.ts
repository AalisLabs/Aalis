import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import {
  type EventEntityEdge,
  type EvidenceRef,
  type PersonEventEdge,
  type PersonPersonEdge,
  RelationService,
  RelationStore,
} from '../../packages/plugin-user-relation/src/index.js';
import { edgeKey, eventKey, personKey, RELATION_NAMESPACE } from '../../packages/plugin-user-relation/src/store.js';
import type { RelationGraphSnapshot } from '../../packages/plugin-user-relation/src/types.js';
import {
  clamp01,
  clusterEntitiesByPairs,
  computeEntityEdgeStats,
  computePageRank,
  isEvidenceFullyCovered,
  isSymmetricRelation,
  normalizeRelationType,
  pickCanonicalByMergeScore,
  reinforceWeight,
  trimEvidence,
} from '../../packages/plugin-user-relation/src/utils.js';

async function makeService() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  // biome-ignore lint/suspicious/noExplicitAny: src 与 dist 的 PluginModule 类型路径不同，运行时结构等价
  await app.ctx.useModule(memoryInMemoryModule as any);
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

describe('plugin-user-relation: syncDisplayName (platform rename)', () => {
  it('renames existing person without touching mention counters', async () => {
    const { service, store } = await makeService();
    const a = await service.observePerson('onebot', 'u1', 'Alice');
    expect(a.mentionCount).toBe(1);

    await new Promise(r => setTimeout(r, 2));
    const changed = await service.syncDisplayName('onebot', 'u1', 'Alicia');
    expect(changed).toBe(true);

    const after = await store.getPerson('onebot', 'u1');
    expect(after?.displayName).toBe('Alicia');
    expect(after?.mentionCount).toBe(1); // 未递增
    expect(after?.firstSeenAt).toBe(a.firstSeenAt); // 保留
    expect(after?.lastSeenAt).toBeGreaterThanOrEqual(a.lastSeenAt);
  });

  it('no-op when displayName unchanged', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'u1', 'Alice');
    const changed = await service.syncDisplayName('onebot', 'u1', 'Alice');
    expect(changed).toBe(false);
  });

  it('does not create a new person if missing (avoid lurker ghosts)', async () => {
    const { service, store } = await makeService();
    const changed = await service.syncDisplayName('onebot', 'u-never-seen', 'Ghost');
    expect(changed).toBe(false);
    const got = await store.getPerson('onebot', 'u-never-seen');
    expect(got).toBeUndefined();
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

    // 同人同事件但更强 role (target rank=3 < participant rank=4) → 合并到原边，role 保持 participant
    const eWeakerRole = await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: event.id,
      role: 'witness', // 比 participant 弱
    });
    expect(eWeakerRole.id).toBe(e1.id);
    expect(eWeakerRole.role).toBe('participant'); // 保留最强 role

    // 更强 role (initiator rank=5 > participant rank=4) → 升级
    const eStrongerRole = await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: event.id,
      role: 'initiator',
    });
    expect(eStrongerRole.id).toBe(e1.id);
    expect(eStrongerRole.role).toBe('initiator'); // 升级到 initiator
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

  it('familiar placeholder is auto-superseded by any identity relation (same dyad)', async () => {
    // familiar 是行为观察占位标签；当同一对人之间出现 friend/cp/mentor 等身份关系时，
    // 旧 familiar 边应被自动删除，避免视觉冗余。
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    const fam = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'familiar',
    });
    // 反方向也建一条 familiar，验证两个方向都会被废除
    const famRev = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:b',
      toPersonId: 'onebot:a',
      relationType: 'familiar',
    });
    const friend = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'friend',
    });
    const snap = await service.loadAll();
    const ids = snap.edges.map(e => e.id);
    expect(ids).not.toContain(fam.id);
    expect(ids).not.toContain(famRev.id);
    expect(ids).toContain(friend.id);
  });

  it('does NOT remove familiar between OTHER dyads (only same pair is affected)', async () => {
    // 防回归：familiar 占位废除应仅对**同一对人**生效，不能误伤其他对人的 familiar。
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    await service.observePerson('onebot', 'c');
    const famAC = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:c',
      relationType: 'familiar',
    });
    await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'friend',
    });
    const snap = await service.loadAll();
    expect(snap.edges.some(e => e.id === famAC.id)).toBe(true);
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

  it('trimEvidence dedup by sessionId + messageIds key (no quote / different quotes)', () => {
    // 使用不同 quote 让 quote-key 失效，回退到 messageIds-key 兜底
    const list: EvidenceRef[] = [
      ev({ sessionId: 's1', messageIds: ['m1'], quote: 'a', extractedAt: 100 }),
      ev({ sessionId: 's1', messageIds: ['m1'], quote: 'a', extractedAt: 200 }), // quote+msg 双重重复
      ev({ sessionId: 's1', messageIds: ['m2', 'm3'], quote: 'b', extractedAt: 300 }),
      ev({ sessionId: 's1', messageIds: ['m3', 'm2'], quote: 'b', extractedAt: 400 }), // sorted msg 相同 → 重复
      ev({ sessionId: 's2', messageIds: ['m1'], quote: 'a', extractedAt: 500 }), // 不同 session
    ];
    const trimmed = trimEvidence(list);
    expect(trimmed).toHaveLength(3);
    expect(trimmed.map(e => e.extractedAt)).toEqual([500, 400, 200]);
  });

  it('trimEvidence merges entries with same sessionId + quote even when messageIds differ', () => {
    // 关键回归：滑动窗口导致同一句被抽到不同 messageIds 集合，旧逻辑下会保留两条。
    // 新逻辑按 sessionId|quote 合并：messageIds 取并集，extractedAt 取较新者。
    const list: EvidenceRef[] = [
      ev({ sessionId: 's1', messageIds: ['m1'], quote: '同一句原话', extractedAt: 100 }),
      ev({ sessionId: 's1', messageIds: ['m1', 'm2'], quote: '同一句原话', extractedAt: 200 }),
    ];
    const trimmed = trimEvidence(list);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].extractedAt).toBe(200);
    expect([...trimmed[0].messageIds].sort()).toEqual(['m1', 'm2']);
  });

  it('isEvidenceFullyCovered detects fully-covered batch', () => {
    const existing: EvidenceRef[] = [
      ev({ sessionId: 's1', messageIds: ['m1'], quote: 'a' }),
      ev({ sessionId: 's1', messageIds: ['m2'], quote: 'b' }),
    ];
    expect(isEvidenceFullyCovered([ev({ sessionId: 's1', messageIds: ['m1'], quote: 'a' })], existing)).toBe(true);
    expect(isEvidenceFullyCovered([ev({ sessionId: 's1', messageIds: ['m3'], quote: 'c' })], existing)).toBe(false);
    expect(isEvidenceFullyCovered([], existing)).toBe(false); // 空 incoming 不算覆盖
    // quote-key 覆盖：同 sessionId+quote 且 messageIds 有交集 → 视为已覆盖
    expect(isEvidenceFullyCovered([ev({ sessionId: 's1', messageIds: ['m1', 'm9'], quote: 'a' })], existing)).toBe(
      true,
    );
    // 同 quote 但 messageIds 完全不相交 → 不算覆盖（可能是不同时段的独立陈述）
    expect(isEvidenceFullyCovered([ev({ sessionId: 's1', messageIds: ['m9'], quote: 'a' })], existing)).toBe(false);
  });
});

describe('plugin-user-relation: clusterEntitiesByPairs', () => {
  it('合并传递闭包：A↔B, B↔C → 一簇 {A,B,C}', () => {
    const clusters = clusterEntitiesByPairs([
      { aId: 'A', bId: 'B' },
      { aId: 'B', bId: 'C' },
    ]);
    expect(clusters.size).toBe(1);
    const members = [...clusters.values()][0];
    expect(members).toEqual(new Set(['A', 'B', 'C']));
  });

  it('独立 pair 不合并：A↔B, C↔D → 两簇', () => {
    const clusters = clusterEntitiesByPairs([
      { aId: 'A', bId: 'B' },
      { aId: 'C', bId: 'D' },
    ]);
    expect(clusters.size).toBe(2);
    const setsBySize = [...clusters.values()].map(s => [...s].sort().join(','));
    expect(setsBySize.sort()).toEqual(['A,B', 'C,D']);
  });

  it('空输入 → 空 Map', () => {
    expect(clusterEntitiesByPairs([]).size).toBe(0);
  });

  it('幂等：重复 pair 不影响簇结构', () => {
    const clusters = clusterEntitiesByPairs([
      { aId: 'A', bId: 'B' },
      { aId: 'A', bId: 'B' },
      { aId: 'B', bId: 'A' },
    ]);
    expect(clusters.size).toBe(1);
    expect([...clusters.values()][0]).toEqual(new Set(['A', 'B']));
  });
});

describe('plugin-user-relation: pickCanonicalByMergeScore', () => {
  const mkNode = (id: string, evidenceCount = 0) => ({
    id,
    entityKind: 'topic' as const,
    name: id,
    firstSeenAt: 0,
    lastReinforcedAt: 0,
    evidence: Array.from({ length: evidenceCount }, () => ev({})),
  });

  it('挑边/权信息更丰富者：weight 更高的胜出', () => {
    const members = new Set(['A', 'B']);
    const nodes = new Map([
      ['A', mkNode('A')],
      ['B', mkNode('B')],
    ]);
    const stats = new Map([
      ['A', { weightSum: 0.2, edgeCount: 1 }],
      ['B', { weightSum: 0.9, edgeCount: 1 }],
    ]);
    expect(pickCanonicalByMergeScore(members, nodes, stats)).toBe('B');
  });

  it('edge 数更多者胜（权相同）', () => {
    const members = new Set(['A', 'B']);
    const nodes = new Map([
      ['A', mkNode('A')],
      ['B', mkNode('B')],
    ]);
    const stats = new Map([
      ['A', { weightSum: 0.5, edgeCount: 1 }],
      ['B', { weightSum: 0.5, edgeCount: 5 }],
    ]);
    expect(pickCanonicalByMergeScore(members, nodes, stats)).toBe('B');
  });

  it('evidence 多者胜（权/边均相同）', () => {
    const members = new Set(['A', 'B']);
    const nodes = new Map([
      ['A', mkNode('A', 1)],
      ['B', mkNode('B', 10)],
    ]);
    const stats = new Map([
      ['A', { weightSum: 0.5, edgeCount: 2 }],
      ['B', { weightSum: 0.5, edgeCount: 2 }],
    ]);
    expect(pickCanonicalByMergeScore(members, nodes, stats)).toBe('B');
  });

  it('完全平局：取 id 字典序最小者', () => {
    const members = new Set(['zeta', 'alpha', 'mid']);
    const nodes = new Map([
      ['zeta', mkNode('zeta')],
      ['alpha', mkNode('alpha')],
      ['mid', mkNode('mid')],
    ]);
    const stats = new Map<string, { weightSum: number; edgeCount: number }>();
    expect(pickCanonicalByMergeScore(members, nodes, stats)).toBe('alpha');
  });

  it('空簇 → 返回空串（safety）', () => {
    expect(pickCanonicalByMergeScore(new Set(), new Map(), new Map())).toBe('');
  });
});

describe('plugin-user-relation: computeEntityEdgeStats', () => {
  it('entity-entity 边两端均计入；person-entity / event-entity 只 entity 端计入', () => {
    const now = Date.now();
    const stats = computeEntityEdgeStats([
      {
        id: 'e1',
        kind: 'entity-entity',
        fromEntityId: 'A',
        toEntityId: 'B',
        relationType: 'related',
        directed: false,
        weight: 0.4,
        firstSeenAt: now,
        lastReinforcedAt: now,
        evidence: [],
      },
      {
        id: 'e2',
        kind: 'person-entity',
        fromPersonId: 'p1',
        toEntityId: 'A',
        role: 'mentioned',
        weight: 0.3,
        firstSeenAt: now,
        lastReinforcedAt: now,
        evidence: [],
      },
      {
        id: 'e3',
        kind: 'event-entity',
        fromEventId: 'ev1',
        toEntityId: 'B',
        relationType: 'related',
        directed: true,
        weight: 0.5,
        firstSeenAt: now,
        lastReinforcedAt: now,
        evidence: [],
      },
    ]);
    expect(stats.get('A')).toEqual({ weightSum: 0.7, edgeCount: 2 }); // entity-entity 0.4 + person-entity 0.3
    expect(stats.get('B')).toEqual({ weightSum: 0.9, edgeCount: 2 }); // entity-entity 0.4 + event-entity 0.5
    // person/event 节点不计入
    expect(stats.has('p1')).toBe(false);
    expect(stats.has('ev1')).toBe(false);
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

  it('normalizeName: 书名号/全角/大小写 装饰符号都视为同名', async () => {
    const { service } = await makeService();
    // 「《绝航》」与「绝航」与「 绝航 」与「绝航  」（多空格）应归一为同一实体
    const a = await service.createEntity({
      name: '《绝航》',
      entityKind: 'work',
      evidence: [ev({ messageIds: ['m1'] })],
    });
    const b = await service.createEntity({ name: '绝航', entityKind: 'work', evidence: [ev({ messageIds: ['m2'] })] });
    const c = await service.createEntity({
      name: ' 绝航 ',
      entityKind: 'work',
      evidence: [ev({ messageIds: ['m3'] })],
    });
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);

    // 全角英文 vs 半角英文 视为同名
    const d = await service.createEntity({ name: 'ＰＳ５', entityKind: 'thing', evidence: [] });
    const e2 = await service.createEntity({ name: 'PS5', entityKind: 'thing', evidence: [] });
    expect(e2.id).toBe(d.id);

    // findEntityByKindAndName 同样按归一查找
    expect((await service.findEntityByKindAndName('work', '《绝航》'))?.id).toBe(a.id);
    expect((await service.findEntityByKindAndName('work', '绝航'))?.id).toBe(a.id);
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

  it('orphan cleanup is unconditional by default; protection only applies to quota-stage', async () => {
    const { service } = await makeService();
    // evidence=3 的"孤儿"——按 v0 旧契约会被保护，但 v1 默认无保护：孤儿就删
    const richOrphan = await service.createEvent({
      title: 'important-but-orphan',
      evidence: [ev({ messageIds: ['m1'] }), ev({ messageIds: ['m2'] }), ev({ messageIds: ['m3'] })],
    });
    const result = await service.evictByQuota({ maxEvents: 0, maxEntities: 0, maxEdges: 0 });
    expect(result.deletedEvents).toBe(1);
    const snap = await service.loadAll();
    expect(snap.events.find(e => e.id === richOrphan.id)).toBeUndefined();
  });

  it('pruneOrphans 无条件删孤儿，无论 evidence 多少（不再有 opts 保护参数）', async () => {
    const { service } = await makeService();
    // evidence=3 的孤儿——v3 零参数设计中无保护，应被直接删除
    const orphan = await service.createEvent({
      title: 'rich',
      evidence: [ev({ messageIds: ['a'] }), ev({ messageIds: ['b'] }), ev({ messageIds: ['c'] })],
    });
    const r = await service.pruneOrphans();
    expect(r.deletedEvents).toBe(1);
    expect(r.deletedPersons).toBe(0); // 无孤儿 person
    const snap = await service.loadAll();
    expect(snap.events.find(e => e.id === orphan.id)).toBeUndefined();
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
    const result = await service.evictByQuota({
      maxEvents: 3,
      maxEntities: 0,
      maxEdges: 0,
      hysteresisPct: 0,
      targetPct: 1,
    });
    expect(result.deletedEvents).toBe(2);
    const snap = await service.loadAll();
    expect(snap.events.length).toBe(3);
    // 老的两个先删
    expect(snap.events.find(e => e.id === ids[0])).toBeUndefined();
    expect(snap.events.find(e => e.id === ids[1])).toBeUndefined();
  });

  it('优先淘汰裸 event（无 part-of 锚、且参与者间无 person-person 边）', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'u1');
    await service.observePerson('onebot', 'u2');

    // 锚定 event：有 part-of 实体
    const anchorEnt = await service.createEntity({ name: '某游戏', entityKind: 'work', evidence: [] });
    const anchored = await service.createEvent({ title: '打某游戏', evidence: [] });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: anchored.id,
      role: 'participant',
      evidence: [ev()],
    });
    await service.addEventEntityEdge({
      fromEventId: anchored.id,
      toEntityId: anchorEnt.id,
      relationType: 'part-of',
      evidence: [ev()],
    });

    // 裸 event：仅有 person-event 边，无 part-of、无 person-person
    const naked = await service.createEvent({ title: '裸事件', evidence: [] });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: naked.id,
      role: 'participant',
      evidence: [ev()],
    });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u2',
      toEventId: naked.id,
      role: 'participant',
      evidence: [ev()],
    });

    // 配额限定为 1，应优先淘汰裸 event
    const result = await service.evictByQuota({
      maxEvents: 1,
      maxEntities: 0,
      maxEdges: 0,
      hysteresisPct: 0,
      targetPct: 1,
    });
    expect(result.deletedEvents).toBe(1);
    const snap = await service.loadAll();
    // 锚定 event 应保留，裸 event 应被删
    expect(snap.events.find(e => e.id === anchored.id)).toBeDefined();
    expect(snap.events.find(e => e.id === naked.id)).toBeUndefined();
  });

  it('有 person-person 边连接参与者时，event 不视为裸（不优先淘汰）', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'u1');
    await service.observePerson('onebot', 'u2');

    // event A：无 part-of，但参与者 u1↔u2 有 person-person 边 → 不裸
    const evA = await service.createEvent({ title: 'A', evidence: [] });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: evA.id,
      role: 'participant',
      evidence: [ev()],
    });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u2',
      toEventId: evA.id,
      role: 'participant',
      evidence: [ev()],
    });
    await service.addPersonPersonEdge({
      fromPersonId: 'onebot:u1',
      toPersonId: 'onebot:u2',
      relationType: 'friend',
      directed: false,
      evidence: [ev()],
    });

    // event B：完全裸 (单一参与者，无任何锚)
    const evB = await service.createEvent({ title: 'B', evidence: [] });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: evB.id,
      role: 'participant',
      evidence: [ev()],
    });

    const result = await service.evictByQuota({
      maxEvents: 1,
      maxEntities: 0,
      maxEdges: 0,
      hysteresisPct: 0,
      targetPct: 1,
    });
    expect(result.deletedEvents).toBe(1);
    const snap = await service.loadAll();
    expect(snap.events.find(e => e.id === evA.id)).toBeDefined();
    expect(snap.events.find(e => e.id === evB.id)).toBeUndefined();
  });
});

describe('plugin-user-relation: consolidate event-entity 去重', () => {
  it('同一 (event,entity) 同时 about + part-of → 合并保留 part-of，evidence 合并', async () => {
    const { service } = await makeService();
    const event = await service.createEvent({ title: '跨会话逻辑答疑', evidence: [] });
    const entity = await service.createEntity({ name: '跨会话逻辑', entityKind: 'topic', evidence: [] });

    await service.addEventEntityEdge({
      fromEventId: event.id,
      toEntityId: entity.id,
      relationType: 'about',
      evidence: [ev({ messageIds: ['a1'] })],
    });
    await service.addEventEntityEdge({
      fromEventId: event.id,
      toEntityId: entity.id,
      relationType: 'part-of',
      evidence: [ev({ messageIds: ['a2'] })],
    });

    const before = await service.loadAll();
    const eeBefore = before.edges.filter(
      e => e.kind === 'event-entity' && e.fromEventId === event.id && e.toEntityId === entity.id,
    );
    expect(eeBefore.length).toBe(2);

    const r = await service.consolidate({});
    expect(r.eventEdgesNormalized).toBeGreaterThanOrEqual(1);

    const after = await service.loadAll();
    const eeAfter = after.edges.filter(
      e => e.kind === 'event-entity' && e.fromEventId === event.id && e.toEntityId === entity.id,
    ) as EventEntityEdge[];
    expect(eeAfter.length).toBe(1);
    expect(eeAfter[0].relationType).toBe('part-of');
    // evidence 合并去重：含两条 messageIds
    const flat = (eeAfter[0].evidence ?? []).flatMap(e => e.messageIds ?? []);
    expect(flat).toContain('a1');
    expect(flat).toContain('a2');
  });

  it('(3c) about + related → 驱逐 about，保留 related，evidence 合并', async () => {
    const { service } = await makeService();
    const event = await service.createEvent({ title: 'test-ev-3c2', evidence: [] });
    const entity = await service.createEntity({ name: 'test-ent-3c2', entityKind: 'topic', evidence: [] });
    const ref = (msgId: string) => [ev({ messageIds: [msgId] })];

    await service.addEventEntityEdge({
      fromEventId: event.id,
      toEntityId: entity.id,
      relationType: 'about',
      evidence: ref('a1'),
    });
    await service.addEventEntityEdge({
      fromEventId: event.id,
      toEntityId: entity.id,
      relationType: 'related',
      evidence: ref('a2'),
    });

    const r = await service.consolidate({});
    expect(r.eventEdgesNormalized).toBeGreaterThanOrEqual(1);

    const snap = await service.loadAll();
    const edges = snap.edges.filter(
      e => e.kind === 'event-entity' && e.fromEventId === event.id && e.toEntityId === entity.id,
    ) as EventEntityEdge[];
    expect(edges).toHaveLength(1);
    expect(edges[0].relationType).toBe('related');
    const msgIds = edges[0].evidence.flatMap(e => e.messageIds ?? []);
    expect(msgIds).toContain('a1');
    expect(msgIds).toContain('a2');
  });

  it('(3c) part-of + related 同一 (event,entity) → 折叠保留 part-of（属于包含关于）', async () => {
    const { service } = await makeService();
    const event = await service.createEvent({ title: 'test-ev-3c3', evidence: [] });
    const entity = await service.createEntity({ name: 'test-ent-3c3', entityKind: 'topic', evidence: [] });
    const ref = (msgId: string) => [ev({ messageIds: [msgId] })];

    await service.addEventEntityEdge({
      fromEventId: event.id,
      toEntityId: entity.id,
      relationType: 'part-of',
      evidence: ref('b1'),
    });
    await service.addEventEntityEdge({
      fromEventId: event.id,
      toEntityId: entity.id,
      relationType: 'related',
      evidence: ref('b2'),
    });

    await service.consolidate({});

    const snap = await service.loadAll();
    const edges = snap.edges.filter(
      e => e.kind === 'event-entity' && e.fromEventId === event.id && e.toEntityId === entity.id,
    ) as EventEntityEdge[];
    expect(edges).toHaveLength(1);
    expect(edges[0].relationType).toBe('part-of');
    const msgIds = edges[0].evidence.flatMap(e => e.messageIds ?? []);
    expect(msgIds).toContain('b1');
    expect(msgIds).toContain('b2');
  });

  it('(3d) entity 名称包含关系 → autoLink 无 LLM 建 entity-entity part-of 边', async () => {
    const { service } = await makeService();
    const parent = await service.createEntity({ name: '三角洲行动', entityKind: 'work', evidence: [] });
    const child = await service.createEntity({ name: '三角洲行动刀皮', entityKind: 'thing', evidence: [] });

    const r = await service.consolidate({ autoLink: true });
    expect(r.entityHierarchyCandidates).toBeGreaterThanOrEqual(1);
    expect(r.entityHierarchyEdgesCreated).toBeGreaterThanOrEqual(1);

    const snap = await service.loadAll();
    const edge = snap.edges.find(
      e =>
        e.kind === 'entity-entity' &&
        e.fromEntityId === child.id &&
        e.toEntityId === parent.id &&
        e.relationType === 'part-of',
    );
    expect(edge).toBeDefined();
  });

  it('(3e) 兄弟实体无 LLM → 仅计数候选，不创建父实体', async () => {
    const { service } = await makeService();
    await service.createEntity({ name: '三角洲行动刀皮', entityKind: 'thing', evidence: [] });
    await service.createEntity({ name: '三角洲行动绝密航天', entityKind: 'thing', evidence: [] });

    const r = await service.consolidate({ autoLink: true });
    expect(r.lateralParentCandidates).toBeGreaterThanOrEqual(1);
    expect(r.lateralParentsCreated).toBe(0);
    expect(r.lateralEdgesCreated).toBe(0);

    const snap = await service.loadAll();
    expect(snap.entities.find(e => e.name === '三角洲行动')).toBeUndefined();
  });

  it('(3f) part-of auto-link: 严格边界匹配，"绝航" 不应锚到 "讨论绝航刀皮"（已有更长的"绝航刀皮"实体）', async () => {
    const { service } = await makeService();
    // 创建父子实体（先建立 entity-entity part-of 链）
    const parent = await service.createEntity({ name: '绝航', entityKind: 'work', evidence: [] });
    const child = await service.createEntity({ name: '绝航刀皮', entityKind: 'thing', evidence: [] });
    // 事件标题含"绝航刀皮"（自然也含"绝航"）
    const evNode = await service.createEvent({ title: '讨论绝航刀皮的属性', evidence: [] });

    // 第一次 consolidate：「最长候选优先」规则在 candidate 列表里就剔除"绝航"
    // （即使尚未建 entity-entity part-of 链），只保留"绝航刀皮"
    await service.consolidate({ autoLink: true });

    const snap = await service.loadAll();
    const peoEdges = snap.edges.filter(
      e => e.kind === 'event-entity' && e.fromEventId === evNode.id && e.relationType === 'part-of',
    ) as EventEntityEdge[];
    const targetIds = new Set(peoEdges.map(e => e.toEntityId));
    expect(targetIds.has(child.id)).toBe(true);
    expect(targetIds.has(parent.id)).toBe(false); // 父被「最长候选优先」剔除
  });

  it('(3f) part-of auto-link: 仅 work/place/thing 参与，topic 实体不参与 part-of 锚定', async () => {
    const { service } = await makeService();
    const topic = await service.createEntity({ name: '健康', entityKind: 'topic', evidence: [] });
    const evNode = await service.createEvent({ title: '聊聊健康话题', evidence: [] });

    await service.consolidate({ autoLink: true });
    const snap = await service.loadAll();
    const edge = snap.edges.find(
      e => e.kind === 'event-entity' && e.fromEventId === evNode.id && e.toEntityId === topic.id,
    );
    expect(edge).toBeUndefined(); // topic 跳过
  });

  it('(3f) part-of auto-link: entity-entity part-of 链祖先剔除（间接父也不锚）', async () => {
    const { service } = await makeService();
    // 三级链：刀皮纹理 part-of 绝航刀皮 part-of 绝航
    const grand = await service.createEntity({ name: '绝航', entityKind: 'work', evidence: [] });
    const mid = await service.createEntity({ name: '绝航刀皮', entityKind: 'thing', evidence: [] });
    const leaf = await service.createEntity({ name: '刀皮纹理', entityKind: 'thing', evidence: [] });
    // 手动建链（绕过名称包含规则）
    await service.addEntityEntityEdge({
      fromEntityId: mid.id,
      toEntityId: grand.id,
      relationType: 'part-of',
      evidence: [],
    });
    await service.addEntityEntityEdge({
      fromEntityId: leaf.id,
      toEntityId: mid.id,
      relationType: 'part-of',
      evidence: [],
    });
    // 事件标题同时含三个名字
    const evNode = await service.createEvent({ title: '绝航绝航刀皮刀皮纹理调研', evidence: [] });

    await service.consolidate({ autoLink: true });
    const snap = await service.loadAll();
    const peoEdges = snap.edges.filter(
      e => e.kind === 'event-entity' && e.fromEventId === evNode.id && e.relationType === 'part-of',
    ) as EventEntityEdge[];
    const targetIds = new Set(peoEdges.map(e => e.toEntityId));
    expect(targetIds.has(leaf.id)).toBe(true);
    expect(targetIds.has(mid.id)).toBe(false); // 直接父被剔除
    expect(targetIds.has(grand.id)).toBe(false); // 间接祖先也被剔除
  });

  it('(3f) part-of auto-link: 短名 "PS5" 在事件标题中正常锚定', async () => {
    const { service } = await makeService();
    const ps5 = await service.createEntity({ name: 'PS5', entityKind: 'thing', evidence: [] });
    const evNode = await service.createEvent({ title: '聊 PS5 的体验', evidence: [] });

    await service.consolidate({ autoLink: true });
    const snap = await service.loadAll();
    const edge = snap.edges.find(
      e =>
        e.kind === 'event-entity' &&
        e.fromEventId === evNode.id &&
        e.toEntityId === ps5.id &&
        e.relationType === 'part-of',
    );
    expect(edge).toBeDefined();
  });

  it('normalizeName: 连接符/下划线/中点 视为装饰，「三角洲-行动」≡「三角洲行动」', async () => {
    const { service } = await makeService();
    const a = await service.createEntity({
      name: '三角洲-行动',
      entityKind: 'work',
      evidence: [ev({ messageIds: ['m1'] })],
    });
    const b = await service.createEntity({
      name: '三角洲_行动',
      entityKind: 'work',
      evidence: [ev({ messageIds: ['m2'] })],
    });
    const c = await service.createEntity({
      name: '三角洲·行动',
      entityKind: 'work',
      evidence: [ev({ messageIds: ['m3'] })],
    });
    const d = await service.createEntity({
      name: '三角洲行动',
      entityKind: 'work',
      evidence: [ev({ messageIds: ['m4'] })],
    });
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(d.id).toBe(a.id);
  });

  it('consolidate triggerSource 透传到 getLastConsolidateInfo', async () => {
    const { service } = await makeService();
    await service.consolidate({ triggerSource: 'manual' });
    expect(service.getLastConsolidateInfo().trigger).toBe('manual');
    await service.consolidate({ triggerSource: 'eviction' });
    expect(service.getLastConsolidateInfo().trigger).toBe('eviction');
    await service.consolidate({});
    expect(service.getLastConsolidateInfo().trigger).toBe('api');
  });
});

describe('plugin-user-relation: person-person hierarchy', () => {
  it('hierarchy 与 directed 正交存储', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    const edge = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'mentor',
      hierarchy: 'superior',
    });
    expect(edge.hierarchy).toBe('superior');
    expect(edge.directed).toBe(true);
  });

  it('后来者覆盖 unknown：具体值不会被 unknown 抹平', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    const e1 = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'colleague',
      hierarchy: 'peer',
    });
    const e2 = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'colleague',
      hierarchy: 'unknown',
    });
    expect(e2.id).toBe(e1.id);
    expect(e2.hierarchy).toBe('peer'); // 不被 unknown 覆盖
  });

  it('后来者用具体值覆盖原 unknown', async () => {
    const { service } = await makeService();
    await service.observePerson('onebot', 'a');
    await service.observePerson('onebot', 'b');
    await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'mentor',
      hierarchy: 'unknown',
    });
    const e2 = await service.addPersonPersonEdge({
      fromPersonId: 'onebot:a',
      toPersonId: 'onebot:b',
      relationType: 'mentor',
      hierarchy: 'subordinate',
    });
    expect(e2.hierarchy).toBe('subordinate');
  });
});

describe('plugin-user-relation: renameNode', () => {
  it('event 改名：原 title 进 aliases，nameHistory 追加 audit', async () => {
    const { service } = await makeService();
    const e = await service.createEvent({ title: '旧标题', evidence: [ev()] });
    const res = await service.renameNode({
      kind: 'event',
      id: e.id,
      newName: '新标题',
      by: 'llm',
      reason: 'unit-test',
    });
    expect(res).toEqual({ from: '旧标题', to: '新标题', aliasesAdded: true });
    const after = await service.getEvent(e.id);
    expect(after?.title).toBe('新标题');
    expect(after?.aliases).toContain('旧标题');
    expect(after?.nameHistory).toHaveLength(1);
    expect(after?.nameHistory?.[0]).toMatchObject({ from: '旧标题', to: '新标题', by: 'llm', reason: 'unit-test' });
  });

  it('entity 改名：name 进 aliases，nameHistory 累加', async () => {
    const { service } = await makeService();
    const en = await service.createEntity({ entityKind: 'topic', name: 'Old Co', evidence: [] });
    await service.renameNode({ kind: 'entity', id: en.id, newName: 'Mid Co', reason: 'r1' });
    const a = await service.getEntity(en.id);
    expect(a?.name).toBe('Mid Co');
    expect(a?.aliases).toContain('Old Co');
    await service.renameNode({ kind: 'entity', id: en.id, newName: 'New Co', reason: 'r2' });
    const b = await service.getEntity(en.id);
    expect(b?.name).toBe('New Co');
    expect(b?.aliases).toEqual(expect.arrayContaining(['Old Co', 'Mid Co']));
    expect(b?.nameHistory).toHaveLength(2);
  });

  it('同名重命名是 no-op', async () => {
    const { service } = await makeService();
    const e = await service.createEvent({ title: '相同', evidence: [ev()] });
    const res = await service.renameNode({ kind: 'event', id: e.id, newName: '相同', reason: 'noop' });
    expect(res.aliasesAdded).toBe(false);
    const a = await service.getEvent(e.id);
    expect(a?.aliases ?? []).not.toContain('相同');
    expect(a?.nameHistory ?? []).toHaveLength(0);
  });

  it('空 newName / 不存在 id 抛错', async () => {
    const { service } = await makeService();
    await expect(service.renameNode({ kind: 'event', id: 'x', newName: '   ', reason: 'r' })).rejects.toThrow(
      /不能为空/,
    );
    await expect(service.renameNode({ kind: 'event', id: 'missing', newName: 'x', reason: 'r' })).rejects.toThrow(
      /不存在/,
    );
    await expect(service.renameNode({ kind: 'entity', id: 'missing', newName: 'x', reason: 'r' })).rejects.toThrow(
      /不存在/,
    );
  });
});

describe('plugin-user-relation: computePageRank component-size scaling', () => {
  // 构造图：主连通分量 (5 person + 5 event + 1 entity，相互 person-event/event-entity)
  //         + 孤立三角 (1 person + 1 event + 1 entity 闭环)
  // 期望：componentScale=true 时孤立节点 PR 显著低于 false 时。
  function buildSnap(): RelationGraphSnapshot {
    // biome-ignore lint/suspicious/noExplicitAny: 测试构造图节点，字段全部手填即可
    const persons: any[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    const events: any[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    const entities: any[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    const edges: any[] = [];
    for (let i = 0; i < 5; i++) {
      persons.push({
        id: `pM${i}`,
        displayName: `MainP${i}`,
        platformIds: [],
        mentionCount: 1,
        lastSeenAt: 0,
        aliases: [],
        nameHistory: [],
      });
      events.push({
        id: `eM${i}`,
        title: `MainE${i}`,
        weight: 0.5,
        evidence: [],
        lastReinforcedAt: 0,
        aliases: [],
        nameHistory: [],
      });
    }
    entities.push({
      id: 'enM0',
      name: 'MainEnt',
      weight: 0.5,
      evidence: [],
      lastReinforcedAt: 0,
      aliases: [],
      nameHistory: [],
    });
    // 每个主 person 连每个主 event
    for (const p of persons) {
      for (const e of events) {
        edges.push({
          kind: 'person-event',
          fromPersonId: p.id,
          toEventId: e.id,
          role: 'participant',
          weight: 0.5,
          evidence: [],
          createdAt: 0,
          lastReinforcedAt: 0,
        });
      }
    }
    // 主 event ↔ 主 entity
    for (const e of events) {
      edges.push({
        kind: 'event-entity',
        fromEventId: e.id,
        toEntityId: 'enM0',
        relationType: 'mentions',
        directed: true,
        weight: 0.5,
        evidence: [],
        createdAt: 0,
        lastReinforcedAt: 0,
      });
    }
    // 孤立三角
    persons.push({
      id: 'pIso',
      displayName: 'IsoP',
      platformIds: [],
      mentionCount: 1,
      lastSeenAt: 0,
      aliases: [],
      nameHistory: [],
    });
    events.push({
      id: 'eIso',
      title: 'IsoE',
      weight: 0.5,
      evidence: [],
      lastReinforcedAt: 0,
      aliases: [],
      nameHistory: [],
    });
    entities.push({
      id: 'enIso',
      name: 'IsoEnt',
      weight: 0.5,
      evidence: [],
      lastReinforcedAt: 0,
      aliases: [],
      nameHistory: [],
    });
    edges.push({
      kind: 'person-event',
      fromPersonId: 'pIso',
      toEventId: 'eIso',
      role: 'participant',
      weight: 0.5,
      evidence: [],
      createdAt: 0,
      lastReinforcedAt: 0,
    });
    edges.push({
      kind: 'event-entity',
      fromEventId: 'eIso',
      toEntityId: 'enIso',
      relationType: 'mentions',
      directed: true,
      weight: 0.5,
      evidence: [],
      createdAt: 0,
      lastReinforcedAt: 0,
    });
    return { persons, events, entities, edges } as RelationGraphSnapshot;
  }

  it('开启 componentScale 后孤立小子图节点 PR 显著降低', () => {
    const snap = buildSnap();
    const opts = {
      damping: 0.85,
      maxIter: 30,
      epsilon: 1e-5,
      personSeed: 2,
      entitySeed: 1.5,
      eventSeed: 1,
      reverseEdgeFactor: 0.5,
    };
    const prRaw = computePageRank(snap, { ...opts, componentScale: false });
    const prScaled = computePageRank(snap, { ...opts, componentScale: true });

    const isoP_raw = prRaw.get('pIso') ?? 0;
    const isoP_scaled = prScaled.get('pIso') ?? 0;
    const mainP_raw = prRaw.get('pM0') ?? 0;
    const mainP_scaled = prScaled.get('pM0') ?? 0;

    // 缩放后孤立人节点 PR 至少跌一半，且主分量人节点 PR 反而抬升（占比变大）
    expect(isoP_scaled).toBeLessThan(isoP_raw * 0.6);
    expect(mainP_scaled).toBeGreaterThan(mainP_raw);

    // 归一化恒等
    const sum = Array.from(prScaled.values()).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 4);

    // 主分量 person PR 应当 > 孤立 person PR（缩放后语义直观）
    expect(mainP_scaled).toBeGreaterThan(isoP_scaled);
  });

  it('componentScale 默认为 true（不传等于 true）', () => {
    const snap = buildSnap();
    const opts = {
      damping: 0.85,
      maxIter: 30,
      epsilon: 1e-5,
      personSeed: 2,
      entitySeed: 1.5,
      eventSeed: 1,
      reverseEdgeFactor: 0.5,
    };
    const prDefault = computePageRank(snap, opts);
    const prExplicit = computePageRank(snap, { ...opts, componentScale: true });
    expect(prDefault.get('pIso')).toBeCloseTo(prExplicit.get('pIso') ?? 0, 6);
    expect(prDefault.get('pM0')).toBeCloseTo(prExplicit.get('pM0') ?? 0, 6);
  });
});

describe('plugin-user-relation: getCommunityOverview per-community 自适应 topN', () => {
  it('不传 top_n 时大社群展示更多核心成员、小社群展示更少；传 top_n>0 一刀切', async () => {
    const { service } = await makeService();
    // 大社群：12 个 person + 共同 event "bigE"
    const bigPersonIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await service.observePerson('onebot', `big-${i}`, `Big${i}`);
      bigPersonIds.push(p.id);
    }
    const bigE = await service.createEvent({ title: 'BigEvent', evidence: [ev()] });
    for (const pid of bigPersonIds) {
      await service.addPersonEventEdge({
        fromPersonId: pid,
        toEventId: bigE.id,
        role: 'participant',
        evidence: [ev()],
      });
    }
    // 小社群：3 个 person + 共同 event
    const smallPersonIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await service.observePerson('onebot', `small-${i}`, `Small${i}`);
      smallPersonIds.push(p.id);
    }
    const smallE = await service.createEvent({ title: 'SmallEvent', evidence: [ev()] });
    for (const pid of smallPersonIds) {
      await service.addPersonEventEdge({
        fromPersonId: pid,
        toEventId: smallE.id,
        role: 'participant',
        evidence: [ev()],
      });
    }

    const adaptive = await service.getCommunityOverview({});
    expect(adaptive.communities.length).toBeGreaterThanOrEqual(2);
    const big = adaptive.communities.find(c => c.size >= 10);
    const small = adaptive.communities.find(c => c.size === 3);
    expect(big).toBeTruthy();
    expect(small).toBeTruthy();
    // 大社群核心展示数 ≥ 小社群（自适应 log2(comTotal+1)）
    expect(big!.topMembers.length).toBeGreaterThanOrEqual(small!.topMembers.length);
    // 小社群也保底 ≥ 3 条（但不会超过其实际成员数）
    expect(small!.topMembers.length).toBeGreaterThanOrEqual(Math.min(3, small!.size));
    // 大社群 comTotal ≥ 13 → ceil(log2(14))=4，至少 4 个成员
    expect(big!.topMembers.length).toBeGreaterThanOrEqual(4);

    // 一刀切：传 top_n=2 → 所有社群最多 2 条
    const fixed = await service.getCommunityOverview({ topN: 2 });
    for (const c of fixed.communities) {
      expect(c.topMembers.length).toBeLessThanOrEqual(2);
    }

    // top_n=0 → 不限
    const unlimited = await service.getCommunityOverview({ topN: 0 });
    const bigUnlim = unlimited.communities.find(c => c.size >= 10);
    expect(bigUnlim!.topMembers.length).toBe(bigUnlim!.size);
  });
});
