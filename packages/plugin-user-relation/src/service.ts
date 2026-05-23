/**
 * RelationService —— 关系图的应用层 API。
 *
 * 职责：
 * - 暴露给其他插件 / webui / agent middleware 的稳定查询接口
 * - 处理"upsert 时合并 evidence + 衰减/强化 weight"的语义
 * - 生成稳定的 ID（事件 / 边）
 *
 * 不处理：
 * - LLM 提取本身 → M2 的 extractor.ts
 * - WebUI 端点 → M4 的 actions
 */
import type { RelationStore } from './store.js';
import type {
  EventNode,
  EvidenceRef,
  PersonEventEdge,
  PersonNode,
  PersonPersonEdge,
  RelationEdge,
  RelationGraphSnapshot,
} from './types.js';

const MAX_EVIDENCE_PER_ENTITY = 10; // 单实体保留的 evidence 上限，更早的会被裁掉

export class RelationService {
  constructor(private readonly store: RelationStore) {}

  static personId(platform: string, userId: string): string {
    return `${platform}:${userId}`;
  }

  // ----- Person -----

  async observePerson(platform: string, userId: string, displayName?: string): Promise<PersonNode> {
    const now = Date.now();
    const existing = await this.store.getPerson(platform, userId);
    const node: PersonNode = existing
      ? {
          ...existing,
          displayName: displayName ?? existing.displayName,
          lastSeenAt: now,
        }
      : {
          id: RelationService.personId(platform, userId),
          platform,
          userId,
          displayName,
          firstSeenAt: now,
          lastSeenAt: now,
        };
    await this.store.upsertPerson(node);
    return node;
  }

  getPerson(platform: string, userId: string) {
    return this.store.getPerson(platform, userId);
  }

  deletePerson(platform: string, userId: string) {
    return this.store.deletePersonCascade(platform, userId);
  }

  // ----- Event -----

  /**
   * 新建事件。ID 由本方法生成；调用方拿到 ID 后即可挂边。
   */
  async createEvent(input: Omit<EventNode, 'id' | 'firstSeenAt' | 'lastReinforcedAt'>): Promise<EventNode> {
    const now = Date.now();
    const node: EventNode = {
      id: globalThis.crypto.randomUUID(),
      title: input.title,
      summary: input.summary,
      category: input.category,
      firstSeenAt: now,
      lastReinforcedAt: now,
      evidence: trimEvidence(input.evidence ?? []),
    };
    await this.store.upsertEvent(node);
    return node;
  }

  /**
   * 强化已有事件：追加 evidence、更新 lastReinforcedAt，可选更新 summary/title/category。
   */
  async reinforceEvent(
    eventId: string,
    patch: { title?: string; summary?: string; category?: EventNode['category']; evidence?: EvidenceRef[] },
  ): Promise<EventNode | undefined> {
    const existing = await this.store.getEvent(eventId);
    if (!existing) return undefined;
    const merged: EventNode = {
      ...existing,
      title: patch.title ?? existing.title,
      summary: patch.summary ?? existing.summary,
      category: patch.category ?? existing.category,
      lastReinforcedAt: Date.now(),
      evidence: trimEvidence([...(patch.evidence ?? []), ...existing.evidence]),
    };
    await this.store.upsertEvent(merged);
    return merged;
  }

  getEvent(eventId: string) {
    return this.store.getEvent(eventId);
  }

  deleteEvent(eventId: string) {
    return this.store.deleteEventCascade(eventId);
  }

  // ----- Edge: person → event -----

  async addPersonEventEdge(input: {
    fromPersonId: string;
    toEventId: string;
    role: PersonEventEdge['role'];
    sentiment?: PersonEventEdge['sentiment'];
    weight?: number;
    evidence?: EvidenceRef[];
  }): Promise<PersonEventEdge> {
    const existing = await this.findPersonEventEdge(input.fromPersonId, input.toEventId, input.role);
    const now = Date.now();
    if (existing) {
      const merged: PersonEventEdge = {
        ...existing,
        sentiment: input.sentiment ?? existing.sentiment,
        weight: clamp01(reinforceWeight(existing.weight, input.weight ?? 0.1)),
        lastReinforcedAt: now,
        evidence: trimEvidence([...(input.evidence ?? []), ...existing.evidence]),
      };
      await this.store.upsertEdge(merged);
      return merged;
    }
    const fresh: PersonEventEdge = {
      id: globalThis.crypto.randomUUID(),
      kind: 'person-event',
      fromPersonId: input.fromPersonId,
      toEventId: input.toEventId,
      role: input.role,
      sentiment: input.sentiment,
      weight: clamp01(input.weight ?? 0.5),
      firstSeenAt: now,
      lastReinforcedAt: now,
      evidence: trimEvidence(input.evidence ?? []),
    };
    await this.store.upsertEdge(fresh);
    return fresh;
  }

  // ----- Edge: person → person -----

  async addPersonPersonEdge(input: {
    fromPersonId: string;
    toPersonId: string;
    relationType: string;
    directed?: boolean;
    weight?: number;
    evidence?: EvidenceRef[];
  }): Promise<PersonPersonEdge> {
    const normalizedType = normalizeRelationType(input.relationType);
    const directed = input.directed ?? !isSymmetricRelation(normalizedType);

    const existing = await this.findPersonPersonEdge(input.fromPersonId, input.toPersonId, normalizedType, directed);
    const now = Date.now();
    if (existing) {
      const merged: PersonPersonEdge = {
        ...existing,
        weight: clamp01(reinforceWeight(existing.weight, input.weight ?? 0.1)),
        lastReinforcedAt: now,
        evidence: trimEvidence([...(input.evidence ?? []), ...existing.evidence]),
      };
      await this.store.upsertEdge(merged);
      return merged;
    }
    const fresh: PersonPersonEdge = {
      id: globalThis.crypto.randomUUID(),
      kind: 'person-person',
      fromPersonId: input.fromPersonId,
      toPersonId: input.toPersonId,
      relationType: normalizedType,
      directed,
      weight: clamp01(input.weight ?? 0.5),
      firstSeenAt: now,
      lastReinforcedAt: now,
      evidence: trimEvidence(input.evidence ?? []),
    };
    await this.store.upsertEdge(fresh);
    return fresh;
  }

  // ----- 边查询 -----

  async findPersonEventEdge(
    fromPersonId: string,
    toEventId: string,
    role: PersonEventEdge['role'],
  ): Promise<PersonEventEdge | undefined> {
    const snapshot = await this.store.loadAll();
    return snapshot.edges.find(
      (e): e is PersonEventEdge =>
        e.kind === 'person-event' && e.fromPersonId === fromPersonId && e.toEventId === toEventId && e.role === role,
    );
  }

  /**
   * 查找等价的人-人边。对于对称关系 (directed=false)，(A→B, friend) 与 (B→A, friend)
   * 视为同一条边；只看其中一种方向即可命中。
   */
  async findPersonPersonEdge(
    fromPersonId: string,
    toPersonId: string,
    relationType: string,
    directed: boolean,
  ): Promise<PersonPersonEdge | undefined> {
    const snapshot = await this.store.loadAll();
    return snapshot.edges.find((e): e is PersonPersonEdge => {
      if (e.kind !== 'person-person') return false;
      if (e.relationType !== relationType) return false;
      if (directed) {
        return e.fromPersonId === fromPersonId && e.toPersonId === toPersonId;
      }
      // 对称：任一方向匹配即可
      return (
        (e.fromPersonId === fromPersonId && e.toPersonId === toPersonId) ||
        (e.fromPersonId === toPersonId && e.toPersonId === fromPersonId)
      );
    });
  }

  deleteEdge(edgeId: string) {
    return this.store.deleteEdge(edgeId);
  }

  // ----- 图查询 -----

  loadAll(): Promise<RelationGraphSnapshot> {
    return this.store.loadAll();
  }

  /** 查询某人涉及的所有事件 + 直连人际关系 */
  async getNeighborhood(personId: string): Promise<{
    person: PersonNode | undefined;
    events: EventNode[];
    edges: RelationEdge[];
  }> {
    const snapshot = await this.store.loadAll();
    const person = snapshot.persons.find(p => p.id === personId);
    const relatedEdges = snapshot.edges.filter(e => {
      if (e.kind === 'person-event') return e.fromPersonId === personId;
      return e.fromPersonId === personId || e.toPersonId === personId;
    });
    const eventIds = new Set(
      relatedEdges.filter((e): e is PersonEventEdge => e.kind === 'person-event').map(e => e.toEventId),
    );
    const events = snapshot.events.filter(ev => eventIds.has(ev.id));
    return { person, events, edges: relatedEdges };
  }
}

// ----- 辅助函数 -----

/** weight 累积：增量按 (1 - weight) * delta 收敛，避免无限增长 */
export function reinforceWeight(prev: number, delta: number): number {
  return prev + (1 - prev) * delta;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** 单实体保留最近 N 条 evidence（按 extractedAt DESC 截断） */
export function trimEvidence(list: EvidenceRef[]): EvidenceRef[] {
  if (list.length <= MAX_EVIDENCE_PER_ENTITY) return [...list];
  return [...list].sort((a, b) => b.extractedAt - a.extractedAt).slice(0, MAX_EVIDENCE_PER_ENTITY);
}

/**
 * 归一化关系类型：把同义词收敛到推荐词表里的标准形式。
 * 未匹配的自创词保持原样（允许 LLM 自由扩展，但应用层尝试合并显然同义的）。
 */
const RELATION_SYNONYMS: Record<string, string> = {
  best_friend: 'friend',
  buddy: 'friend',
  bestie: 'friend',
  lovers: 'cp',
  couple: 'cp',
  partner: 'cp',
  enemy: 'antagonist',
  hater: 'antagonist',
  opponent: 'rival',
  competitor: 'rival',
  coworker: 'colleague',
  teammate: 'colleague',
  teacher: 'mentor',
  master: 'mentor',
  student: 'admirer', // 单向：student → mentor 反过来就是 admirer 也行；UI 上可视化区分由 directed 控制
  fan: 'admirer',
  acquaintance: 'familiar',
};

export function normalizeRelationType(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\s+/g, '_');
  return RELATION_SYNONYMS[trimmed] ?? trimmed;
}

/** 对称关系：双向无方向区别 */
const SYMMETRIC_RELATIONS = new Set<string>(['friend', 'cp', 'rival', 'colleague', 'familiar', 'antagonist']);

export function isSymmetricRelation(relationType: string): boolean {
  return SYMMETRIC_RELATIONS.has(relationType);
}
