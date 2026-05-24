import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import type { MemoryService } from '../../packages/plugin-memory-api/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import { RelationService } from '../../packages/plugin-user-relation/src/service.js';
import { RelationStore } from '../../packages/plugin-user-relation/src/store.js';

async function setup() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(memoryInMemoryModule);
  const mem = app.ctx.getService<MemoryService>('memory');
  if (!mem) throw new Error('no memory');
  return new RelationService(new RelationStore(mem));
}

describe('plugin-user-relation: 多层遍历', () => {
  describe('traverseSubgraph', () => {
    it('depth=0 表示不限：返回全连通子图', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a', 'A');
      await svc.observePerson('onebot', 'b', 'B');
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
      });
      const sub = await svc.traverseSubgraph({ startNodeIds: ['onebot:a'], maxDepth: 0, maxBreadth: 10 });
      const ids = new Set(sub.persons.map(p => p.id));
      expect(ids.has('onebot:a')).toBe(true);
      expect(ids.has('onebot:b')).toBe(true);
      expect(sub.edges.length).toBe(1);
    });

    it('depth=1 包含直接邻居人与事件', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a', 'A');
      await svc.observePerson('onebot', 'b', 'B');
      const ev = await svc.createEvent({ title: 'E', evidence: [] });
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
      });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev.id, role: 'participant' });
      const sub = await svc.traverseSubgraph({ startNodeIds: ['onebot:a'], maxDepth: 1, maxBreadth: 10 });
      const ids = new Set(sub.persons.map(p => p.id));
      expect(ids.has('onebot:a')).toBe(true);
      expect(ids.has('onebot:b')).toBe(true);
      expect(sub.events.map(e => e.id)).toContain(ev.id);
    });

    it('depth=2 可触达同事件的其他参与者', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      await svc.observePerson('onebot', 'c');
      const ev = await svc.createEvent({ title: 'E', evidence: [] });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev.id, role: 'participant' });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:b', toEventId: ev.id, role: 'participant' });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:c', toEventId: ev.id, role: 'participant' });
      const sub = await svc.traverseSubgraph({ startNodeIds: ['onebot:a'], maxDepth: 2, maxBreadth: 10 });
      const ids = new Set(sub.persons.map(p => p.id));
      expect(ids.has('onebot:b')).toBe(true);
      expect(ids.has('onebot:c')).toBe(true);
    });

    it('maxBreadth 按 weight 降序截断邻居', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      for (const u of ['b', 'c', 'd', 'e']) {
        await svc.observePerson('onebot', u);
      }
      // 故意造不同 weight
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
        weight: 0.9,
      });
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:c',
        relationType: 'friend',
        weight: 0.1,
      });
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:d',
        relationType: 'friend',
        weight: 0.8,
      });
      const sub = await svc.traverseSubgraph({ startNodeIds: ['onebot:a'], maxDepth: 1, maxBreadth: 2 });
      const ids = new Set(sub.persons.map(p => p.id));
      // 最高 weight 的 b、d 应入选，c 不应
      expect(ids.has('onebot:b')).toBe(true);
      expect(ids.has('onebot:d')).toBe(true);
      expect(ids.has('onebot:c')).toBe(false);
    });

    it('对循环图不会无限展开（visited 去重）', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
      });
      const sub = await svc.traverseSubgraph({ startNodeIds: ['onebot:a'], maxDepth: 10, maxBreadth: 10 });
      expect(sub.persons.length).toBe(2);
    });
  });

  describe('findPath', () => {
    it('起点=终点 → 单节点路径', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      const r = await svc.findPath('onebot:a', 'onebot:a', 3);
      expect(r).not.toBeNull();
      expect(r?.edges).toEqual([]);
      expect(r?.nodes.length).toBe(1);
    });

    it('直接好友 → 1 边路径', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
      });
      const r = await svc.findPath('onebot:a', 'onebot:b', 3);
      expect(r?.edges.length).toBe(1);
    });

    it('通过事件桥连接 → 2 边路径', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const ev = await svc.createEvent({ title: 'E', evidence: [] });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev.id, role: 'participant' });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:b', toEventId: ev.id, role: 'participant' });
      const r = await svc.findPath('onebot:a', 'onebot:b', 3);
      expect(r?.edges.length).toBe(2);
      expect(r?.nodes.length).toBe(3); // a, event, b
    });

    it('超出 maxDepth → null', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const ev = await svc.createEvent({ title: 'E', evidence: [] });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev.id, role: 'participant' });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:b', toEventId: ev.id, role: 'participant' });
      const r = await svc.findPath('onebot:a', 'onebot:b', 1);
      expect(r).toBeNull();
    });

    it('无连通 → null', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const r = await svc.findPath('onebot:a', 'onebot:b', 5);
      expect(r).toBeNull();
    });
  });

  describe('searchEvents', () => {
    it('substring 匹配标题', async () => {
      const svc = await setup();
      await svc.createEvent({ title: '直播讨论', evidence: [] });
      await svc.createEvent({ title: '其他事件', evidence: [] });
      const r = await svc.searchEvents({ keyword: '直播' });
      expect(r.length).toBe(1);
      expect(r[0]?.title).toBe('直播讨论');
    });

    it('匹配 summary', async () => {
      const svc = await setup();
      await svc.createEvent({ title: 'X', summary: '包含 keyword 的描述', evidence: [] });
      const r = await svc.searchEvents({ keyword: 'KEYWORD' });
      expect(r.length).toBe(1);
    });

    it('按 lastReinforcedAt 倒序', async () => {
      const svc = await setup();
      const e1 = await svc.createEvent({ title: '老', evidence: [] });
      await new Promise(r => setTimeout(r, 2));
      const e2 = await svc.createEvent({ title: '新', evidence: [] });
      const r = await svc.searchEvents({ keyword: '' });
      expect(r[0]?.id).toBe(e2.id);
      expect(r[1]?.id).toBe(e1.id);
    });

    it('limit 限制结果数', async () => {
      const svc = await setup();
      for (let i = 0; i < 5; i++) {
        await svc.createEvent({ title: `E${i}`, evidence: [] });
      }
      const r = await svc.searchEvents({ limit: 2 });
      expect(r.length).toBe(2);
    });

    it('空关键词 + 无事件 → []', async () => {
      const svc = await setup();
      const r = await svc.searchEvents({});
      expect(r).toEqual([]);
    });
  });
});
