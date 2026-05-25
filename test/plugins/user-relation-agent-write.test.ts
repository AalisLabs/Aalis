import { describe, expect, it } from 'vitest';
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
});
