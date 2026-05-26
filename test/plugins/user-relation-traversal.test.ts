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

  describe('scoreBetween', () => {
    it('同节点 → score=1', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      const r = await svc.scoreBetween('onebot:a', 'onebot:a');
      expect(r.score).toBe(1);
      expect(r.shortestLength).toBe(0);
    });

    it('不存在的节点 → score=0', async () => {
      const svc = await setup();
      const r = await svc.scoreBetween('onebot:x', 'onebot:y');
      expect(r.score).toBe(0);
      expect(r.shortestLength).toBeNull();
      expect(r.topPaths).toEqual([]);
    });

    it('直接好友 → directlyConnected=true，score>0', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
      });
      const r = await svc.scoreBetween('onebot:a', 'onebot:b');
      expect(r.directlyConnected).toBe(true);
      expect(r.shortestLength).toBe(1);
      expect(r.score).toBeGreaterThan(0);
      expect(r.topPaths.length).toBeGreaterThan(0);
    });

    it('多条间接路径累加 > 单条路径', async () => {
      const buildPair = async (withSecondBridge: boolean) => {
        const svc = await setup();
        await svc.observePerson('onebot', 'a');
        await svc.observePerson('onebot', 'b');
        const ev1 = await svc.createEvent({ title: 'E1', evidence: [] });
        await svc.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev1.id, role: 'participant' });
        await svc.addPersonEventEdge({ fromPersonId: 'onebot:b', toEventId: ev1.id, role: 'participant' });
        if (withSecondBridge) {
          const ev2 = await svc.createEvent({ title: 'E2', evidence: [] });
          await svc.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev2.id, role: 'participant' });
          await svc.addPersonEventEdge({ fromPersonId: 'onebot:b', toEventId: ev2.id, role: 'participant' });
        }
        return svc.scoreBetween('onebot:a', 'onebot:b');
      };
      const r1 = await buildPair(false);
      const r2 = await buildPair(true);
      expect(r2.pathsConsidered).toBeGreaterThan(r1.pathsConsidered);
      expect(r2.rawScore).toBeGreaterThan(r1.rawScore);
    });

    it('无连通 → score=0', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const r = await svc.scoreBetween('onebot:a', 'onebot:b');
      expect(r.score).toBe(0);
      expect(r.pathsConsidered).toBe(0);
    });

    it('直接连接 boost > 仅间接 2 跳路径（同等其它条件）', async () => {
      const buildDirect = async () => {
        const svc = await setup();
        await svc.observePerson('onebot', 'a');
        await svc.observePerson('onebot', 'b');
        await svc.addPersonPersonEdge({
          fromPersonId: 'onebot:a',
          toPersonId: 'onebot:b',
          relationType: 'friend',
        });
        return svc.scoreBetween('onebot:a', 'onebot:b');
      };
      const buildIndirect = async () => {
        const svc = await setup();
        await svc.observePerson('onebot', 'a');
        await svc.observePerson('onebot', 'b');
        await svc.observePerson('onebot', 'c');
        await svc.addPersonPersonEdge({
          fromPersonId: 'onebot:a',
          toPersonId: 'onebot:c',
          relationType: 'friend',
        });
        await svc.addPersonPersonEdge({
          fromPersonId: 'onebot:c',
          toPersonId: 'onebot:b',
          relationType: 'friend',
        });
        return svc.scoreBetween('onebot:a', 'onebot:b');
      };
      const direct = await buildDirect();
      const indirect = await buildIndirect();
      expect(direct.directlyConnected).toBe(true);
      expect(indirect.directlyConnected).toBe(false);
      expect(direct.score).toBeGreaterThan(indirect.score);
    });

    it('Adamic-Adar：小度共同邻居 > 大度共同邻居（同等路径数）', async () => {
      // 场景1：a/b 通过 1 个 person-person 共同朋友 C 连接（C 只有 a/b 两个邻居 = 度 2）
      const smallDeg = async () => {
        const svc = await setup();
        await svc.observePerson('onebot', 'a');
        await svc.observePerson('onebot', 'b');
        await svc.observePerson('onebot', 'c');
        await svc.addPersonPersonEdge({ fromPersonId: 'onebot:a', toPersonId: 'onebot:c', relationType: 'friend' });
        await svc.addPersonPersonEdge({ fromPersonId: 'onebot:c', toPersonId: 'onebot:b', relationType: 'friend' });
        return svc.scoreBetween('onebot:a', 'onebot:b');
      };
      // 场景2：a/b 通过 1 个共同事件 E 连接，E 还牵涉 5 个其它人 → E 度 = 7
      const bigDeg = async () => {
        const svc = await setup();
        await svc.observePerson('onebot', 'a');
        await svc.observePerson('onebot', 'b');
        const ev = await svc.createEvent({ title: 'big', evidence: [] });
        await svc.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev.id, role: 'participant' });
        await svc.addPersonEventEdge({ fromPersonId: 'onebot:b', toEventId: ev.id, role: 'participant' });
        for (let i = 0; i < 5; i++) {
          await svc.observePerson('onebot', `p${i}`);
          await svc.addPersonEventEdge({ fromPersonId: `onebot:p${i}`, toEventId: ev.id, role: 'participant' });
        }
        return svc.scoreBetween('onebot:a', 'onebot:b');
      };
      const r1 = await smallDeg();
      const r2 = await bigDeg();
      expect(r1.commonNeighbors.length).toBe(1);
      expect(r2.commonNeighbors.length).toBe(1);
      // 小度共同邻居 AA 贡献更大
      expect(r1.commonNeighbors[0]!.aaContribution).toBeGreaterThan(r2.commonNeighbors[0]!.aaContribution);
    });

    it('mode 默认 symmetric，返回 mode 字段', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      await svc.addPersonPersonEdge({ fromPersonId: 'onebot:a', toPersonId: 'onebot:b', relationType: 'friend' });
      const r = await svc.scoreBetween('onebot:a', 'onebot:b');
      expect(r.mode).toBe('symmetric');
      expect(r.forwardKatzScore).toBeGreaterThan(0);
    });

    it('directed 模式：admirer A→B 单向声明，score(B,A)=0', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'fan');
      await svc.observePerson('onebot', 'idol');
      // 粉丝→偶像：admirer 必须主动方写
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:fan',
        toPersonId: 'onebot:idol',
        relationType: 'admirer',
      });
      const ab = await svc.scoreBetween('onebot:fan', 'onebot:idol', { mode: 'directed' });
      const ba = await svc.scoreBetween('onebot:idol', 'onebot:fan', { mode: 'directed' });
      expect(ab.katzScore).toBeGreaterThan(0);
      expect(ab.directlyConnected).toBe(true);
      expect(ba.katzScore).toBe(0);
      // 但 AA 共同邻居此场景为空，所以 score 也是 0
      expect(ba.score).toBe(0);
      expect(ba.backwardKatzScore).toBe(0);
    });

    it('symmetric 模式：admirer 单向，但 score(A,B)=score(B,A) 同值', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'fan');
      await svc.observePerson('onebot', 'idol');
      await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:fan',
        toPersonId: 'onebot:idol',
        relationType: 'admirer',
      });
      const ab = await svc.scoreBetween('onebot:fan', 'onebot:idol', { mode: 'symmetric' });
      const ba = await svc.scoreBetween('onebot:idol', 'onebot:fan', { mode: 'symmetric' });
      expect(ab.score).toBeGreaterThan(0);
      // symmetric 取 max(forward,backward)；fan→idol 那条弧两端互换后角色互换
      expect(ba.score).toBeCloseTo(ab.score, 6);
      // forward/backward 在两次调用中是镜像关系
      expect(ba.backwardKatzScore).toBeCloseTo(ab.forwardKatzScore, 6);
      expect(ba.forwardKatzScore).toBeCloseTo(ab.backwardKatzScore, 6);
    });

    it('directed：仅单方面写 friend（仅 A→B），B 视角看 A 无 katz 路径', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      await svc.addPersonPersonEdge({ fromPersonId: 'onebot:a', toPersonId: 'onebot:b', relationType: 'friend' });
      const ba = await svc.scoreBetween('onebot:b', 'onebot:a', { mode: 'directed' });
      expect(ba.katzScore).toBe(0);
      expect(ba.shortestLength).toBeNull();
    });

    it('桥型 person-event：参与即对称，两 mode 下都互通', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const ev = await svc.createEvent({ title: 'meet', evidence: [] });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:a', toEventId: ev.id, role: 'participant' });
      await svc.addPersonEventEdge({ fromPersonId: 'onebot:b', toEventId: ev.id, role: 'participant' });
      const ab = await svc.scoreBetween('onebot:a', 'onebot:b', { mode: 'directed' });
      const ba = await svc.scoreBetween('onebot:b', 'onebot:a', { mode: 'directed' });
      expect(ab.katzScore).toBeGreaterThan(0);
      expect(ba.katzScore).toBeGreaterThan(0);
      // 桥型对称：两方向 katz 相等
      expect(ab.katzScore).toBeCloseTo(ba.katzScore, 6);
    });

    it('topPaths 携带 direction 字段', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      await svc.addPersonPersonEdge({ fromPersonId: 'onebot:a', toPersonId: 'onebot:b', relationType: 'friend' });
      const r = await svc.scoreBetween('onebot:a', 'onebot:b', { mode: 'symmetric' });
      expect(r.topPaths.length).toBeGreaterThan(0);
      for (const p of r.topPaths) {
        expect(['forward', 'backward']).toContain(p.direction);
      }
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

  describe('correctEdge', () => {
    it('weaken 成功降低 weight 并写入 weightHistory', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const e = await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
        weight: 0.3,
      });
      const r = await svc.correctEdge({ edgeId: e.id, action: 'weaken', reason: '关系淡化' });
      expect(r.action).toBe('weakened');
      expect(r.to).toBeLessThan(r.from);
      expect(r.edge?.weight).toBeLessThan(0.3);
      expect((r.edge?.weightHistory ?? []).length).toBe(1);
      expect(r.edge?.weightHistory?.[0]?.action).toBe('weaken');
      expect(r.edge?.weightHistory?.[0]?.reason).toBe('关系淡化');
    });

    it('strengthen 成功提高 weight 但封顶 1', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const e = await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
        weight: 0.8,
      });
      const r = await svc.correctEdge({ edgeId: e.id, action: 'strengthen', multiplier: 2, reason: '关键关系' });
      expect(r.action).toBe('strengthened');
      expect(r.edge?.weight).toBe(1);
    });

    it('weight ≥ 0.5 时禁止直接 remove（阶梯保护）', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const e = await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
        weight: 0.7,
      });
      await expect(svc.correctEdge({ edgeId: e.id, action: 'remove', reason: '错误' })).rejects.toThrow(/≥ 0\.5/);
    });

    it('force=true 跳过阶梯保护', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const e = await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
        weight: 0.9,
      });
      const r = await svc.correctEdge({ edgeId: e.id, action: 'remove', reason: '系统纠错', force: true });
      expect(r.action).toBe('removed');
    });

    it('remove 后 store 中边被物理删除（无脏数据）', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const e = await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
        weight: 0.2,
      });
      const r = await svc.correctEdge({ edgeId: e.id, action: 'remove', reason: '幻觉' });
      expect(r.action).toBe('removed');
      // biome-ignore lint/suspicious/noExplicitAny: 测试中直接访问私有 store 验证物理删除
      const store = (svc as any).store as RelationStore;
      expect(await store.getEdge(e.id)).toBeUndefined();
    });

    it('alias 边禁操作', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      // 直接绕过 addPersonPersonEdge（会触发 mergeAlias 把 alias 边一并 cascade 删掉），
      // 用 store.upsertEdge 直接落一条 alias 边来测 correctEdge 的拒绝路径。
      // biome-ignore lint/suspicious/noExplicitAny: 测试中直接访问私有 store
      const store = (svc as any).store as RelationStore;
      const now = Date.now();
      const e = {
        id: globalThis.crypto.randomUUID(),
        kind: 'person-person' as const,
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'is-alias-of' as const,
        directed: true,
        weight: 0.2,
        firstSeenAt: now,
        lastReinforcedAt: now,
        evidence: [],
      };
      await store.upsertEdge(e);
      await expect(svc.correctEdge({ edgeId: e.id, action: 'weaken', reason: 'x' })).rejects.toThrow(/alias/);
    });

    it('reason 缺失 / 不存在的 edge → 报错', async () => {
      const svc = await setup();
      await expect(svc.correctEdge({ edgeId: 'x', action: 'weaken', reason: '' })).rejects.toThrow(/reason 必填/);
      await expect(svc.correctEdge({ edgeId: 'nope', action: 'weaken', reason: 'r' })).rejects.toThrow(/不存在/);
    });

    it('weaken multiplier 越界 → 报错', async () => {
      const svc = await setup();
      await svc.observePerson('onebot', 'a');
      await svc.observePerson('onebot', 'b');
      const e = await svc.addPersonPersonEdge({
        fromPersonId: 'onebot:a',
        toPersonId: 'onebot:b',
        relationType: 'friend',
        weight: 0.3,
      });
      await expect(svc.correctEdge({ edgeId: e.id, action: 'weaken', multiplier: 2, reason: 'r' })).rejects.toThrow(
        /\(0, 1\)/,
      );
    });
  });
});
