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
import type { EntityNode, EventNode, PersonNode, RelationEdge } from './types.js';

/** 关系类型 → 中文显示（WebUI 渲染用；不影响存储里的英文 key） */
const RELATION_LABEL_ZH: Record<string, string> = {
  // person-event role
  initiator: '发起者',
  participant: '参与者',
  witness: '旁观者',
  target: '被指向',
  reporter: '转述者',
  // person-entity role
  enthusiast: '爱好者',
  owner: '拥有者',
  creator: '创作者',
  critic: '批评者',
  visitor: '访客',
  mentioned: '仅提及',
  // person-person relation
  friend: '朋友',
  cp: 'CP',
  rival: '对手',
  mentor: '师徒',
  colleague: '同事',
  familiar: '熟人',
  antagonist: '对头',
  admirer: '仰慕者',
  // event-event relation
  'caused-by': '因→果',
  follows: '随后',
  'part-of': '属于',
  related: '相关',
  // event-entity relation
  about: '关于',
  uses: '使用',
  'located-at': '位于',
  produced: '产出',
  // entity-entity relation
  contains: '包含',
  'variant-of': '变体',
  opposite: '对立',
  // entity kind / sentiment（少量备用）
  positive: '正向',
  negative: '负向',
  neutral: '中性',
  mixed: '复杂',
};

function labelZh(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  return RELATION_LABEL_ZH[raw] ?? raw;
}

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

/** 给任意对象补充时间戳的可读字符串字段（保留原数字字段不动）。 */
function withReadableDates<T extends Record<string, unknown>>(o: T): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  for (const key of ['firstSeenAt', 'lastSeenAt', 'lastReinforcedAt', 'lastMentionedAt'] as const) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[`${key}Text`] = formatDate(v);
    }
  }
  return out as T & Record<string, unknown>;
}

/** evidence 列表的统一展开（按时间倒序 + 附时间文本，保留 messageIds/quote/sessionId 原样）。 */
function expandEvidence(
  list: ReadonlyArray<{ quote?: string; messageIds: string[]; sessionId?: string; extractedAt: number }>,
): unknown[] {
  return [...list]
    .sort((a, b) => b.extractedAt - a.extractedAt)
    .map(ev => ({
      quote: ev.quote,
      messageIds: ev.messageIds,
      sessionId: ev.sessionId,
      extractedAt: ev.extractedAt,
      extractedAtText: formatDate(ev.extractedAt),
    }));
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

  async listEntities(ctx) {
    const s = svc(ctx);
    if (!s) return [];
    const snap = await s.loadAll();
    return snap.entities
      .sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt)
      .map((e: EntityNode) => ({
        id: e.id,
        name: e.name,
        entityKind: e.entityKind,
        aliases: (e.aliases ?? []).join(', '),
        summary: e.summary ?? '',
        evidenceCount: e.evidence.length,
        lastReinforcedAt: formatDate(e.lastReinforcedAt),
      }));
  },

  // ───── 关系图（Cytoscape elements） ─────
  async getRelationGraph(ctx, args) {
    const s = svc(ctx);
    if (!s) return { nodes: [], edges: [] };
    // 焦点可为 person(`platform:userId`，含冒号) / event / entity(UUID)。
    // 不再以「包含冒号」来过滤——event/entity UUID 不含冒号也应被接受。
    const focusIdRaw = typeof args.focusId === 'string' ? args.focusId.trim() : '';
    const focusId = focusIdRaw || undefined;
    const maxDepth = numArg(args.maxDepth, 2);
    const maxBreadth = numArg(args.maxBreadth, 10);

    let persons: PersonNode[];
    let events: EventNode[];
    let entities: EntityNode[];
    let edges: RelationEdge[];
    let focusEdge: RelationEdge | undefined;

    if (focusId) {
      // 先检测 focusId 是否为某条边的 id：若是 → 取边两端点作为起点 + 1 跳邻域
      const snap = await s.loadAll();
      const edgeMatch = snap.edges.find(e => e.id === focusId);
      if (edgeMatch) {
        focusEdge = edgeMatch;
        const endpointIds = edgeEndpointIds(edgeMatch);
        const sub = await s.traverseSubgraph({ startNodeIds: endpointIds, maxDepth, maxBreadth });
        persons = sub.persons;
        events = sub.events;
        entities = sub.entities;
        edges = sub.edges;
        if (!edges.some(e => e.id === edgeMatch.id)) edges.push(edgeMatch);
      } else {
        const sub = await s.traverseSubgraph({ startNodeIds: [focusId], maxDepth, maxBreadth });
        persons = sub.persons;
        events = sub.events;
        entities = sub.entities;
        edges = sub.edges;
      }
    } else {
      const snap = await s.loadAll();
      // 全图以“近期活跃 + 高度关系”为主，避免一次过多节点压垮浏览器
      // maxBreadth=0 表示“不限”，但全图模式必须给硬上限防爆
      const personCap = maxBreadth === 0 ? 500 : Math.max(20, maxBreadth * 6);
      const eventCap = maxBreadth === 0 ? 500 : Math.max(15, maxBreadth * 4);
      const entityCap = maxBreadth === 0 ? 500 : Math.max(15, maxBreadth * 4);
      persons = [...snap.persons].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, personCap);
      const personIdSet = new Set(persons.map(p => p.id));
      // 仅保留与这些人物相关的事件 / 实体
      const relatedEventIds = new Set<string>();
      const relatedEntityIds = new Set<string>();
      for (const e of snap.edges) {
        if (e.kind === 'person-event' && personIdSet.has(e.fromPersonId)) relatedEventIds.add(e.toEventId);
        else if (e.kind === 'person-entity' && personIdSet.has(e.fromPersonId)) relatedEntityIds.add(e.toEntityId);
      }
      events = snap.events
        .filter(e => relatedEventIds.has(e.id))
        .sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt)
        .slice(0, eventCap);
      const eventIdSet = new Set(events.map(e => e.id));
      entities = snap.entities
        .filter(e => relatedEntityIds.has(e.id))
        .sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt)
        .slice(0, entityCap);
      const entityIdSet = new Set(entities.map(e => e.id));
      edges = snap.edges.filter(e => {
        if (e.kind === 'person-event') return personIdSet.has(e.fromPersonId) && eventIdSet.has(e.toEventId);
        if (e.kind === 'person-entity') return personIdSet.has(e.fromPersonId) && entityIdSet.has(e.toEntityId);
        if (e.kind === 'event-event') return eventIdSet.has(e.fromEventId) && eventIdSet.has(e.toEventId);
        if (e.kind === 'event-entity') return eventIdSet.has(e.fromEventId) && entityIdSet.has(e.toEntityId);
        if (e.kind === 'entity-entity') return entityIdSet.has(e.fromEntityId) && entityIdSet.has(e.toEntityId);
        return personIdSet.has(e.fromPersonId) && personIdSet.has(e.toPersonId);
      });
    }

    const personLabel = (p: PersonNode): string => p.displayName?.trim() || p.userId;
    const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

    return {
      focusId,
      focusEdge: focusEdge
        ? {
            id: focusEdge.id,
            kind: focusEdge.kind,
            weight: focusEdge.weight,
            description: focusEdge.description,
            firstSeenAt: focusEdge.firstSeenAt,
            lastReinforcedAt: focusEdge.lastReinforcedAt,
            evidence: focusEdge.evidence,
            endpoints: edgeEndpointIds(focusEdge),
            // 按 kind 暴露的额外语义字段（在前端面板里展示）
            relation:
              focusEdge.kind === 'person-event' || focusEdge.kind === 'person-entity'
                ? undefined
                : focusEdge.relationType,
            role: focusEdge.kind === 'person-event' || focusEdge.kind === 'person-entity' ? focusEdge.role : undefined,
            sentiment:
              focusEdge.kind === 'person-event' || focusEdge.kind === 'person-entity' ? focusEdge.sentiment : undefined,
            directed:
              focusEdge.kind === 'person-event' || focusEdge.kind === 'person-entity' ? undefined : focusEdge.directed,
          }
        : undefined,
      stats: {
        persons: persons.length,
        events: events.length,
        entities: entities.length,
        edges: edges.length,
      },
      nodes: [
        ...persons.map(p => ({
          data: {
            id: p.id,
            label: personLabel(p),
            kind: 'person' as const,
            platform: p.platform,
            userId: p.userId,
            displayName: p.displayName,
          },
        })),
        ...events.map(e => ({
          data: {
            id: e.id,
            label: truncate(e.title, 18),
            kind: 'event' as const,
            category: e.category,
            title: e.title,
          },
        })),
        ...entities.map(e => ({
          data: {
            id: e.id,
            label: truncate(e.name, 16),
            kind: 'entity' as const,
            entityKind: e.entityKind,
            name: e.name,
          },
        })),
      ],
      edges: edges.map(e => {
        if (e.kind === 'person-event') {
          return {
            data: {
              id: e.id,
              source: e.fromPersonId,
              target: e.toEventId,
              kind: 'person-event' as const,
              label: labelZh(e.role),
              role: e.role,
              weight: e.weight,
              sentiment: e.sentiment,
              description: e.description,
            },
          };
        }
        if (e.kind === 'person-entity') {
          return {
            data: {
              id: e.id,
              source: e.fromPersonId,
              target: e.toEntityId,
              kind: 'person-entity' as const,
              label: labelZh(e.role),
              role: e.role,
              weight: e.weight,
              sentiment: e.sentiment,
              description: e.description,
            },
          };
        }
        if (e.kind === 'event-event') {
          return {
            data: {
              id: e.id,
              source: e.fromEventId,
              target: e.toEventId,
              kind: 'event-event' as const,
              label: labelZh(e.relationType),
              relationType: e.relationType,
              directed: e.directed,
              weight: e.weight,
              description: e.description,
            },
          };
        }
        if (e.kind === 'event-entity') {
          return {
            data: {
              id: e.id,
              source: e.fromEventId,
              target: e.toEntityId,
              kind: 'event-entity' as const,
              label: labelZh(e.relationType),
              relationType: e.relationType,
              directed: true,
              weight: e.weight,
              description: e.description,
            },
          };
        }
        if (e.kind === 'entity-entity') {
          return {
            data: {
              id: e.id,
              source: e.fromEntityId,
              target: e.toEntityId,
              kind: 'entity-entity' as const,
              label: labelZh(e.relationType),
              relationType: e.relationType,
              directed: e.directed,
              weight: e.weight,
              description: e.description,
            },
          };
        }
        return {
          data: {
            id: e.id,
            source: e.fromPersonId,
            target: e.toPersonId,
            kind: 'person-person' as const,
            label: labelZh(e.relationType),
            relationType: e.relationType,
            directed: e.directed,
            weight: e.weight,
            description: e.description,
          },
        };
      }),
    };
  },

  async getGraphNodeDetail(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    const nodeId = String(args.nodeId ?? '');
    const kind = String(args.kind ?? '');
    if (kind === 'person') {
      if (!nodeId.includes(':')) return { error: '无效 personId' };
      const nb = await s.getNeighborhood(nodeId);
      return {
        person: withReadableDates(nb.person as unknown as Record<string, unknown>),
        eventCount: nb.events.length,
        edgeCount: nb.edges.length,
        recentEvents: nb.events.slice(0, 5).map(e =>
          withReadableDates({
            id: e.id,
            title: e.title,
            category: e.category,
            summary: e.summary,
            weight: e.weight,
            mentionCount: e.mentionCount,
            firstSeenAt: e.firstSeenAt,
            lastReinforcedAt: e.lastReinforcedAt,
            lastMentionedAt: e.lastMentionedAt,
            evidenceCount: e.evidence.length,
            evidencePreview: previewEvidence(e),
          }),
        ),
        edges: nb.edges.slice(0, 10).map(e => {
          // 通用骨架：把所有边都 spread 出来，并补可读时间 + 中文 role/relation
          const base = withReadableDates({
            ...(e as unknown as Record<string, unknown>),
            evidenceCount: e.evidence.length,
            evidencePreview: previewEvidence(e),
          });
          if (e.kind === 'person-event' || e.kind === 'person-entity') {
            base.roleZh = labelZh(e.role);
          } else if ('relationType' in e && e.relationType) {
            base.relationZh = labelZh(e.relationType);
          }
          return base;
        }),
      };
    }
    if (kind === 'event') {
      const e = await s.getEvent(nodeId);
      if (!e) return { error: '事件不存在' };
      return {
        ...withReadableDates(e as unknown as Record<string, unknown>),
        evidenceCount: e.evidence.length,
        evidence: expandEvidence(e.evidence),
      };
    }
    if (kind === 'entity') {
      const e = await s.getEntity(nodeId);
      if (!e) return { error: '实体不存在' };
      return {
        ...withReadableDates(e as unknown as Record<string, unknown>),
        aliases: e.aliases ?? [],
        evidenceCount: e.evidence.length,
        evidence: expandEvidence(e.evidence),
      };
    }
    return { error: `未知 kind: ${kind}` };
  },

  // ───── stat / info ─────
  async getStats(ctx) {
    const s = svc(ctx);
    if (!s) return { value: 0 };
    const snap = await s.loadAll();
    const pe = snap.edges.filter(e => e.kind === 'person-event').length;
    const pp = snap.edges.filter(e => e.kind === 'person-person').length;
    const pent = snap.edges.filter(e => e.kind === 'person-entity').length;
    const ee = snap.edges.filter(e => e.kind === 'event-event').length;
    const eent = snap.edges.filter(e => e.kind === 'event-entity').length;
    const entent = snap.edges.filter(e => e.kind === 'entity-entity').length;
    return {
      value: snap.persons.length,
      detail: `人物 ${snap.persons.length} / 事件 ${snap.events.length} / 实体 ${snap.entities.length} / 人-事 ${pe} / 人-人 ${pp} / 人-实体 ${pent} / 事-事 ${ee} / 事-实体 ${eent} / 实体-实体 ${entent}`,
    };
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

  async deleteEntity(ctx, args) {
    const s = svc(ctx);
    if (!s) return { error: 'service 不可用' };
    await s.deleteEntity(String(args.id ?? ''));
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

/** 给定一条边，返回它的两个端点 id（统一为字符串数组） */
function edgeEndpointIds(e: RelationEdge): string[] {
  switch (e.kind) {
    case 'person-event':
      return [e.fromPersonId, e.toEventId];
    case 'person-person':
      return [e.fromPersonId, e.toPersonId];
    case 'person-entity':
      return [e.fromPersonId, e.toEntityId];
    case 'event-event':
      return [e.fromEventId, e.toEventId];
    case 'event-entity':
      return [e.fromEventId, e.toEntityId];
    case 'entity-entity':
      return [e.fromEntityId, e.toEntityId];
  }
}
