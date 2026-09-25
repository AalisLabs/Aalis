import { afterEach, describe, expect, it } from 'vitest';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
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
  embeddingHashFor,
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

const apps: App[] = [];

afterEach(async () => {
  // 逐个 try/finally：任一 stop 抛错也不能让后面的实例漏掉（数组已 splice，漏了就永久泄漏）
  for (const a of apps.splice(0)) {
    try {
      await a.stop();
    } catch {
      /* 停不掉也要继续停下一个 */
    }
  }
});

async function makeStore() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  // 装载过激活闸：没激活时服务根本不在，后面的断言会以「取不到 memory」的形式含糊失败
  if (app.plugins.getPlugin(memoryInMemory.name)?.state !== 'active') {
    throw new Error('memory 插件未激活');
  }
  const mem = app.bind({ memory }).memory.require();
  return { app, mem, store: new RelationStore(() => mem) };
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

  it('embed 期间节点被并发删除：不写向量（死 uuid 的向量永不可回收）', async () => {
    const { mem, store } = await makeStore();
    const service = new RelationService(store);
    await seedTwinEvents(mem, store, false);
    const embedding = {
      embed: async (text: string) => {
        // embed 的 await 窗口内，其他会话的提取合并把 a1 删了
        if (text.startsWith('开黑打三角洲a1')) await store.deleteEventCascade('a1');
        return VEC;
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: 同上
    await (service as any)._consolidateEventDuplicates({ embedding, dryRun: true });
    expect(await store.getEvent('a1')).toBeUndefined();
    expect(await store.getVector('event', 'a1'), '死节点的向量一旦写入就成了孤儿文档').toBeUndefined();
    expect(await store.getVector('event', 'b1'), '活节点照常落向量').toEqual(VEC);
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
  async function makeEntityHarness(modelId?: string) {
    const { app, mem, store } = await makeStore();
    // 宿主侧绑定：桩服务经描述符发布，服务引用直接交给 RelationService
    const host = app.bind({ provide, embedding, llm });
    const embedCalls: string[] = [];
    host.provide(embedding, {
      ...(modelId ? { modelId } : {}),
      embed: async (text: string) => {
        embedCalls.push(text);
        return VEC;
      },
    });
    // 最小 chat 模型：宽召回的 LLM 终判会拿到不可解析回复而跳过——本测试只关心召回前的向量路径
    host.provide(llm, { id: 'fake-chat', capabilities: ['chat'], chat: async () => ({ content: '{}' }) } as never);
    const service = new RelationService(store, app.logger, host.embedding);
    return { app, mem, store, service, host, embedCalls };
  }

  function seedTwinEntities(mem: MemoryService, store: RelationStore, withVectors: boolean, modelId?: string) {
    const jobs: Promise<unknown>[] = [];
    for (const id of ['x1', 'y1'] as const) {
      const name = `三角洲行动${id}`;
      const embeddingHash = embeddingHashFor(computeEntityEmbeddingHash(name, '摘要', 'topic'), modelId);
      const node = rawEntity(id, { name, embeddingHash });
      jobs.push(mem.saveMetadata(RELATION_NAMESPACE, `entity:${id}`, node));
      if (withVectors) jobs.push(store.upsertVector('entity', id, VEC, node.embeddingHash as string));
    }
    return Promise.all(jobs);
  }

  it('hash 命中 + 向量在库：consolidate 全程零 embed 调用', async () => {
    const { mem, store, service, host, embedCalls } = await makeEntityHarness();
    await seedTwinEntities(mem, store, true);
    await service.consolidate({ autoLink: true, llm: { models: host.llm, modelRef: {} } });
    expect(embedCalls, 'hash 一致且向量在库时实体召回不得重算').toHaveLength(0);
  });

  it('向量缺失自愈：重算入向量命名空间，节点文档不再内嵌', async () => {
    const { mem, store, service, host, embedCalls } = await makeEntityHarness();
    await seedTwinEntities(mem, store, false);
    await service.consolidate({ autoLink: true, llm: { models: host.llm, modelRef: {} } });
    expect(embedCalls.length, '两个实体各重算一次').toBe(2);
    expect(await store.getVector('entity', 'x1')).toEqual(VEC);
    const raw = (await mem.getMetadata(RELATION_NAMESPACE, 'entity:x1')) as Record<string, unknown>;
    expect(raw.embeddingVector, '重算结果不得内嵌回节点').toBeUndefined();
    expect(raw.embeddingHash).toBe(computeEntityEmbeddingHash('三角洲行动x1', '摘要', 'topic'));
  });

  it('换模型即失效：库里是模型 A 的向量，提供者换成模型 B → 两个实体都重算', async () => {
    const { mem, store, service, host, embedCalls } = await makeEntityHarness('B');
    await seedTwinEntities(mem, store, true, 'A');
    await service.consolidate({ autoLink: true, llm: { models: host.llm, modelRef: {} } });
    expect(embedCalls.length, '跨向量空间的旧向量不得被当作现行向量').toBe(2);
    const raw = (await mem.getMetadata(RELATION_NAMESPACE, 'entity:x1')) as Record<string, unknown>;
    expect(raw.embeddingHash).toBe(embeddingHashFor(computeEntityEmbeddingHash('三角洲行动x1', '摘要', 'topic'), 'B'));
  });

  it('同模型不重算：库里向量与提供者 modelId 一致 → 零 embed 调用', async () => {
    const { mem, store, service, host, embedCalls } = await makeEntityHarness('A');
    await seedTwinEntities(mem, store, true, 'A');
    await service.consolidate({ autoLink: true, llm: { models: host.llm, modelRef: {} } });
    expect(embedCalls).toHaveLength(0);
  });
});

describe('换模型即失效：事件向量（modelId 并入失效键）', () => {
  const VEC_B = Array.from({ length: 8 }, (_, i) => (8 - i) / 10);

  /** 两个事件的节点 hash 与库里向量都属于 modelId（undefined = 升级前的纯文本 hash） */
  async function seedEventsFor(mem: MemoryService, store: RelationStore, modelId: string | undefined) {
    for (const id of ['a1', 'b1'] as const) {
      const title = `开黑打三角洲${id}`;
      const embeddingHash = embeddingHashFor(computeEventEmbeddingHash(title, '摘要'), modelId);
      await mem.saveMetadata(RELATION_NAMESPACE, eventKey(id), rawEvent(id, { title, embeddingHash }));
      await store.upsertVector('event', id, VEC, embeddingHash);
    }
  }

  function stub(modelId: string, vec: number[]) {
    const calls: string[] = [];
    const embedding = {
      modelId,
      embed: async (text: string) => {
        calls.push(text);
        return vec;
      },
    };
    return { embedding, calls };
  }

  it('库里是模型 A 的向量，提供者换成模型 B → 全部重算并替换', async () => {
    const { mem, store } = await makeStore();
    const service = new RelationService(store);
    await seedEventsFor(mem, store, 'A');
    const { embedding, calls } = stub('B', VEC_B);

    // biome-ignore lint/suspicious/noExplicitAny: 私有方法 dryRun 直驱
    await (service as any)._consolidateEventDuplicates({ embedding, dryRun: true });
    expect(calls.length, '跨向量空间的旧向量不得被当作现行向量').toBe(2);
    expect(await store.getVector('event', 'a1')).toEqual(VEC_B);
  });

  it('升级前的纯文本 hash 遇到声明了 modelId 的提供者 → 重算一次', async () => {
    const { mem, store } = await makeStore();
    const service = new RelationService(store);
    await seedEventsFor(mem, store, undefined);
    const { embedding, calls } = stub('A', VEC);

    // biome-ignore lint/suspicious/noExplicitAny: 同上
    await (service as any)._consolidateEventDuplicates({ embedding, dryRun: true });
    expect(calls).toHaveLength(2);
  });

  it('同模型不重算：库里向量与提供者 modelId 一致 → 零 embed 调用', async () => {
    const { mem, store } = await makeStore();
    const service = new RelationService(store);
    await seedEventsFor(mem, store, 'A');
    const { embedding, calls } = stub('A', VEC);

    // biome-ignore lint/suspicious/noExplicitAny: 同上
    await (service as any)._consolidateEventDuplicates({ embedding, dryRun: true });
    expect(calls).toHaveLength(0);
  });
});
