import { describe, expect, it } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import { RelationService, RelationStore } from '../../packages/plugin-user-relation/src/index.js';
import type { EntityNode, EvidenceRef } from '../../packages/plugin-user-relation/src/types.js';

// ════════════════════════════════════════════════════════════
// consolidate「落笔核实况」不变量——僵尸节点复活 + 重复铸边回归。
//
// 事故（真机 2026-08，「表情包星形」）：consolidate 的批量范式让整个 pass 共用
// pass 开头快照；真合并物理删除节点后，同 pass 后续阶段（embedding hash / summary /
// PageRank 回写）拿快照旧拷贝 spread 整个节点写回 → 已删节点复活。僵尸节点使
// consolidate 每 7 分钟重判同一批对（4 天 2669 次 LLM 判定），反复铸 part-of 边
// （同一对最多 34 次）；铸边又查旧快照 + 直写绕过门面 → 同 pass 同边 ×9 份。
//
// 两条不变量（由本文件定格）：
//   1. 「删了就是删了」：派生回写走 writeBack*IfLive 写口，落笔前核库中实况；
//      且以**活文档**为基底套补丁，不用旧拷贝压掉并发更新。
//   2. 「铸边走门面、以实况为准」：_ensureHierarchyEdge 不接受快照参数，
//      端点死则跳过，写入经 addEntityEntityEdge 复用实时查重。
// ════════════════════════════════════════════════════════════

async function makeService() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  // biome-ignore lint/suspicious/noExplicitAny: src 与 dist 的 PluginModule 类型路径不同，运行时结构等价
  await app.ctx.useModule(memoryInMemoryModule as any);
  const mem = app.ctx.getService<MemoryService>('memory');
  if (!mem) throw new Error('memory service missing');
  const store = new RelationStore(mem);
  return { app, store, service: new RelationService(store) };
}

const ev = (overrides: Partial<EvidenceRef> = {}): EvidenceRef => ({
  sessionId: 'sess1',
  messageIds: ['m1'],
  quote: 'hello',
  extractedAt: Date.now(),
  ...overrides,
});

/** 访问被测私有方法（行为回归的锚点即这两个写口本身） */
type ServicePrivates = {
  writeBackEntityIfLive(node: EntityNode, patch: Partial<EntityNode>): Promise<boolean>;
  writeBackEventIfLive(node: { id: string }, patch: Record<string, unknown>): Promise<boolean>;
  _ensureHierarchyEdge(
    childId: string,
    parentId: string,
    description: string,
  ): Promise<'built' | 'exists' | 'skipped-dead'>;
};

describe('user-relation consolidate 落笔核实况（僵尸复活回归）', () => {
  it('真合并删除后的节点，旧拷贝补丁式回写不得使其复活（删掉守卫即红）', async () => {
    const { store, service } = await makeService();
    const a = await service.createEntity({ name: '滑稽表情包', entityKind: 'thing', evidence: [ev()] });
    const b = await service.createEntity({ name: '表情包', entityKind: 'thing', evidence: [ev()] });
    const staleCopy: EntityNode = structuredClone(a); // 模拟 pass 快照里的旧拷贝

    const r = await service.mergeAlias({
      aliasId: a.id,
      canonicalId: b.id,
      kind: 'entity',
      noCanonicalCorrection: true,
    });
    expect(r.aliasDeleted).toBe(true);
    expect(await store.getEntity(a.id)).toBeUndefined();

    // 事故形态：旧代码此处执行 store.upsertEntity({...staleCopy, embeddingHash}) → 复活
    const wrote = await (service as unknown as ServicePrivates).writeBackEntityIfLive(staleCopy, {
      embeddingHash: 'zz-hash',
    });
    expect(wrote).toBe(false);
    expect(await store.getEntity(a.id)).toBeUndefined(); // 死者安息
  });

  it('活节点回写以库中活文档为基底：旧拷贝不得压掉更新的字段', async () => {
    const { store, service } = await makeService();
    const a = await service.createEntity({ name: '旧名', entityKind: 'thing', evidence: [ev()] });
    const staleCopy: EntityNode = structuredClone(a);
    // 并发路径改了名（模拟合并并入 aliases / rename 等）
    const live = await store.getEntity(a.id);
    if (!live) throw new Error('entity missing');
    await store.upsertEntity({ ...live, name: '新名', aliases: ['旧名'] });

    const wrote = await (service as unknown as ServicePrivates).writeBackEntityIfLive(staleCopy, {
      summary: '补丁摘要',
    });
    expect(wrote).toBe(true);
    const after = await store.getEntity(a.id);
    expect(after?.summary).toBe('补丁摘要'); // 补丁生效
    expect(after?.name).toBe('新名'); // 旧拷贝的 name 没有压回来
    expect(after?.aliases).toEqual(['旧名']);
  });

  it('event 写口同约束：不存在的事件不因回写复活', async () => {
    const { service } = await makeService();
    const wrote = await (service as unknown as ServicePrivates).writeBackEventIfLive(
      { id: 'nonexistent-event-id' },
      { embeddingHash: 'zz' },
    );
    expect(wrote).toBe(false);
  });
});

describe('user-relation _ensureHierarchyEdge（重复铸边回归）', () => {
  it('同一对重复判定只落一条 part-of 边（事故形态为同 pass 同边 ×9）', async () => {
    const { store, service } = await makeService();
    const c = await service.createEntity({ name: '猪猪表情包', entityKind: 'thing', evidence: [ev()] });
    const p = await service.createEntity({ name: '表情包', entityKind: 'thing', evidence: [ev()] });
    const priv = service as unknown as ServicePrivates;

    expect(await priv._ensureHierarchyEdge(c.id, p.id, 'LLM 判定')).toBe('built');
    expect(await priv._ensureHierarchyEdge(c.id, p.id, 'LLM 判定')).toBe('exists');
    expect(await priv._ensureHierarchyEdge(c.id, p.id, '另一措辞的判定')).toBe('exists');

    const snap = await store.loadAll();
    const partOf = snap.edges.filter(
      e =>
        e.kind === 'entity-entity' && e.relationType === 'part-of' && e.fromEntityId === c.id && e.toEntityId === p.id,
    );
    expect(partOf).toHaveLength(1);
  });

  it('端点已被真合并删除 → skipped-dead，不落边（stale 工单不再产边）', async () => {
    const { store, service } = await makeService();
    const c = await service.createEntity({ name: '好女孩表情包', entityKind: 'thing', evidence: [ev()] });
    const p = await service.createEntity({ name: '表情包', entityKind: 'thing', evidence: [ev()] });
    const x = await service.createEntity({ name: '吸收者', entityKind: 'thing', evidence: [ev()] });
    await service.mergeAlias({ aliasId: c.id, canonicalId: x.id, kind: 'entity', noCanonicalCorrection: true });

    const priv = service as unknown as ServicePrivates;
    expect(await priv._ensureHierarchyEdge(c.id, p.id, 'LLM 判定')).toBe('skipped-dead');
    const snap = await store.loadAll();
    expect(snap.edges.some(e => e.kind === 'entity-entity' && e.relationType === 'part-of')).toBe(false);
  });

  it('(3c) 旧账整理在真合并后按实况运行：不删活边、不把死端点写回（对抗审计复现场景）', async () => {
    const { store, service } = await makeService();
    // 存量形态：两个同名实体（绕过 createEntity 的建时合并，直写 store 模拟历史旧账）
    const mkEntity = (aliases: string[]): EntityNode => ({
      id: globalThis.crypto.randomUUID(),
      entityKind: 'work',
      name: '三角洲行动',
      aliases,
      firstSeenAt: Date.now(),
      lastReinforcedAt: Date.now(),
      evidence: [ev()],
    });
    const x = mkEntity([]);
    const y = mkEntity(['DeltaForce', '三角洲']); // aliases 多 → 倾向被选为 canonical
    await store.upsertEntity(x);
    await store.upsertEntity(y);
    // 事件对 X 同时挂 part-of 与 about——(3c) 存在的理由，正是事故触发形态
    // 两条边证据必须**不同**：(3c) 的写回分支仅在"证据合并后有增量"时触发——
    // 同证据时 stale 写回不会发生，测试会漏掉事故形态（变异验证曾因此没红）。
    const e1 = await service.createEvent({ title: '绝密航天翻车对局', evidence: [] });
    await service.addEventEntityEdge({
      fromEventId: e1.id,
      toEntityId: x.id,
      relationType: 'part-of',
      evidence: [ev({ messageIds: ['p1'] })],
    });
    await service.addEventEntityEdge({
      fromEventId: e1.id,
      toEntityId: x.id,
      relationType: 'about',
      evidence: [ev({ messageIds: ['a1'] })],
    });

    await service.consolidate({ autoLink: true }); // 无 LLM：strict-equiv 同名直通真合并

    const after = await service.loadAll();
    // 同名实体只剩一份 canonical
    const remaining = after.entities.filter(n => n.name === '三角洲行动');
    expect(remaining).toHaveLength(1);
    const canonicalId = remaining[0].id;
    // 全图零悬空：所有边的实体端点都活着（事故形态：(3c) 把死端点 X 写回活边）
    const entityIds = new Set(after.entities.map(n => n.id));
    for (const edge of after.edges) {
      if (edge.kind === 'event-entity') expect(entityIds.has(edge.toEntityId)).toBe(true);
      if (edge.kind === 'entity-entity') {
        expect(entityIds.has(edge.fromEntityId)).toBe(true);
        expect(entityIds.has(edge.toEntityId)).toBe(true);
      }
    }
    // 事件与 canonical 的挂载存活，且被 (3c) 折叠为一条 part-of（不是净丢失）
    const ee = after.edges.filter(e => e.kind === 'event-entity' && e.fromEventId === e1.id);
    expect(ee).toHaveLength(1);
    expect(ee[0].kind === 'event-entity' && ee[0].toEntityId).toBe(canonicalId);
    expect(ee[0].kind === 'event-entity' && ee[0].relationType).toBe('part-of');
  });

  it('已有 contains 反向边视为已存在层级，不再叠 part-of', async () => {
    const { store, service } = await makeService();
    const c = await service.createEntity({ name: '子实体', entityKind: 'thing', evidence: [ev()] });
    const p = await service.createEntity({ name: '父实体', entityKind: 'thing', evidence: [ev()] });
    await service.addEntityEntityEdge({
      fromEntityId: p.id,
      toEntityId: c.id,
      relationType: 'contains',
      evidence: [ev()],
    });

    const priv = service as unknown as ServicePrivates;
    expect(await priv._ensureHierarchyEdge(c.id, p.id, 'LLM 判定')).toBe('exists');
    const snap = await store.loadAll();
    expect(snap.edges.filter(e => e.kind === 'entity-entity').map(e => e.relationType)).toEqual(['contains']);
  });
});
