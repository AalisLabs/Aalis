import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { RelationService, RelationStore } from '../../packages/plugin-user-relation/src/index.js';

// ════════════════════════════════════════════════════════════
// 衰减回写（rewriteWeights）与 PageRank 回写（evictByQuota 第 4 步）按快照逐条写库，
// 生产规模要跑十几秒到数分钟。期间执行 /clear all（或清空进行中才启动回写）回执报「关系图已清空」，
// 循环却继续把快照里剩下的节点与边写回，关系图部分复活。清空之后的写入一律不得落库。
// 清空开始时已发出、尚未落库的写入（mongodb 上可能晚于提交删除才落地），清空等它落定再列举删除。
// 清空因此会等在飞的写入：用例里的钩子若在写入的 Promise 内部 await 清空，就成了自己等自己，
// 所以钩子只发起清空，由用例在回写返回后再 await。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

/**
 * 关系图服务 + memory 包装：可在「下一次命中的 saveMetadata 落盘之前 / 之后」插入动作，
 * 也可在 commitMetadata 执行前 / 执行后、返回前插入动作（让清空停在指定阶段）
 */
async function makeWorld() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ memory });
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.idle();
  const mem = host.memory.current;
  if (!mem) throw new Error('memory service missing');
  let afterSave: { match: (key: string) => boolean; run: () => Promise<unknown> } | undefined;
  let commitHooks: { before?: () => Promise<unknown>; after?: () => Promise<unknown> } = {};
  let beforeSave: { match: (key: string) => boolean; run: () => Promise<unknown> } | undefined;
  const wrapped = new Proxy(mem, {
    get(target, prop) {
      if (prop === 'commitMetadata') {
        return async (ops: Parameters<typeof target.commitMetadata>[0]) => {
          await commitHooks.before?.();
          await target.commitMetadata(ops);
          await commitHooks.after?.();
        };
      }
      if (prop === 'saveMetadata') {
        return async (ns: string, key: string, data: Record<string, unknown>) => {
          const lag = beforeSave;
          if (lag?.match(key)) {
            beforeSave = undefined;
            await lag.run();
          }
          await target.saveMetadata(ns, key, data);
          const hook = afterSave;
          if (hook?.match(key)) {
            afterSave = undefined;
            await hook.run();
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = new RelationStore(() => wrapped);
  const service = new RelationService(store);
  const onceAfterSave = (match: (key: string) => boolean, run: () => Promise<unknown>) => {
    afterSave = { match, run };
  };
  const onCommit = (hooks: typeof commitHooks) => {
    commitHooks = hooks;
  };
  const onceBeforeSave = (match: (key: string) => boolean, run: () => Promise<unknown>) => {
    beforeSave = { match, run };
  };
  return { store, service, onceAfterSave, onCommit, onceBeforeSave };
}

/** 两个人各参与同样的事件、都提到同样的实体，都不是孤儿（淘汰前的孤儿清理不会删掉它们） */
async function seedGraph(service: RelationService, store: RelationStore, lastReinforcedAt?: number) {
  await service.observePerson('onebot', 'u1', 'Alice');
  await service.observePerson('onebot', 'u2', 'Bob');
  for (const title of ['事件一', '事件二', '事件三']) {
    const ev = await service.createEvent({ title, evidence: [], sessionScope: 's1' });
    await service.addPersonEventEdge({ fromPersonId: 'onebot:u1', toEventId: ev.id, role: 'participant' });
    await service.addPersonEventEdge({ fromPersonId: 'onebot:u2', toEventId: ev.id, role: 'participant' });
  }
  for (const name of ['实体一', '实体二', '实体三']) {
    const en = await service.createEntity({ name, entityKind: 'thing', evidence: [] });
    await service.addPersonEntityEdge({ fromPersonId: 'onebot:u1', toEntityId: en.id, role: 'mentioned' });
    await service.addPersonEntityEdge({ fromPersonId: 'onebot:u2', toEntityId: en.id, role: 'mentioned' });
  }
  if (lastReinforcedAt !== undefined) {
    const snap = await service.loadAll();
    for (const ev of snap.events) await store.upsertEvent({ ...ev, lastReinforcedAt });
    for (const en of snap.entities) await store.upsertEntity({ ...en, lastReinforcedAt });
    for (const e of snap.edges) await store.upsertEdge({ ...e, lastReinforcedAt });
  }
}

const graphSize = async (service: RelationService) => {
  const g = await service.loadAll();
  return { persons: g.persons.length, events: g.events.length, entities: g.entities.length, edges: g.edges.length };
};
const EMPTY = { persons: 0, events: 0, entities: 0, edges: 0 };

describe('user-relation: 批量回写期间清空关系图，不得部分复活', () => {
  // 事件、实体、边三段循环依次写回，每段各有一处清空检查
  it.each([
    ['个事件', 'event:'],
    ['个实体', 'entity:'],
    ['条边', 'edge:'],
  ])('rewriteWeights 写回第一%s后图被清空：快照剩余部分不写回', async (_label, prefix) => {
    const { store, service, onceAfterSave } = await makeWorld();
    await seedGraph(service, store, Date.now() - 100 * 86_400_000);

    let clearing: Promise<number> | undefined;
    onceAfterSave(
      key => key.startsWith(prefix),
      async () => {
        clearing = store.clearAll({ info() {} });
      },
    );
    await service.rewriteWeights({ halfLifeDays: 30, floor: 0.3 });
    await clearing;

    expect(await graphSize(service)).toEqual(EMPTY);
  });

  it('rewriteWeights 途中开始清空、删除已落库而清空尚未返回：不在其间写回已删的键', async () => {
    // mongodb 的提交按序逐条删、耗时长：删过的键若在提交返回前被回写即复活
    const { store, service, onceAfterSave, onCommit } = await makeWorld();
    await seedGraph(service, store, Date.now() - 100 * 86_400_000);

    let deletionsApplied!: () => void;
    const applied = new Promise<void>(r => (deletionsApplied = r));
    let releaseReturn!: () => void;
    const held = new Promise<void>(r => (releaseReturn = r));
    onCommit({
      after: () => {
        deletionsApplied();
        return held;
      },
    });
    let clearing: Promise<number> | undefined;
    onceAfterSave(
      key => key.startsWith('event:'),
      async () => {
        clearing = store.clearAll({ info() {} });
      },
    );
    const rewriting = service.rewriteWeights({ halfLifeDays: 30, floor: 0.3 });
    await applied;
    await rewriting;
    releaseReturn();

    expect(await clearing).toBeGreaterThan(0);
    expect(await graphSize(service)).toEqual(EMPTY);
  });

  it('清空已开始、尚未提交时启动 rewriteWeights：读到的清空前全图在清空完成后不写回', async () => {
    const { store, service, onceAfterSave, onCommit } = await makeWorld();
    await seedGraph(service, store, Date.now() - 100 * 86_400_000);

    let releaseCommit!: () => void;
    const held = new Promise<void>(r => (releaseCommit = r));
    onCommit({ before: () => held });
    const clearing = store.clearAll({ info() {} });
    // 回写写完第一个事件时放行提交并等清空完成：此后的写入都落在清空之后
    onceAfterSave(
      key => key.startsWith('event:'),
      async () => {
        releaseCommit();
        await clearing;
      },
    );
    await service.rewriteWeights({ halfLifeDays: 30, floor: 0.3 });

    expect(await clearing).toBeGreaterThan(0);
    expect(await graphSize(service)).toEqual(EMPTY);
  });

  it('evictByQuota 写回第一个人物的 PageRank 后图被清空：其余人物不以快照拷贝写回', async () => {
    const { store, service, onceAfterSave } = await makeWorld();
    await seedGraph(service, store);

    let clearing: Promise<number> | undefined;
    onceAfterSave(
      key => key.startsWith('person:'),
      async () => {
        clearing = store.clearAll({ info() {} });
      },
    );
    await service.evictByQuota({ maxEvents: 1000, maxEntities: 1000, maxEdges: 10_000 });
    await clearing;

    expect(await graphSize(service)).toEqual(EMPTY);
  });

  it('回写的一条已发出、落库晚于清空提交：清空等它落定再删，不写回', async () => {
    // mongodb 上写入与清空的提交走连接池里的不同连接，先发出的写可能晚于提交落地
    const { store, service, onceBeforeSave } = await makeWorld();
    await seedGraph(service, store, Date.now() - 100 * 86_400_000);

    let clearing: Promise<number> | undefined;
    onceBeforeSave(
      key => key.startsWith('event:'),
      async () => {
        await new Promise(r => setTimeout(r, 0)); // 让出一拍：这次写入已从 store 发出
        clearing = store.clearAll({ info() {} });
        await new Promise(r => setTimeout(r, 20)); // 落库晚到
      },
    );
    await service.rewriteWeights({ halfLifeDays: 30, floor: 0.3 });

    expect(await clearing).toBeGreaterThan(0);
    expect(await graphSize(service)).toEqual(EMPTY);
  });
});
