import { describe, expect, it } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import { RelationService, RelationStore } from '../../packages/plugin-user-relation/src/index.js';
import {
  eventKey,
  RELATION_NAMESPACE,
  RELATION_VECTOR_NAMESPACE,
} from '../../packages/plugin-user-relation/src/store.js';
import type { EntityNode, EventNode } from '../../packages/plugin-user-relation/src/types.js';
import {
  computeEntityEmbeddingHash,
  computeEventEmbeddingHash,
} from '../../packages/plugin-user-relation/src/utils.js';

// ════════════════════════════════════════════════════════════
// embedding 向量拆出节点文档（2026-08 OOM 事故修复）
//
// 事故：向量内嵌在节点文档里，loadAll 每次把全部 4096 维向量拉成 JS 装箱数组
// （每条 ~96KB），快照被并发持有 20+ 份跨越长 LLM 调用 → 堆里 1.8GB 全是向量，
// 进程撞默认 4GB 上限 OOM。修复：向量存独立命名空间 RELATION_VECTOR_NAMESPACE，
// 只有 consolidate 相似度召回按需读；节点只留 embeddingHash 做失效判断。
//
// 本文件守住的契约：
//  1. loadAll 永不携带向量（含未迁移的历史内嵌文档——防御性剥离）；
//  2. 向量读写走独立命名空间，节点删除/级联删除/清空连带删向量；
//  3. 行为等价：hash 命中时召回用的向量与迁移前一致（相似度结果不变）、
//     不多调 embed；向量丢失时自愈重算，且重算结果不再内嵌回节点。
// ════════════════════════════════════════════════════════════

async function makeStore() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  // biome-ignore lint/suspicious/noExplicitAny: src 与 dist 的 PluginModule 类型路径不同，运行时结构等价
  await app.ctx.useModule(memoryInMemoryModule as any);
  const mem = app.ctx.getService<MemoryService>('memory');
  if (!mem) throw new Error('memory service missing');
  return { app, mem, store: new RelationStore(mem) };
}

const VEC = Array.from({ length: 8 }, (_, i) => (i + 1) / 10);

function rawEntity(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `实体${id}`,
    entityKind: 'topic',
    summary: '摘要',
    evidence: [],
    createdAt: 1,
    lastReinforcedAt: 1,
    ...extra,
  };
}

function rawEvent(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `事件${id}`,
    summary: '摘要',
    participants: [],
    evidence: [],
    createdAt: 1,
    lastReinforcedAt: 1,
    ...extra,
  };
}

describe('向量独立命名空间：读写与生命周期', () => {
  it('upsertVector/getVector 往返；entity 与 event 键空间隔离', async () => {
    const { store } = await makeStore();
    await store.upsertVector('entity', 'x1', VEC);
    expect(await store.getVector('entity', 'x1')).toEqual(VEC);
    expect(await store.getVector('event', 'x1'), '同 id 不同 kind 不得串键').toBeUndefined();
  });

  it('deleteEntity / deleteEvent 连带删除向量（不留孤儿文档）', async () => {
    const { store, mem } = await makeStore();
    await mem.saveMetadata(RELATION_NAMESPACE, 'entity:e1', rawEntity('e1'));
    await store.upsertVector('entity', 'e1', VEC);
    await store.deleteEntity('e1');
    expect(await store.getVector('entity', 'e1')).toBeUndefined();

    await mem.saveMetadata(RELATION_NAMESPACE, eventKey('ev1'), rawEvent('ev1'));
    await store.upsertVector('event', 'ev1', VEC);
    await store.deleteEventCascade('ev1');
    expect(await store.getVector('event', 'ev1')).toBeUndefined();
  });

  it('clearAll 同时清空两个命名空间', async () => {
    const { store, mem } = await makeStore();
    await mem.saveMetadata(RELATION_NAMESPACE, 'entity:e1', rawEntity('e1'));
    await store.upsertVector('entity', 'e1', VEC);
    await store.clearAll();
    expect(await store.getVector('entity', 'e1'), '向量命名空间残留=重建图后撞旧向量').toBeUndefined();
    expect((await mem.listMetadata(RELATION_VECTOR_NAMESPACE)).length).toBe(0);
  });
});

describe('loadAll 永不携带向量', () => {
  it('未迁移的历史内嵌文档也被防御性剥离（这正是 OOM 的形成机制）', async () => {
    const { store, mem } = await makeStore();
    await mem.saveMetadata(
      RELATION_NAMESPACE,
      'entity:e1',
      rawEntity('e1', { embeddingVector: VEC, embeddingHash: 'h' }),
    );
    await mem.saveMetadata(
      RELATION_NAMESPACE,
      eventKey('ev1'),
      rawEvent('ev1', { embeddingVector: VEC, embeddingHash: 'h' }),
    );
    const snap = await store.loadAll();
    // 类型上 embeddingVector 已彻底移除，按原始 Record 断言剥离效果
    const en = snap.entities.find(e => e.id === 'e1') as EntityNode & Record<string, unknown>;
    const ev = snap.events.find(e => e.id === 'ev1') as EventNode & Record<string, unknown>;
    expect(en.embeddingVector, '快照携带向量=每份快照 96KB/节点 × 并发 20 份').toBeUndefined();
    expect(ev.embeddingVector).toBeUndefined();
    // 剥的只是向量；hash 与其余字段原样
    expect(en.embeddingHash).toBe('h');
    expect(en.name).toBe('实体e1');
  });
});

describe('行为等价：consolidate 事件召回（dryRun 直驱私有路径）', () => {
  function makeHarness() {
    const calls: string[] = [];
    const embedding = {
      embed: async (text: string) => {
        calls.push(text);
        return VEC;
      },
    };
    return { embedding, calls };
  }

  async function seedTwinEvents(mem: MemoryService, store: RelationStore, withVectors: boolean) {
    // 两个标题高度相似的事件（jaccard 兜底路径必命中），hash 预置为一致
    for (const id of ['a1', 'b1'] as const) {
      const title = `开黑打三角洲${id}`;
      const node = rawEvent(id, { title, embeddingHash: computeEventEmbeddingHash(title, '摘要') });
      await mem.saveMetadata(RELATION_NAMESPACE, eventKey(id), node);
      if (withVectors) await store.upsertVector('event', id, VEC, node.embeddingHash as string);
    }
  }

  it('hash 命中 + 向量在库：零 embed 调用，候选 cos=1（与内嵌时代同结果）', async () => {
    const { mem, store } = await makeStore();
    const service = new RelationService(store);
    const { embedding, calls } = makeHarness();
    await seedTwinEvents(mem, store, true);

    // biome-ignore lint/suspicious/noExplicitAny: 私有方法 dryRun 直驱，回避重型 LLM 装配
    const r = await (service as any)._consolidateEventDuplicates({ embedding, dryRun: true });
    expect(calls, 'hash 一致且向量在库时不得重算').toHaveLength(0);
    expect(r.candidates.length).toBeGreaterThan(0);
    // 两条向量相同 → cos 必须精确为 1；这是「迁移前后相似度结果不变」的直接断言
    expect(r.candidates[0].cosineScore).toBeCloseTo(1, 5);
  });

  it('向量丢失自愈：hash 命中但库里没有 → 重算一次、入向量命名空间、节点不再内嵌', async () => {
    const { mem, store } = await makeStore();
    const service = new RelationService(store);
    const { embedding, calls } = makeHarness();
    await seedTwinEvents(mem, store, false); // hash 匹配但向量缺失

    // biome-ignore lint/suspicious/noExplicitAny: 同上
    await (service as any)._consolidateEventDuplicates({ embedding, dryRun: true });
    expect(calls.length, '两个事件各自愈重算一次').toBe(2);
    expect(await store.getVector('event', 'a1')).toEqual(VEC);
    const raw = (await mem.getMetadata(RELATION_NAMESPACE, eventKey('a1'))) as Record<string, unknown>;
    expect(raw.embeddingVector, '重算结果不得再内嵌回节点文档').toBeUndefined();
  });

  it('hash 错配自愈：向量文档带旧 hash 时视为缺失重算（非原子写对账带，medium 审计项）', async () => {
    const { mem, store } = await makeStore();
    const service = new RelationService(store);
    const { embedding, calls } = makeHarness();
    await seedTwinEvents(mem, store, false);
    // 向量在库但 hash 是旧文本的：并发 consolidate 交错可造成这种错配
    await store.upsertVector('event', 'a1', VEC, 'stale-hash');
    await store.upsertVector('event', 'b1', VEC, 'stale-hash');

    // biome-ignore lint/suspicious/noExplicitAny: 同上
    await (service as any)._consolidateEventDuplicates({ embedding, dryRun: true });
    expect(calls.length, '旧 hash 向量不得被当作现行向量使用').toBe(2);
  });

  it('同轮内不重复打存储：每事件最多一次 getVector/embed（每轮向量缓存生效）', async () => {
    const { mem, store } = await makeStore();
    const service = new RelationService(store);
    const { embedding, calls } = makeHarness();
    await seedTwinEvents(mem, store, false);
    let vectorReads = 0;
    const origGet = store.getVector.bind(store);
    store.getVector = async (kind, id) => {
      vectorReads++;
      return origGet(kind, id);
    };
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    await (service as any)._consolidateEventDuplicates({ embedding, dryRun: true });
    // 预热一次 + 配对循环命中缓存：读与算都不随 O(N²) 膨胀
    expect(calls.length).toBe(2);
    expect(vectorReads).toBeLessThanOrEqual(2);
  });
});

describe('行为等价：consolidate 实体召回（autoLink + 假 llm 驱动真实入口）', () => {
  async function makeEntityHarness() {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    // biome-ignore lint/suspicious/noExplicitAny: 同 makeStore
    await app.ctx.useModule(memoryInMemoryModule as any);
    const mem = app.ctx.getService<MemoryService>('memory');
    if (!mem) throw new Error('memory service missing');
    const store = new RelationStore(mem);
    const embedCalls: string[] = [];
    app.ctx.provide('embedding', {
      embed: async (text: string) => {
        embedCalls.push(text);
        return VEC;
      },
    } as never);
    // 最小 chat 模型：宽召回的 LLM 终判会拿到不可解析回复而跳过——本测试只关心召回前的向量路径
    app.ctx.provide('llm', { id: 'fake-chat', capabilities: ['chat'], chat: async () => ({ content: '{}' }) } as never);
    const service = new RelationService(store, app.ctx);
    return { app, mem, store, service, embedCalls };
  }

  function seedTwinEntities(mem: MemoryService, store: RelationStore, withVectors: boolean) {
    const jobs: Promise<unknown>[] = [];
    for (const id of ['x1', 'y1'] as const) {
      const name = `三角洲行动${id}`;
      const node = rawEntity(id, { name, embeddingHash: computeEntityEmbeddingHash(name, '摘要', 'topic') });
      jobs.push(mem.saveMetadata(RELATION_NAMESPACE, `entity:${id}`, node));
      if (withVectors) jobs.push(store.upsertVector('entity', id, VEC, node.embeddingHash as string));
    }
    return Promise.all(jobs);
  }

  it('hash 命中 + 向量在库：consolidate 全程零 embed 调用', async () => {
    const { app, mem, store, service, embedCalls } = await makeEntityHarness();
    await seedTwinEntities(mem, store, true);
    await service.consolidate({ autoLink: true, llm: { ctx: app.ctx, modelRef: {} } });
    expect(embedCalls, 'hash 一致且向量在库时实体召回不得重算').toHaveLength(0);
  });

  it('向量缺失自愈：重算入向量命名空间，节点文档不再内嵌', async () => {
    const { app, mem, store, service, embedCalls } = await makeEntityHarness();
    await seedTwinEntities(mem, store, false);
    await service.consolidate({ autoLink: true, llm: { ctx: app.ctx, modelRef: {} } });
    expect(embedCalls.length, '两个实体各重算一次').toBe(2);
    expect(await store.getVector('entity', 'x1')).toEqual(VEC);
    const raw = (await mem.getMetadata(RELATION_NAMESPACE, 'entity:x1')) as Record<string, unknown>;
    expect(raw.embeddingVector, '重算结果不得内嵌回节点').toBeUndefined();
    expect(raw.embeddingHash).toBe(computeEntityEmbeddingHash('三角洲行动x1', '摘要', 'topic'));
  });
});
