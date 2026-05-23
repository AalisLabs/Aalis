/**
 * plugin-user-relation —— page-actions（M4）
 *
 * 全部通过 ctx.getService<RelationService>('user-relation') 拿服务实例。
 * actions 返回值用于声明式 WebUI 组件渲染：
 * - listXxx → table 表格 source
 * - getStats → stat 组件 source
 * - getXxx  → 详情对话框 source
 * - 其余    → 操作类按钮
 */
import type { Context, PluginModule } from '@aalis/core';
import type { RelationService } from './service.js';
import type { EventNode, PersonEventEdge, PersonNode, PersonPersonEdge, RelationEdge } from './types.js';
import { RecommendedPersonRelationTypes } from './types.js';

function svc(ctx: Context): RelationService | undefined {
  return ctx.getService<RelationService>('user-relation');
}

function previewEvidence(e: RelationEdge | EventNode): string {
  if (e.evidence.length === 0) return '';
  const recent = [...e.evidence].sort((a, b) => b.extractedAt - a.extractedAt)[0];
  return recent.quote
    ? `「${recent.quote.slice(0, 30)}${recent.quote.length > 30 ? '…' : ''}」`
    : `${recent.messageIds.length} 条证据`;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

export const actions: PluginModule['actions'] = {
  // ───── 表格数据源 ─────
  async listPersons(ctx) {
    const s = svc(ctx);
    if (!s) return [];
    const snap = await s.loadAll();
    return snap.persons
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((p: PersonNode) => ({
        id: p.id,
        platform: p.platform,
        userId: p.userId,
        displayName: p.displayName ?? '',
        firstSeenAt: formatDate(p.firstSeenAt),
        lastSeenAt: formatDate(p.lastSeenAt),
      }));
  },

  async listEvents(ctx) {
    const s = svc(ctx);
    if (!s) return [];
    const snap = await s.loadAll();
    return snap.events
      .sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt)
      .map((e: EventNode) => ({
        id: e.id,
        title: e.title,
        category: e.category ?? '',
        summary: e.summary ?? '',
        evidenceCount: e.evidence.length,
        preview: previewEvidence(e),
        lastReinforcedAt: formatDate(e.lastReinforcedAt),
      }));
  },

  async listPersonEventEdges(ctx) {
    const s = svc(ctx);
    if (!s) return [];
    const snap = await s.loadAll();
    const eventTitleById = new Map(snap.events.map(e => [e.id, e.title] as const));
    const personLabelById = new Map(
      snap.persons.map(p => [p.id, p.displayName ? `${p.displayName}(${p.userId})` : p.userId] as const),
    );
    return snap.edges
      .filter((e): e is PersonEventEdge => e.kind === 'person-event')
      .sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt)
      .map(e => ({
        id: e.id,
        person: personLabelById.get(e.fromPersonId) ?? e.fromPersonId,
        event: eventTitleById.get(e.toEventId) ?? e.toEventId,
        role: e.role,
        sentiment: e.sentiment ?? '',
        weight: e.weight.toFixed(2),
        preview: previewEvidence(e),
      }));
  },

  async listPersonPersonEdges(ctx) {
    const s = svc(ctx);
    if (!s) return [];
    const snap = await s.loadAll();
    const personLabelById = new Map(
      snap.persons.map(p => [p.id, p.displayName ? `${p.displayName}(${p.userId})` : p.userId] as const),
    );
    return snap.edges
      .filter((e): e is PersonPersonEdge => e.kind === 'person-person')
      .sort((a, b) => b.weight - a.weight)
      .map(e => ({
        id: e.id,
        from: personLabelById.get(e.fromPersonId) ?? e.fromPersonId,
        to: personLabelById.get(e.toPersonId) ?? e.toPersonId,
        relation: `${e.relationType}${e.directed ? ' (→)' : ' (↔)'}`,
        weight: e.weight.toFixed(2),
        preview: previewEvidence(e),
      }));
  },

  // ───── stat / info ─────
  async getStats(ctx) {
    const s = svc(ctx);
    if (!s) return { value: 0 };
    const snap = await s.loadAll();
    const pe = snap.edges.filter(e => e.kind === 'person-event').length;
    const pp = snap.edges.filter(e => e.kind === 'person-person').length;
    return {
      value: snap.persons.length,
      detail: `人物 ${snap.persons.length} / 事件 ${snap.events.length} / 人-事 ${pe} / 人-人 ${pp}`,
    };
  },

  async getRecommendedRelationTypes() {
    return { items: [...RecommendedPersonRelationTypes] };
  },

  // ───── 详情 ─────
  async getPerson(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    const id = String(args.id ?? '');
    const [platform = '', userId = ''] = id.split(':');
    if (!platform || !userId) return { error: '无效 personId' };
    const nb = await s.getNeighborhood(id);
    return {
      person: nb.person,
      events: nb.events,
      edges: nb.edges,
    };
  },

  async getEvent(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    const e = await s.getEvent(String(args.id ?? ''));
    if (!e) return { error: '事件不存在' };
    return e;
  },

  // ───── 操作类 ─────
  async deletePerson(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    const id = String(args.id ?? '');
    const [platform = '', userId = ''] = id.split(':');
    if (!platform || !userId) return { error: '无效 personId' };
    await s.deletePerson(platform, userId);
    return { ok: true };
  },

  async deleteEvent(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    await s.deleteEvent(String(args.id ?? ''));
    return { ok: true };
  },

  async deleteEdge(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    await s.deleteEdge(String(args.id ?? ''));
    return { ok: true };
  },

  async triggerExtraction(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    const sessionId = String(args.sessionId ?? '').trim();
    if (!sessionId) return { error: '请输入 sessionId' };
    return s.triggerExtraction(sessionId);
  },

  // ───── 多层查询（webui view + 调试用，参数走 view.* 范畴的默认值/上限由 index.ts 注入） ─────
  async expandPerson(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    const personId = String(args.personId ?? args.id ?? '').trim();
    if (!personId.includes(':')) return { error: 'personId 格式应为 platform:userId' };
    const maxDepth = numArg(args.maxDepth, 2);
    const maxBreadth = numArg(args.maxBreadth, 10);
    const sub = await s.traverseSubgraph({
      startPersonIds: [personId],
      maxDepth,
      maxBreadth,
    });
    return {
      personId,
      maxDepth,
      maxBreadth,
      stats: {
        persons: sub.persons.length,
        events: sub.events.length,
        edges: sub.edges.length,
      },
      persons: sub.persons,
      events: sub.events,
      edges: sub.edges,
    };
  },

  async findPath(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    const from = String(args.fromPersonId ?? args.from ?? '').trim();
    const to = String(args.toPersonId ?? args.to ?? '').trim();
    if (!from.includes(':') || !to.includes(':')) return { error: 'person id 格式应为 platform:userId' };
    const maxDepth = numArg(args.maxDepth, 3);
    const path = await s.findPath(from, to, maxDepth);
    if (!path) return { found: false, from, to, maxDepth };
    return {
      found: true,
      length: path.edges.length,
      nodes: path.nodes,
      edges: path.edges,
    };
  },

  async searchEvents(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    const keyword = typeof args.keyword === 'string' ? args.keyword : undefined;
    const days = numArgOptional(args.days);
    const limit = numArg(args.limit, 20);
    const events = await s.searchEvents({ keyword, days, limit });
    return {
      count: events.length,
      events,
    };
  },
};

function numArg(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function numArgOptional(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
