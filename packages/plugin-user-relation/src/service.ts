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
  EntityEntityEdge,
  EntityNode,
  EventEntityEdge,
  EventEventEdge,
  EventNode,
  EvidenceRef,
  PersonEntityEdge,
  PersonEventEdge,
  PersonNode,
  PersonPersonEdge,
  RelationEdge,
  RelationGraphSnapshot,
} from './types.js';

const MAX_EVIDENCE_PER_ENTITY = 10; // 单实体保留的 evidence 上限，更早的会被裁掉

/**
 * 人-事件角色优先级。同一 (person, event) 只保留最强角色的一条边：
 * 发起者 > 参与者 > 被指向 > 转述者 > 旁观者。语义上强角色含盖弱角色。
 */
const PERSON_EVENT_ROLE_RANK: Record<PersonEventEdge['role'], number> = {
  initiator: 5,
  participant: 4,
  target: 3,
  reporter: 2,
  witness: 1,
};

/**
 * 人-实体角色优先级。同一 (person, entity) 只保留最强角色。
 * 热爱 > 创作者 > 拥有者 > 批评者 > 参与者 > 访问者 > 仅提及。
 */
const PERSON_ENTITY_ROLE_RANK: Record<PersonEntityEdge['role'], number> = {
  enthusiast: 6,
  creator: 5,
  owner: 4,
  critic: 3,
  participant: 2,
  visitor: 1,
  mentioned: 0,
};

export type TriggerExtractionFn = (
  sessionId: string,
) => Promise<{ status: 'ok' | 'skipped' | 'error'; reason?: string }>;

export class RelationService {
  /** 由 extractor 注入；actions 层通过 triggerExtraction() 调用 */
  private triggerExtractionHandler?: TriggerExtractionFn;

  constructor(private readonly store: RelationStore) {}

  static personId(platform: string, userId: string): string {
    return `${platform}:${userId}`;
  }

  /** 由 extractor 在 start() 后注入 */
  setTriggerExtractionHandler(fn: TriggerExtractionFn): void {
    this.triggerExtractionHandler = fn;
  }

  /** 手动触发某 session 的 LLM 提取；extractor 未挂载时返回 error */
  triggerExtraction(sessionId: string): Promise<{ status: 'ok' | 'skipped' | 'error'; reason?: string }> {
    if (!this.triggerExtractionHandler) {
      return Promise.resolve({ status: 'error', reason: 'extractor 未启用（请检查 enabled / 模型配置）' });
    }
    return this.triggerExtractionHandler(sessionId);
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
   * 新建事件。严格按 normalized title 去重：若已存在同名事件，**强制合并**到旧节点
   * （追加 evidence、累加权重 += 0.3、occurrences 追加当前时间戳），返回旧节点。
   * 这样保证「同一件事被反复提及」不会产生重复 event，但通过 occurrences[] 保留时间维度。
   */
  async createEvent(input: Omit<EventNode, 'id' | 'firstSeenAt' | 'lastReinforcedAt'>): Promise<EventNode> {
    const now = Date.now();
    const dup = await this.findEventByTitle(input.title);
    if (dup) {
      const merged: EventNode = {
        ...dup,
        summary: input.summary ?? dup.summary,
        category: input.category ?? dup.category,
        lastReinforcedAt: now,
        evidence: trimEvidence([...(input.evidence ?? []), ...dup.evidence]),
        occurrences: [...(dup.occurrences ?? [dup.firstSeenAt]), now],
        weight: clamp01((dup.weight ?? 0.5) + 0.3),
      };
      await this.store.upsertEvent(merged);
      return merged;
    }
    const node: EventNode = {
      id: globalThis.crypto.randomUUID(),
      title: input.title,
      summary: input.summary,
      category: input.category,
      firstSeenAt: now,
      lastReinforcedAt: now,
      evidence: trimEvidence(input.evidence ?? []),
      occurrences: [now],
      weight: 0.5,
    };
    await this.store.upsertEvent(node);
    return node;
  }

  /**
   * 按 normalized title 精确匹配（不区分大小写、压缩空白）查找已有事件。
   * 用于 createEvent 入口去重。
   */
  async findEventByTitle(title: string): Promise<EventNode | undefined> {
    const target = normalizeName(title);
    if (!target) return undefined;
    const snap = await this.store.loadAll();
    return snap.events.find(e => normalizeName(e.title) === target);
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

  // ----- Entity -----

  /**
   * 新建实体。严格按 (entityKind, normalized name) 去重：若已存在同 kind 同名实体，
   * **强制合并**到旧节点（追加 evidence、合并 aliases、累加权重 += 0.3），返回旧节点。
   */
  async createEntity(input: Omit<EntityNode, 'id' | 'firstSeenAt' | 'lastReinforcedAt'>): Promise<EntityNode> {
    const now = Date.now();
    const dup = await this.findEntityByKindAndName(input.entityKind, input.name);
    if (dup) {
      const mergedAliases = input.aliases
        ? Array.from(new Set([...(dup.aliases ?? []), ...input.aliases]))
        : dup.aliases;
      const merged: EntityNode = {
        ...dup,
        aliases: mergedAliases,
        summary: input.summary ?? dup.summary,
        lastReinforcedAt: now,
        evidence: trimEvidence([...(input.evidence ?? []), ...dup.evidence]),
        weight: clamp01((dup.weight ?? 0.5) + 0.3),
      };
      await this.store.upsertEntity(merged);
      return merged;
    }
    const node: EntityNode = {
      id: globalThis.crypto.randomUUID(),
      entityKind: input.entityKind,
      name: input.name,
      aliases: input.aliases,
      summary: input.summary,
      firstSeenAt: now,
      lastReinforcedAt: now,
      evidence: trimEvidence(input.evidence ?? []),
      weight: 0.5,
    };
    await this.store.upsertEntity(node);
    return node;
  }

  /**
   * 强化已有实体：追加 evidence、更新 lastReinforcedAt，可选更新字段。
   */
  async reinforceEntity(
    entityId: string,
    patch: {
      name?: string;
      aliases?: string[];
      summary?: string;
      entityKind?: EntityNode['entityKind'];
      evidence?: EvidenceRef[];
    },
  ): Promise<EntityNode | undefined> {
    const existing = await this.store.getEntity(entityId);
    if (!existing) return undefined;
    const mergedAliases = patch.aliases
      ? Array.from(new Set([...(existing.aliases ?? []), ...patch.aliases]))
      : existing.aliases;
    const merged: EntityNode = {
      ...existing,
      name: patch.name ?? existing.name,
      aliases: mergedAliases,
      summary: patch.summary ?? existing.summary,
      entityKind: patch.entityKind ?? existing.entityKind,
      lastReinforcedAt: Date.now(),
      evidence: trimEvidence([...(patch.evidence ?? []), ...existing.evidence]),
    };
    await this.store.upsertEntity(merged);
    return merged;
  }

  getEntity(entityId: string) {
    return this.store.getEntity(entityId);
  }

  deleteEntity(entityId: string) {
    return this.store.deleteEntityCascade(entityId);
  }

  /**
   * 按 name / aliases 精确匹配（不区分大小写）查找已有实体。
   * 用于抽取阶段去重 —— LLM 提取出"三角洲"时优先复用已存在的同名实体。
   */
  async findEntityByName(name: string): Promise<EntityNode | undefined> {
    const target = normalizeName(name);
    if (!target) return undefined;
    const snap = await this.store.loadAll();
    return snap.entities.find(
      e => normalizeName(e.name) === target || (e.aliases ?? []).some(a => normalizeName(a) === target),
    );
  }

  /**
   * 按 (entityKind, normalized name) 精确匹配查找已有实体；用于 createEntity 入口去重。
   * 比 findEntityByName 更严格（要求 kind 一致），避免「同名不同类」误合并（如游戏《北京》vs 地点北京）。
   */
  async findEntityByKindAndName(kind: EntityNode['entityKind'], name: string): Promise<EntityNode | undefined> {
    const target = normalizeName(name);
    if (!target) return undefined;
    const snap = await this.store.loadAll();
    return snap.entities.find(e => e.entityKind === kind && normalizeName(e.name) === target);
  }

  // ----- Edge: person → entity -----

  async addPersonEntityEdge(input: {
    fromPersonId: string;
    toEntityId: string;
    role: PersonEntityEdge['role'];
    sentiment?: PersonEntityEdge['sentiment'];
    weight?: number;
    description?: string;
    evidence?: EvidenceRef[];
  }): Promise<PersonEntityEdge> {
    const snapshot = await this.store.loadAll();
    const sameLink = snapshot.edges.filter(
      (e): e is PersonEntityEdge =>
        e.kind === 'person-entity' && e.fromPersonId === input.fromPersonId && e.toEntityId === input.toEntityId,
    );
    const now = Date.now();

    if (sameLink.length === 0) {
      const fresh: PersonEntityEdge = {
        id: globalThis.crypto.randomUUID(),
        kind: 'person-entity',
        fromPersonId: input.fromPersonId,
        toEntityId: input.toEntityId,
        role: input.role,
        sentiment: input.sentiment,
        weight: clamp01(input.weight ?? 0.5),
        description: trimDescription(input.description),
        firstSeenAt: now,
        lastReinforcedAt: now,
        evidence: trimEvidence(input.evidence ?? []),
      };
      await this.store.upsertEdge(fresh);
      return fresh;
    }

    // 选出当前已存在的最强 role 边作为保留者
    const strongest = sameLink.reduce((a, b) =>
      (PERSON_ENTITY_ROLE_RANK[a.role] ?? 0) >= (PERSON_ENTITY_ROLE_RANK[b.role] ?? 0) ? a : b,
    );
    const inputRank = PERSON_ENTITY_ROLE_RANK[input.role] ?? 0;
    const strongestRank = PERSON_ENTITY_ROLE_RANK[strongest.role] ?? 0;
    const finalRole = inputRank > strongestRank ? input.role : strongest.role;

    // 如果证据已被覆盖且 role 未变，则原样返回
    if (
      finalRole === strongest.role &&
      isEvidenceFullyCovered(input.evidence ?? [], strongest.evidence) &&
      sameLink.length === 1 &&
      !input.description
    ) {
      return strongest;
    }

    // 合并 evidence + 加权
    const allEvidence = trimEvidence([...(input.evidence ?? []), ...sameLink.flatMap(e => e.evidence)]);
    const merged: PersonEntityEdge = {
      ...strongest,
      role: finalRole,
      sentiment: input.sentiment ?? strongest.sentiment,
      weight: clamp01(reinforceWeight(strongest.weight, input.weight ?? 0.1)),
      description: trimDescription(input.description) ?? strongest.description,
      lastReinforcedAt: now,
      evidence: allEvidence,
    };

    // 删除其余 weaker 同对边
    for (const e of sameLink) {
      if (e.id !== strongest.id) await this.store.deleteEdge(e.id);
    }
    await this.store.upsertEdge(merged);
    return merged;
  }

  async findPersonEntityEdge(
    fromPersonId: string,
    toEntityId: string,
    role: PersonEntityEdge['role'],
  ): Promise<PersonEntityEdge | undefined> {
    const snapshot = await this.store.loadAll();
    return snapshot.edges.find(
      (e): e is PersonEntityEdge =>
        e.kind === 'person-entity' && e.fromPersonId === fromPersonId && e.toEntityId === toEntityId && e.role === role,
    );
  }

  // ----- Edge: event → event -----

  async addEventEventEdge(input: {
    fromEventId: string;
    toEventId: string;
    relationType: string;
    directed?: boolean;
    weight?: number;
    description?: string;
    evidence?: EvidenceRef[];
  }): Promise<EventEventEdge> {
    const normalizedType = input.relationType.trim().toLowerCase().replace(/\s+/g, '-');
    const directed = input.directed ?? isDirectedEventEventRelation(normalizedType);
    const existing = await this.findEventEventEdge(input.fromEventId, input.toEventId, normalizedType, directed);
    const now = Date.now();
    if (existing) {
      if (isEvidenceFullyCovered(input.evidence ?? [], existing.evidence) && !input.description) return existing;
      const merged: EventEventEdge = {
        ...existing,
        weight: clamp01(reinforceWeight(existing.weight, input.weight ?? 0.1)),
        description: trimDescription(input.description) ?? existing.description,
        lastReinforcedAt: now,
        evidence: trimEvidence([...(input.evidence ?? []), ...existing.evidence]),
      };
      await this.store.upsertEdge(merged);
      return merged;
    }
    const fresh: EventEventEdge = {
      id: globalThis.crypto.randomUUID(),
      kind: 'event-event',
      fromEventId: input.fromEventId,
      toEventId: input.toEventId,
      relationType: normalizedType,
      directed,
      weight: clamp01(input.weight ?? 0.5),
      description: trimDescription(input.description),
      firstSeenAt: now,
      lastReinforcedAt: now,
      evidence: trimEvidence(input.evidence ?? []),
    };
    await this.store.upsertEdge(fresh);
    return fresh;
  }

  async findEventEventEdge(
    fromEventId: string,
    toEventId: string,
    relationType: string,
    directed: boolean,
  ): Promise<EventEventEdge | undefined> {
    const snapshot = await this.store.loadAll();
    return snapshot.edges.find((e): e is EventEventEdge => {
      if (e.kind !== 'event-event') return false;
      if (e.relationType !== relationType) return false;
      if (directed) return e.fromEventId === fromEventId && e.toEventId === toEventId;
      return (
        (e.fromEventId === fromEventId && e.toEventId === toEventId) ||
        (e.fromEventId === toEventId && e.toEventId === fromEventId)
      );
    });
  }

  // ----- Edge: event → entity -----

  async addEventEntityEdge(input: {
    fromEventId: string;
    toEntityId: string;
    relationType: string;
    weight?: number;
    description?: string;
    evidence?: EvidenceRef[];
  }): Promise<EventEntityEdge> {
    const normalizedType = input.relationType.trim().toLowerCase().replace(/\s+/g, '-');
    const existing = await this.findEventEntityEdge(input.fromEventId, input.toEntityId, normalizedType);
    const now = Date.now();
    if (existing) {
      if (isEvidenceFullyCovered(input.evidence ?? [], existing.evidence) && !input.description) return existing;
      const merged: EventEntityEdge = {
        ...existing,
        weight: clamp01(reinforceWeight(existing.weight, input.weight ?? 0.1)),
        description: trimDescription(input.description) ?? existing.description,
        lastReinforcedAt: now,
        evidence: trimEvidence([...(input.evidence ?? []), ...existing.evidence]),
      };
      await this.store.upsertEdge(merged);
      return merged;
    }
    const fresh: EventEntityEdge = {
      id: globalThis.crypto.randomUUID(),
      kind: 'event-entity',
      fromEventId: input.fromEventId,
      toEntityId: input.toEntityId,
      relationType: normalizedType,
      directed: true,
      weight: clamp01(input.weight ?? 0.5),
      description: trimDescription(input.description),
      firstSeenAt: now,
      lastReinforcedAt: now,
      evidence: trimEvidence(input.evidence ?? []),
    };
    await this.store.upsertEdge(fresh);
    return fresh;
  }

  async findEventEntityEdge(
    fromEventId: string,
    toEntityId: string,
    relationType: string,
  ): Promise<EventEntityEdge | undefined> {
    const snapshot = await this.store.loadAll();
    return snapshot.edges.find(
      (e): e is EventEntityEdge =>
        e.kind === 'event-entity' &&
        e.relationType === relationType &&
        e.fromEventId === fromEventId &&
        e.toEntityId === toEntityId,
    );
  }

  // ----- Edge: entity → entity -----

  async addEntityEntityEdge(input: {
    fromEntityId: string;
    toEntityId: string;
    relationType: string;
    directed?: boolean;
    weight?: number;
    description?: string;
    evidence?: EvidenceRef[];
  }): Promise<EntityEntityEdge> {
    if (input.fromEntityId === input.toEntityId) {
      throw new Error('addEntityEntityEdge: 不允许实体自环');
    }
    const normalizedType = input.relationType.trim().toLowerCase().replace(/\s+/g, '-');
    const directed = input.directed ?? isDirectedEntityEntityRelation(normalizedType);
    const existing = await this.findEntityEntityEdge(input.fromEntityId, input.toEntityId, normalizedType, directed);
    const now = Date.now();
    if (existing) {
      if (isEvidenceFullyCovered(input.evidence ?? [], existing.evidence) && !input.description) return existing;
      const merged: EntityEntityEdge = {
        ...existing,
        weight: clamp01(reinforceWeight(existing.weight, input.weight ?? 0.1)),
        description: trimDescription(input.description) ?? existing.description,
        lastReinforcedAt: now,
        evidence: trimEvidence([...(input.evidence ?? []), ...existing.evidence]),
      };
      await this.store.upsertEdge(merged);
      return merged;
    }
    const fresh: EntityEntityEdge = {
      id: globalThis.crypto.randomUUID(),
      kind: 'entity-entity',
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
      relationType: normalizedType,
      directed,
      weight: clamp01(input.weight ?? 0.5),
      description: trimDescription(input.description),
      firstSeenAt: now,
      lastReinforcedAt: now,
      evidence: trimEvidence(input.evidence ?? []),
    };
    await this.store.upsertEdge(fresh);
    return fresh;
  }

  async findEntityEntityEdge(
    fromEntityId: string,
    toEntityId: string,
    relationType: string,
    directed: boolean,
  ): Promise<EntityEntityEdge | undefined> {
    const snapshot = await this.store.loadAll();
    return snapshot.edges.find((e): e is EntityEntityEdge => {
      if (e.kind !== 'entity-entity') return false;
      if (e.relationType !== relationType) return false;
      if (directed) return e.fromEntityId === fromEntityId && e.toEntityId === toEntityId;
      return (
        (e.fromEntityId === fromEntityId && e.toEntityId === toEntityId) ||
        (e.fromEntityId === toEntityId && e.toEntityId === fromEntityId)
      );
    });
  }

  // ----- Edge: person → event -----

  async addPersonEventEdge(input: {
    fromPersonId: string;
    toEventId: string;
    role: PersonEventEdge['role'];
    sentiment?: PersonEventEdge['sentiment'];
    weight?: number;
    description?: string;
    evidence?: EvidenceRef[];
  }): Promise<PersonEventEdge> {
    const snapshot = await this.store.loadAll();
    const sameLink = snapshot.edges.filter(
      (e): e is PersonEventEdge =>
        e.kind === 'person-event' && e.fromPersonId === input.fromPersonId && e.toEventId === input.toEventId,
    );
    const now = Date.now();

    if (sameLink.length === 0) {
      const fresh: PersonEventEdge = {
        id: globalThis.crypto.randomUUID(),
        kind: 'person-event',
        fromPersonId: input.fromPersonId,
        toEventId: input.toEventId,
        role: input.role,
        sentiment: input.sentiment,
        weight: clamp01(input.weight ?? 0.5),
        description: trimDescription(input.description),
        firstSeenAt: now,
        lastReinforcedAt: now,
        evidence: trimEvidence(input.evidence ?? []),
      };
      await this.store.upsertEdge(fresh);
      return fresh;
    }

    const strongest = sameLink.reduce((a, b) =>
      (PERSON_EVENT_ROLE_RANK[a.role] ?? 0) >= (PERSON_EVENT_ROLE_RANK[b.role] ?? 0) ? a : b,
    );
    const inputRank = PERSON_EVENT_ROLE_RANK[input.role] ?? 0;
    const strongestRank = PERSON_EVENT_ROLE_RANK[strongest.role] ?? 0;
    const finalRole = inputRank > strongestRank ? input.role : strongest.role;

    if (
      finalRole === strongest.role &&
      isEvidenceFullyCovered(input.evidence ?? [], strongest.evidence) &&
      sameLink.length === 1 &&
      !input.description
    ) {
      return strongest;
    }

    const allEvidence = trimEvidence([...(input.evidence ?? []), ...sameLink.flatMap(e => e.evidence)]);
    const merged: PersonEventEdge = {
      ...strongest,
      role: finalRole,
      sentiment: input.sentiment ?? strongest.sentiment,
      weight: clamp01(reinforceWeight(strongest.weight, input.weight ?? 0.1)),
      description: trimDescription(input.description) ?? strongest.description,
      lastReinforcedAt: now,
      evidence: allEvidence,
    };

    for (const e of sameLink) {
      if (e.id !== strongest.id) await this.store.deleteEdge(e.id);
    }
    await this.store.upsertEdge(merged);
    return merged;
  }

  // ----- Edge: person → person -----

  async addPersonPersonEdge(input: {
    fromPersonId: string;
    toPersonId: string;
    relationType: string;
    directed?: boolean;
    weight?: number;
    description?: string;
    evidence?: EvidenceRef[];
  }): Promise<PersonPersonEdge> {
    const normalizedType = normalizeRelationType(input.relationType);
    // 始终视为单向声明：A 说"和 B 是朋友"≠ B 也认同。
    // 若需双向，B 自己再写一条 B → A 即可；UI 渲染时检测对偶边显示双向箭头。
    const directed = input.directed ?? true;

    // 防孤儿：to 必须已存在 PersonNode（避免指向"被提及但从未发言"的幽灵 id）
    const snapshot = await this.store.loadAll();
    const toExists = snapshot.persons.some(p => p.id === input.toPersonId);
    if (!toExists) {
      throw new Error(`addPersonPersonEdge: toPersonId ${input.toPersonId} 不存在为 PersonNode（防止孤儿边）`);
    }

    const existing = await this.findPersonPersonEdge(input.fromPersonId, input.toPersonId, normalizedType, directed);
    const now = Date.now();
    if (existing) {
      if (isEvidenceFullyCovered(input.evidence ?? [], existing.evidence) && !input.description) return existing;
      const merged: PersonPersonEdge = {
        ...existing,
        weight: clamp01(reinforceWeight(existing.weight, input.weight ?? 0.1)),
        description: trimDescription(input.description) ?? existing.description,
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
      description: trimDescription(input.description),
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

  /**
   * 自动老化：按配额淘汰过多节点。模仿 profile 的"写后顺手扫"风格，不开独立调度器。
   *
   * 优先级（每次仅在超额时执行）：
   *   1. **孤儿节点**先删（无任何边的 event / entity；person 不删）；
   *   2. 仍超额时，按 (Date.now() - lastReinforcedAt) / max(weight, 0.05) **降序**排序删；
   *      即"老旧且权重低"的优先删。
   *   3. **保护节点**（evidence.length ≥ 3 或 weight ≥ 0.8）跳过删除。
   *   4. 边也按配额删（保留 weight 最高的）。
   *
   * 返回各类删除计数，便于日志/测试断言。
   */
  async evictByQuota(quota: {
    maxEvents: number;
    maxEntities: number;
    maxEdges: number;
    protectEvidenceCount?: number;
    protectWeight?: number;
  }): Promise<{ deletedEvents: number; deletedEntities: number; deletedEdges: number }> {
    const protectEv = quota.protectEvidenceCount ?? 3;
    const protectW = quota.protectWeight ?? 0.8;
    const snap = await this.store.loadAll();
    let deletedEvents = 0;
    let deletedEntities = 0;
    let deletedEdges = 0;

    const isProtected = (n: EventNode | EntityNode): boolean =>
      (n.evidence?.length ?? 0) >= protectEv || (n.weight ?? 0.5) >= protectW;

    const referencedEventIds = new Set<string>();
    const referencedEntityIds = new Set<string>();
    for (const e of snap.edges) {
      if (e.kind === 'person-event') referencedEventIds.add(e.toEventId);
      else if (e.kind === 'person-entity') referencedEntityIds.add(e.toEntityId);
      else if (e.kind === 'event-event') {
        referencedEventIds.add(e.fromEventId);
        referencedEventIds.add(e.toEventId);
      } else if (e.kind === 'event-entity') {
        referencedEventIds.add(e.fromEventId);
        referencedEntityIds.add(e.toEntityId);
      } else if (e.kind === 'entity-entity') {
        referencedEntityIds.add(e.fromEntityId);
        referencedEntityIds.add(e.toEntityId);
      }
    }

    // 1) 孤儿先删
    for (const ev of snap.events) {
      if (!referencedEventIds.has(ev.id) && !isProtected(ev)) {
        await this.store.deleteEventCascade(ev.id);
        deletedEvents++;
      }
    }
    for (const en of snap.entities) {
      if (!referencedEntityIds.has(en.id) && !isProtected(en)) {
        await this.store.deleteEntityCascade(en.id);
        deletedEntities++;
      }
    }

    // 2) 超额：按 age/weight 排序删
    const now = Date.now();
    const ageScore = (n: EventNode | EntityNode): number =>
      (now - n.lastReinforcedAt) / Math.max(n.weight ?? 0.5, 0.05);

    if (quota.maxEvents > 0) {
      const remainingEvents = (await this.store.loadAll()).events.filter(e => !isProtected(e));
      const overflow = remainingEvents.length + deletedEvents - quota.maxEvents - deletedEvents;
      // 注意：上行简化为 remainingEvents.length - quota.maxEvents
      const toDelete = remainingEvents.length - quota.maxEvents;
      if (toDelete > 0) {
        const sorted = [...remainingEvents].sort((a, b) => ageScore(b) - ageScore(a));
        for (const ev of sorted.slice(0, toDelete)) {
          await this.store.deleteEventCascade(ev.id);
          deletedEvents++;
        }
      }
      void overflow; // 调试用，无副作用
    }
    if (quota.maxEntities > 0) {
      const remainingEntities = (await this.store.loadAll()).entities.filter(e => !isProtected(e));
      const toDelete = remainingEntities.length - quota.maxEntities;
      if (toDelete > 0) {
        const sorted = [...remainingEntities].sort((a, b) => ageScore(b) - ageScore(a));
        for (const en of sorted.slice(0, toDelete)) {
          await this.store.deleteEntityCascade(en.id);
          deletedEntities++;
        }
      }
    }

    // 3) 边配额：保留 weight 最高的
    if (quota.maxEdges > 0) {
      const refreshed = await this.store.loadAll();
      const toDelete = refreshed.edges.length - quota.maxEdges;
      if (toDelete > 0) {
        const sorted = [...refreshed.edges].sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0));
        for (const e of sorted.slice(0, toDelete)) {
          await this.store.deleteEdge(e.id);
          deletedEdges++;
        }
      }
    }

    return { deletedEvents, deletedEntities, deletedEdges };
  }

  /** 查询某人涉及的所有事件 + 实体 + 直连人际关系（深度 1 快捷方法） */
  async getNeighborhood(personId: string): Promise<{
    person: PersonNode | undefined;
    events: EventNode[];
    entities: EntityNode[];
    edges: RelationEdge[];
  }> {
    const snapshot = await this.store.loadAll();
    const person = snapshot.persons.find(p => p.id === personId);
    const relatedEdges = snapshot.edges.filter(e => {
      if (e.kind === 'person-event') return e.fromPersonId === personId;
      if (e.kind === 'person-entity') return e.fromPersonId === personId;
      if (e.kind === 'person-person') return e.fromPersonId === personId || e.toPersonId === personId;
      return false; // event-event 不算 person 邻接
    });
    const eventIds = new Set(
      relatedEdges.filter((e): e is PersonEventEdge => e.kind === 'person-event').map(e => e.toEventId),
    );
    const entityIds = new Set(
      relatedEdges.filter((e): e is PersonEntityEdge => e.kind === 'person-entity').map(e => e.toEntityId),
    );
    const events = snapshot.events.filter(ev => eventIds.has(ev.id));
    const entities = snapshot.entities.filter(ent => entityIds.has(ent.id));
    return { person, events, entities, edges: relatedEdges };
  }

  /**
   * 按 BFS 抽取以指定 person 为起点的子图。
   *
   * - **maxDepth**：探求层数（0 = 仅起点；1 = 起点 + 直接邻居；以此类推）。
   *   人 → 事件 / 人 → 人 各算 1 跳；事件 → 人也算 1 跳，因此 depth=2 可触达"同事件其他参与者"。
   * - **maxBreadth**：单个节点在 BFS 中最多展开的邻居数，按边 weight 降序选取。
   * - **visited**：以 nodeId 集合去重，防止环 / 重复展开（同一节点最多被加入队列一次）。
   *
   * 返回子图包含访问过的节点之间的全部已存在边（不仅 BFS 树边），便于上层渲染完整局部结构。
   */
  async traverseSubgraph(opts: {
    startPersonIds: string[];
    maxDepth: number;
    maxBreadth: number;
  }): Promise<{ persons: PersonNode[]; events: EventNode[]; entities: EntityNode[]; edges: RelationEdge[] }> {
    const empty = { persons: [], events: [], entities: [], edges: [] };
    if (opts.maxDepth < 0 || opts.maxBreadth < 0 || opts.startPersonIds.length === 0) return empty;
    // 0 = 不限，内部映射为足够大的有限数（避免 Infinity 与 BFS 深度比较出错）
    const effectiveDepth = opts.maxDepth === 0 ? Number.MAX_SAFE_INTEGER : opts.maxDepth;
    const effectiveBreadth = opts.maxBreadth === 0 ? Number.MAX_SAFE_INTEGER : opts.maxBreadth;

    const snapshot = await this.store.loadAll();
    const {
      peByPerson,
      ppByPerson,
      peByEvent,
      pentByPerson,
      pentByEntity,
      eeByEvent,
      eentByEvent,
      eentByEntity,
      ententByEntity,
    } = buildAdjacency(snapshot.edges);

    const visited = new Set<string>();
    type NodeKind = 'person' | 'event' | 'entity';
    const queue: Array<{ id: string; kind: NodeKind; depth: number }> = [];
    for (const sid of opts.startPersonIds) {
      if (!visited.has(sid)) {
        visited.add(sid);
        queue.push({ id: sid, kind: 'person', depth: 0 });
      }
    }

    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) break;
      if (cur.depth >= effectiveDepth) continue;
      const neighbors: Array<{ id: string; kind: NodeKind; weight: number }> = [];
      if (cur.kind === 'person') {
        for (const e of ppByPerson.get(cur.id) ?? []) {
          const other = e.fromPersonId === cur.id ? e.toPersonId : e.fromPersonId;
          neighbors.push({ id: other, kind: 'person', weight: e.weight });
        }
        for (const e of peByPerson.get(cur.id) ?? []) {
          neighbors.push({ id: e.toEventId, kind: 'event', weight: e.weight });
        }
        for (const e of pentByPerson.get(cur.id) ?? []) {
          neighbors.push({ id: e.toEntityId, kind: 'entity', weight: e.weight });
        }
      } else if (cur.kind === 'event') {
        for (const e of peByEvent.get(cur.id) ?? []) {
          neighbors.push({ id: e.fromPersonId, kind: 'person', weight: e.weight });
        }
        for (const e of eeByEvent.get(cur.id) ?? []) {
          const other = e.fromEventId === cur.id ? e.toEventId : e.fromEventId;
          neighbors.push({ id: other, kind: 'event', weight: e.weight });
        }
        for (const e of eentByEvent.get(cur.id) ?? []) {
          neighbors.push({ id: e.toEntityId, kind: 'entity', weight: e.weight });
        }
      } else {
        // entity
        for (const e of pentByEntity.get(cur.id) ?? []) {
          neighbors.push({ id: e.fromPersonId, kind: 'person', weight: e.weight });
        }
        for (const e of eentByEntity.get(cur.id) ?? []) {
          neighbors.push({ id: e.fromEventId, kind: 'event', weight: e.weight });
        }
        for (const e of ententByEntity.get(cur.id) ?? []) {
          const other = e.fromEntityId === cur.id ? e.toEntityId : e.fromEntityId;
          neighbors.push({ id: other, kind: 'entity', weight: e.weight });
        }
      }
      neighbors.sort((a, b) => b.weight - a.weight);
      let added = 0;
      for (const n of neighbors) {
        if (visited.has(n.id)) continue;
        visited.add(n.id);
        queue.push({ id: n.id, kind: n.kind, depth: cur.depth + 1 });
        added++;
        if (added >= effectiveBreadth) break;
      }
    }

    const persons = snapshot.persons.filter(p => visited.has(p.id));
    const events = snapshot.events.filter(e => visited.has(e.id));
    const entities = snapshot.entities.filter(e => visited.has(e.id));
    const edges = snapshot.edges.filter(e => {
      if (e.kind === 'person-event') return visited.has(e.fromPersonId) && visited.has(e.toEventId);
      if (e.kind === 'person-entity') return visited.has(e.fromPersonId) && visited.has(e.toEntityId);
      if (e.kind === 'event-event') return visited.has(e.fromEventId) && visited.has(e.toEventId);
      if (e.kind === 'event-entity') return visited.has(e.fromEventId) && visited.has(e.toEntityId);
      if (e.kind === 'entity-entity') return visited.has(e.fromEntityId) && visited.has(e.toEntityId);
      return visited.has(e.fromPersonId) && visited.has(e.toPersonId);
    });
    return { persons, events, entities, edges };
  }

  /**
   * 寻找两个人之间的最短关系链。BFS，事件节点作为中间桥（A→事件→B 算 2 跳）。
   * - maxDepth：路径最大边数；超过返回 null。
   * - 返回 { nodes, edges } 节点列表按路径顺序排列；找不到返回 null。
   */
  async findPath(
    fromPersonId: string,
    toPersonId: string,
    maxDepth: number,
  ): Promise<{ nodes: Array<PersonNode | EventNode | EntityNode>; edges: RelationEdge[] } | null> {
    if (maxDepth < 1) return null;
    const snapshot = await this.store.loadAll();
    const personById = new Map(snapshot.persons.map(p => [p.id, p]));
    const eventById = new Map(snapshot.events.map(e => [e.id, e]));
    const entityById = new Map(snapshot.entities.map(e => [e.id, e]));
    if (fromPersonId === toPersonId) {
      const p = personById.get(fromPersonId);
      return p ? { nodes: [p], edges: [] } : null;
    }
    const adj = new Map<string, Array<{ next: string; edge: RelationEdge }>>();
    const addAdj = (a: string, b: string, edge: RelationEdge) => {
      const arr = adj.get(a);
      if (arr) arr.push({ next: b, edge });
      else adj.set(a, [{ next: b, edge }]);
    };
    for (const e of snapshot.edges) {
      if (e.kind === 'person-event') {
        addAdj(e.fromPersonId, e.toEventId, e);
        addAdj(e.toEventId, e.fromPersonId, e);
      } else if (e.kind === 'person-entity') {
        addAdj(e.fromPersonId, e.toEntityId, e);
        addAdj(e.toEntityId, e.fromPersonId, e);
      } else if (e.kind === 'event-event') {
        addAdj(e.fromEventId, e.toEventId, e);
        if (!e.directed) addAdj(e.toEventId, e.fromEventId, e);
      } else if (e.kind === 'event-entity') {
        addAdj(e.fromEventId, e.toEntityId, e);
        addAdj(e.toEntityId, e.fromEventId, e);
      } else if (e.kind === 'entity-entity') {
        addAdj(e.fromEntityId, e.toEntityId, e);
        if (!e.directed) addAdj(e.toEntityId, e.fromEntityId, e);
      } else {
        addAdj(e.fromPersonId, e.toPersonId, e);
        if (!e.directed) addAdj(e.toPersonId, e.fromPersonId, e);
      }
    }
    const prev = new Map<string, { from: string; edge: RelationEdge }>();
    const visited = new Set<string>([fromPersonId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: fromPersonId, depth: 0 }];
    let found = false;
    bfs: while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) break;
      if (cur.depth >= maxDepth) continue;
      for (const { next, edge } of adj.get(cur.id) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        prev.set(next, { from: cur.id, edge });
        if (next === toPersonId) {
          found = true;
          break bfs;
        }
        queue.push({ id: next, depth: cur.depth + 1 });
      }
    }
    if (!found) return null;
    const pathNodeIds: string[] = [toPersonId];
    const pathEdges: RelationEdge[] = [];
    let cursor = toPersonId;
    while (cursor !== fromPersonId) {
      const p = prev.get(cursor);
      if (!p) return null;
      pathEdges.unshift(p.edge);
      pathNodeIds.unshift(p.from);
      cursor = p.from;
    }
    const nodes = pathNodeIds
      .map(id => personById.get(id) ?? eventById.get(id) ?? entityById.get(id))
      .filter((n): n is PersonNode | EventNode | EntityNode => !!n);
    return { nodes, edges: pathEdges };
  }

  /**
   * 按关键词搜索事件（substring，标题 + summary，不区分大小写）。
   * - days：仅返回 lastReinforcedAt 在 N 天内的事件；0/未传 → 不限
   * - limit：返回上限（默认 20）
   */
  async searchEvents(opts: { keyword?: string; days?: number; limit?: number }): Promise<EventNode[]> {
    const snapshot = await this.store.loadAll();
    const cutoff = opts.days && opts.days > 0 ? Date.now() - opts.days * 86400_000 : 0;
    const kw = opts.keyword?.trim().toLowerCase() ?? '';
    const res = snapshot.events.filter(e => {
      if (e.lastReinforcedAt < cutoff) return false;
      if (!kw) return true;
      const hay = `${e.title} ${e.summary ?? ''}`.toLowerCase();
      return hay.includes(kw);
    });
    res.sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt);
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
    return res.slice(0, limit);
  }
}

/** 边邻接索引：供 BFS 复用，避免每次扫全表 */
function buildAdjacency(edges: RelationEdge[]) {
  const peByPerson = new Map<string, PersonEventEdge[]>();
  const ppByPerson = new Map<string, PersonPersonEdge[]>();
  const peByEvent = new Map<string, PersonEventEdge[]>();
  const pentByPerson = new Map<string, PersonEntityEdge[]>();
  const pentByEntity = new Map<string, PersonEntityEdge[]>();
  const eeByEvent = new Map<string, EventEventEdge[]>();
  // event-entity 双向索引（事件节点 / 实体节点都可能作为 BFS 起点）
  const eentByEvent = new Map<string, EventEntityEdge[]>();
  const eentByEntity = new Map<string, EventEntityEdge[]>();
  // entity-entity 索引：无向边两端均插入
  const ententByEntity = new Map<string, EntityEntityEdge[]>();
  const push = <K, V>(map: Map<K, V[]>, k: K, v: V) => {
    const arr = map.get(k);
    if (arr) arr.push(v);
    else map.set(k, [v]);
  };
  for (const e of edges) {
    if (e.kind === 'person-event') {
      push(peByPerson, e.fromPersonId, e);
      push(peByEvent, e.toEventId, e);
    } else if (e.kind === 'person-entity') {
      push(pentByPerson, e.fromPersonId, e);
      push(pentByEntity, e.toEntityId, e);
    } else if (e.kind === 'event-event') {
      push(eeByEvent, e.fromEventId, e);
      if (!e.directed) push(eeByEvent, e.toEventId, e);
    } else if (e.kind === 'event-entity') {
      push(eentByEvent, e.fromEventId, e);
      push(eentByEntity, e.toEntityId, e);
    } else if (e.kind === 'entity-entity') {
      push(ententByEntity, e.fromEntityId, e);
      if (!e.directed) push(ententByEntity, e.toEntityId, e);
    } else {
      push(ppByPerson, e.fromPersonId, e);
      if (!e.directed) push(ppByPerson, e.toPersonId, e);
    }
  }
  return {
    peByPerson,
    ppByPerson,
    peByEvent,
    pentByPerson,
    pentByEntity,
    eeByEvent,
    eentByEvent,
    eentByEntity,
    ententByEntity,
  };
}

// ----- 辅助函数 -----

/** 节点名称归一化：去首尾空白、压缩中间空白、小写化。用于按名去重。 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** weight 累积：增量按 (1 - weight) * delta 收敛，避免无限增长 */
export function reinforceWeight(prev: number, delta: number): number {
  return prev + (1 - prev) * delta;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** 单实体保留最近 N 条 evidence（按 extractedAt DESC 截断 + 同 key 去重）
 *  Key = `sessionId|sorted(messageIds).join(',')`。不同批抽取打到同一批 messageIds 会被认为重复。
 */
export function trimEvidence(list: EvidenceRef[]): EvidenceRef[] {
  const sorted = [...list].sort((a, b) => b.extractedAt - a.extractedAt);
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const e of sorted) {
    const k = evidenceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= MAX_EVIDENCE_PER_ENTITY) break;
  }
  return out;
}

/** 两条 evidence 是否识别为「同一条」（来自同会话 + 同批 messageIds）。 */
function evidenceKey(e: EvidenceRef): string {
  return `${e.sessionId}|${[...e.messageIds].sort().join(',')}`;
}

/** incoming 是否被 existing 完全覆盖（同一批消息已记过）。
 *  成立时调用方可跳过 reinforce，避免同事实被重复计权。
 *  incoming 为空时返回 false（保留原有「无 evidence 仍允许动作」语义）。
 */
export function isEvidenceFullyCovered(incoming: EvidenceRef[], existing: EvidenceRef[]): boolean {
  if (incoming.length === 0) return false;
  const keys = new Set(existing.map(evidenceKey));
  return incoming.every(e => keys.has(evidenceKey(e)));
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

/** event-event 边的方向性默认：有向的常见关系 */
const DIRECTED_EVENT_EVENT_RELATIONS = new Set<string>(['caused-by', 'follows', 'part-of']);
function isDirectedEventEventRelation(relationType: string): boolean {
  return DIRECTED_EVENT_EVENT_RELATIONS.has(relationType);
}

/** entity-entity 边的方向性默认：「part-of / contains / variant-of」有向；「related / opposite」无向 */
const DIRECTED_ENTITY_ENTITY_RELATIONS = new Set<string>(['part-of', 'contains', 'variant-of']);
function isDirectedEntityEntityRelation(relationType: string): boolean {
  return DIRECTED_ENTITY_ENTITY_RELATIONS.has(relationType);
}

/** description 裁剪：去首尾空白、限长 40 字，空串返回 undefined */
function trimDescription(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const t = d.trim();
  if (!t) return undefined;
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}
