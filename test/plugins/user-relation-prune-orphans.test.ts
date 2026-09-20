import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import type { EvidenceRef } from '../../packages/plugin-user-relation/src/index.js';
import { RelationService, RelationStore } from '../../packages/plugin-user-relation/src/index.js';

// ════════════════════════════════════════════════════════════
// pruneOrphans 一趟收敛：删完悬空边后，"被引用"的统计必须只看存活边。
// 用同一份未更新的 snap.edges 统计，会让「只被悬空边引用的节点」本轮逃过
// 孤儿判定，返回计数偏小，得再跑一次才收敛。
// ════════════════════════════════════════════════════════════

async function makeService() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  // 激活闸下「没激活」不报错，核一下状态，别让空存储伪装成绿
  const state = app.plugins.getPlugin(memoryInMemory.name)?.state;
  if (state !== 'active') throw new Error(`memory-inmemory 插件未激活（state=${state}）`);
  const store = new RelationStore(app.bind({ memory }).memory.require());
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
    expect(first.deletedEventIds, '事件应在同一趟被判为孤儿').toEqual([orphanOnlyViaDangling.id]);

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
