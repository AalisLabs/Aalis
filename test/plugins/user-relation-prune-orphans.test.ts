import { describe, expect, it } from 'vitest';
import type { BoundCommands, CommandBuilder, CommandHandler } from '../../packages/api-commands/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { type EvictionConfig, registerRelationCommands } from '../../packages/plugin-user-relation/src/commands.js';
import type { EvidenceRef } from '../../packages/plugin-user-relation/src/index.js';
import { RelationService, RelationStore } from '../../packages/plugin-user-relation/src/index.js';

// ════════════════════════════════════════════════════════════
// pruneOrphans 一趟收敛：删完悬空边后，"被引用"的统计必须只看存活边。
// 用同一份未更新的 snap.edges 统计，会让「只被悬空边引用的节点」本轮逃过
// 孤儿判定，返回计数偏小，得再跑一次才收敛。
// ════════════════════════════════════════════════════════════

async function makeService() {
  const app = new App({ name: 'T', logLevel: 'error' });
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  // 激活闸下「没激活」不报错，核一下状态，别让空存储伪装成绿
  const state = app.plugins.getPlugin(memoryInMemory.name)?.state;
  if (state !== 'active') throw new Error(`memory-inmemory 插件未激活（state=${state}）`);
  const ref = app.bind({ memory }).memory;
  const store = new RelationStore(() => ref.require());
  return { app, service: new RelationService(store) };
}

const ev = (): EvidenceRef => ({
  sessionId: 'sess1',
  messageIds: ['m1'],
  quote: 'hello',
  extractedAt: Date.now(),
});

describe('plugin-user-relation: pruneOrphans 收敛性', () => {
  it('只被悬空边引用的节点同一趟即被判为孤儿（不必再跑一次）', async () => {
    const { app, service } = await makeService();
    const orphanOnlyViaDangling = await service.createEvent({ title: '只被悬空边引用', evidence: [] });
    // 悬空边：起点 person 根本不存在（节点被绕过 cascade 删除后的残留形态）
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:ghost',
      toEventId: orphanOnlyViaDangling.id,
      role: 'participant',
      evidence: [ev()],
    });

    const first = await service.pruneOrphans();
    expect(first.deletedDanglingEdges, '悬空边应被删').toBe(1);
    expect(first.deletedEvents, '事件应在同一趟被判为孤儿').toBe(1);
    expect(await service.getEvent(orphanOnlyViaDangling.id)).toBeUndefined();

    const snap = await service.loadAll();
    expect(snap.events).toHaveLength(0);
    expect(snap.edges).toHaveLength(0);

    // 已收敛：第二趟无事可做
    const second = await service.pruneOrphans();
    expect(second).toMatchObject({ deletedDanglingEdges: 0, deletedEvents: 0, deletedPersons: 0, deletedEntities: 0 });
    await app.stop();
  });

  it('被存活边引用的节点不受影响（收紧不误伤）', async () => {
    const { app, service } = await makeService();
    await service.observePerson('onebot', 'u1');
    const kept = await service.createEvent({ title: '有真边', evidence: [] });
    await service.addPersonEventEdge({
      fromPersonId: 'onebot:u1',
      toEventId: kept.id,
      role: 'participant',
      evidence: [ev()],
    });

    const r = await service.pruneOrphans();
    expect(r.deletedDanglingEdges).toBe(0);
    expect(r.deletedEvents).toBe(0);
    expect(r.deletedPersons).toBe(0);
    const snap = await service.loadAll();
    expect(snap.events).toHaveLength(1);
    expect(snap.edges).toHaveLength(1);
    await app.stop();
  });
});

// ════════════════════════════════════════════════════════════
// /relation orphans 与 cleanup orphans 与 pruneOrphans 同口径：6 种边都算引用。
// 命令侧曾自带一份只认 4 种边的判定，只挂 event-entity / entity-entity 边的节点
// 被列成孤儿，cleanup orphans 随即把它们连同边一起物理删除。
// ════════════════════════════════════════════════════════════

/** 捕获 /relation 指令的 action，按指令名直接调用 */
function captureCommands(): { commands: BoundCommands; run(name: string): Promise<string | undefined> } {
  const handlers = new Map<string, CommandHandler>();
  const commands = {
    command(name: string): CommandBuilder {
      const builder: CommandBuilder = {
        alias: () => builder,
        option: () => builder,
        usage: () => builder,
        example: () => builder,
        action(handler) {
          handlers.set(name, handler);
          return builder;
        },
      };
      return builder;
    },
  } as unknown as BoundCommands;
  return {
    commands,
    async run(name) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`指令未注册：${name}`);
      return handler({ session: { sessionId: 's', platform: 'test', raw: '' }, options: {} });
    },
  };
}

const NO_EVICTION: EvictionConfig = {
  maxPersons: 0,
  maxEvents: 0,
  maxEntities: 0,
  maxEdges: 0,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
  pagerankEpsilon: 0.0001,
  hysteresisPct: 0.2,
  targetPct: 0.8,
  weightDecayHalfLifeDays: 0,
  weightDecayFloor: 0.3,
  communityAlgorithm: 'louvain',
};

describe('plugin-user-relation: /relation orphans 与 pruneOrphans 同口径', () => {
  async function makeGraph() {
    const { app, service } = await makeService();
    const cmd = captureCommands();
    registerRelationCommands(
      { commands: cmd.commands, platform: {} as never, llm: {} as never, logger: app.logger },
      service,
      {
        eviction: NO_EVICTION,
        consolidateAutoLink: false,
        consolidateSkipLowScorePairs: false,
        consolidateLowScoreThreshold: 0,
      },
    );
    // 只挂 event-entity 边：事件与实体都不是孤儿
    const onlyEventEntity = await service.createEvent({
      title: '只挂实体的事件',
      sessionScope: 'global',
      evidence: [],
    });
    const partOfTarget = await service.createEntity({ name: '被事件挂载的实体', entityKind: 'topic', evidence: [] });
    await service.addEventEntityEdge({
      fromEventId: onlyEventEntity.id,
      toEntityId: partOfTarget.id,
      relationType: 'part-of',
      evidence: [ev()],
    });
    // 只挂 entity-entity 边：两端实体都不是孤儿
    const child = await service.createEntity({ name: '子实体', entityKind: 'topic', evidence: [] });
    const parent = await service.createEntity({ name: '父实体', entityKind: 'topic', evidence: [] });
    await service.addEntityEntityEdge({
      fromEntityId: child.id,
      toEntityId: parent.id,
      relationType: 'part-of',
      evidence: [ev()],
    });
    // 真孤儿：没有任何边
    const orphan = await service.createEntity({ name: '真孤儿', entityKind: 'topic', evidence: [] });
    return { app, service, cmd, kept: [onlyEventEntity.id, partOfTarget.id, child.id, parent.id], orphan };
  }

  it('relation.orphans 只列出不被任何边引用的节点', async () => {
    const { app, cmd, kept, orphan } = await makeGraph();
    const out = (await cmd.run('relation.orphans')) ?? '';
    expect(out).toContain(orphan.id);
    for (const id of kept) expect(out, `被 event-entity / entity-entity 边引用的 ${id} 不是孤儿`).not.toContain(id);
    await app.stop();
  });

  it('relation.cleanup.orphans 只删真孤儿，不误删挂 event-entity / entity-entity 边的节点', async () => {
    const { app, service, cmd, kept, orphan } = await makeGraph();
    await cmd.run('relation.cleanup.orphans');
    const snap = await service.loadAll();
    const alive = new Set([...snap.events.map(e => e.id), ...snap.entities.map(e => e.id)]);
    for (const id of kept) expect(alive.has(id), `${id} 被误删`).toBe(true);
    expect(alive.has(orphan.id)).toBe(false);
    expect(snap.edges).toHaveLength(2);
    await app.stop();
  });
});
