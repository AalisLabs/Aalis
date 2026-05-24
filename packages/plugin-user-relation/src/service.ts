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
import type { Context } from '@aalis/core';
import type { ModelRef } from '@aalis/plugin-llm-api';

import {
  inferEntityHierarchy,
  inferMissingParent,
  resolveConsolidateModel,
  rewriteEntitySummary,
  verifyAliasPair,
} from './consolidate-llm.js';
import { getKnownPlatformsLower, isPlaceholderSelfPersonId } from './extractor.js';
import type { RelationStore } from './store.js';
import type {
  EntityEntityEdge,
  EntityNode,
  EventEntityEdge,
  EventEventEdge,
  EventNode,
  EvidenceRef,
  NodeNameAudit,
  PersonEntityEdge,
  PersonEventEdge,
  PersonNode,
  PersonPersonEdge,
  RelationEdge,
  RelationGraphSnapshot,
} from './types.js';

import {
  buildAdjacency,
  chooseCanonicalDirection,
  clamp01,
  commonPrefix,
  computePageRank,
  edgeDedupKey,
  edgeInvolvesBoth,
  edgeReferences,
  flipDirectedEdge,
  isAliasEdgeDirectionCorrect,
  isAliasMarkerEdge,
  isDirectedEntityEntityRelation,
  isDirectedEventEventRelation,
  isEdgeSelfLoop,
  isEvidenceFullyCovered,
  mergeTwoEdges,
  normalizeName,
  normalizeRelationType,
  PERSON_ENTITY_ROLE_RANK,
  PERSON_EVENT_ROLE_RANK,
  reinforceWeight,
  rewriteEdgeIds,
  trimDescription,
  trimEvidence,
} from './utils.js';

export type TriggerExtractionFn = (
  sessionId: string,
) => Promise<{ status: 'ok' | 'skipped' | 'error'; reason?: string }>;

export class RelationService {
  /** 由 extractor 注入；actions 层通过 triggerExtraction() 调用 */
  private triggerExtractionHandler?: TriggerExtractionFn;
  /** 最近一次 consolidate() 完成的时间戳（ms）；未运行时为 undefined */
  private _lastConsolidateAt?: number;
  /** 最近一次 consolidate() 结果的简短摘要 */
  private _lastConsolidateResultSummary?: string;
  /** 最近一次 consolidate() 的触发来源：manual | eviction | api */
  private _lastConsolidateTrigger?: 'manual' | 'eviction' | 'api';

  constructor(private readonly store: RelationStore) {}

  /** 查询最近一次 consolidation 运行时间、触发源与结果摘要 */
  getLastConsolidateInfo(): {
    lastRunAt?: number;
    summary?: string;
    trigger?: 'manual' | 'eviction' | 'api';
  } {
    return {
      lastRunAt: this._lastConsolidateAt,
      summary: this._lastConsolidateResultSummary,
      trigger: this._lastConsolidateTrigger,
    };
  }

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
          lastMentionedAt: now,
          mentionCount: (existing.mentionCount ?? 0) + 1,
        }
      : {
          id: RelationService.personId(platform, userId),
          platform,
          userId,
          displayName,
          firstSeenAt: now,
          lastSeenAt: now,
          lastMentionedAt: now,
          mentionCount: 1,
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
        lastMentionedAt: now,
        mentionCount: (dup.mentionCount ?? 0) + 1,
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
      lastMentionedAt: now,
      mentionCount: 1,
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
        lastMentionedAt: now,
        mentionCount: (dup.mentionCount ?? 0) + 1,
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
      lastMentionedAt: now,
      mentionCount: 1,
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
    if (normalizedType === 'is-alias-of') {
      await this.mergeAlias({ aliasId: fresh.fromEventId, canonicalId: fresh.toEventId, kind: 'event' });
    }
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
    if (normalizedType === 'is-alias-of') {
      await this.mergeAlias({ aliasId: fresh.fromEntityId, canonicalId: fresh.toEntityId, kind: 'entity' });
    }
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

    // ─── 第 1 步：按 role 分桶，去除同 role 重复行 ───
    const byRole = new Map<PersonEventEdge['role'], PersonEventEdge>();
    for (const e of sameLink) {
      const prev = byRole.get(e.role);
      if (!prev) {
        byRole.set(e.role, e);
      } else {
        // 同 role 多条：保留较早的，合并 evidence/权重，删除新的
        const folded: PersonEventEdge = {
          ...prev,
          firstSeenAt: Math.min(prev.firstSeenAt, e.firstSeenAt),
          lastReinforcedAt: Math.max(prev.lastReinforcedAt, e.lastReinforcedAt),
          weight: clamp01(Math.max(prev.weight, e.weight)),
          sentiment: prev.sentiment ?? e.sentiment,
          description: prev.description ?? e.description,
          evidence: trimEvidence([...prev.evidence, ...e.evidence]),
        };
        byRole.set(e.role, folded);
        await this.store.deleteEdge(e.id);
      }
    }

    // ─── 第 2 步：决定 input 的归属（吸收规则） ───
    // R1: initiator 吸收 participant —— 若加入 input 后两者并存，participant 并入 initiator
    // R2: 任何非 witness 角色吸收 witness —— witness 仅在「单独存在」时保留
    // 其它角色 (target / reporter) 与 initiator / participant 可独立并存
    const absorberFor = (
      role: PersonEventEdge['role'],
      others: Set<PersonEventEdge['role']>,
    ): PersonEventEdge['role'] => {
      if (role === 'participant' && others.has('initiator')) return 'initiator';
      if (role === 'witness') {
        const candidates = [...others].filter(r => r !== 'witness');
        if (candidates.length > 0) {
          return candidates.reduce((a, b) =>
            (PERSON_EVENT_ROLE_RANK[a] ?? 0) >= (PERSON_EVENT_ROLE_RANK[b] ?? 0) ? a : b,
          );
        }
      }
      return role;
    };

    const presentRoles = new Set(byRole.keys());
    // 把 input 也加入一起考虑
    const all = new Set(presentRoles);
    all.add(input.role);
    // 先解决 input.role
    const inputTargetRole = absorberFor(input.role, all);

    // ─── 第 3 步：把已存在的旧 role 中需要被吸收的也并入 ───
    const finalRoles = new Set<PersonEventEdge['role']>();
    finalRoles.add(inputTargetRole);
    for (const r of presentRoles) {
      const tgt = absorberFor(r, all);
      if (tgt === r) finalRoles.add(r);
      else {
        // r 被吸收到 tgt：把这条 role 的 evidence 转移给吸收者
        const absorbed = byRole.get(r);
        const absorber = byRole.get(tgt);
        if (absorbed && absorber) {
          const merged: PersonEventEdge = {
            ...absorber,
            firstSeenAt: Math.min(absorber.firstSeenAt, absorbed.firstSeenAt),
            lastReinforcedAt: Math.max(absorber.lastReinforcedAt, absorbed.lastReinforcedAt),
            weight: clamp01(Math.max(absorber.weight, absorbed.weight)),
            sentiment: absorber.sentiment ?? absorbed.sentiment,
            description: absorber.description ?? absorbed.description,
            evidence: trimEvidence([...absorber.evidence, ...absorbed.evidence]),
          };
          byRole.set(tgt, merged);
        } else if (absorbed && !absorber) {
          // 吸收者尚不存在（input 即将创建），先临时改 role 让它存到 inputTargetRole 上
          byRole.set(tgt, { ...absorbed, role: tgt });
        }
        if (absorbed) await this.store.deleteEdge(absorbed.id);
        byRole.delete(r);
        finalRoles.add(tgt);
      }
    }

    // ─── 第 4 步：把 input 写入 inputTargetRole 对应的边 ───
    const target = byRole.get(inputTargetRole);
    if (!target) {
      const fresh: PersonEventEdge = {
        id: globalThis.crypto.randomUUID(),
        kind: 'person-event',
        fromPersonId: input.fromPersonId,
        toEventId: input.toEventId,
        role: inputTargetRole,
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

    // 命中已有 role 行：强化
    if (
      isEvidenceFullyCovered(input.evidence ?? [], target.evidence) &&
      !input.description &&
      input.sentiment === undefined
    ) {
      if (target.role !== inputTargetRole) {
        const fixed: PersonEventEdge = { ...target, role: inputTargetRole };
        await this.store.upsertEdge(fixed);
        return fixed;
      }
      return target;
    }

    const merged: PersonEventEdge = {
      ...target,
      role: inputTargetRole,
      sentiment: input.sentiment ?? target.sentiment,
      weight: clamp01(reinforceWeight(target.weight, input.weight ?? 0.1)),
      description: trimDescription(input.description) ?? target.description,
      lastReinforcedAt: now,
      evidence: trimEvidence([...(input.evidence ?? []), ...target.evidence]),
    };
    await this.store.upsertEdge(merged);
    return merged;
  }

  // ----- Edge: person → person -----

  async addPersonPersonEdge(input: {
    fromPersonId: string;
    toPersonId: string;
    relationType: string;
    directed?: boolean;
    hierarchy?: PersonPersonEdge['hierarchy'];
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
        // hierarchy 使用「后来者覆盖 unknown」策略：如果之前是 unknown / 未填、
        // 今次增量证据给出了具体值，则采纳；反之已有具体值不被 unknown 覆盖。
        hierarchy:
          input.hierarchy && input.hierarchy !== 'unknown' ? input.hierarchy : (existing.hierarchy ?? input.hierarchy),
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
      hierarchy: input.hierarchy,
      weight: clamp01(input.weight ?? 0.5),
      description: trimDescription(input.description),
      firstSeenAt: now,
      lastReinforcedAt: now,
      evidence: trimEvidence(input.evidence ?? []),
    };
    await this.store.upsertEdge(fresh);
    if (normalizedType === 'is-alias-of' || normalizedType === 'alt-account-of') {
      await this.mergeAlias({ aliasId: fresh.fromPersonId, canonicalId: fresh.toPersonId, kind: 'person' });
    }
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
   * 清理孤儿节点：删除所有"没有任何边引用"的 person / event / entity。
   *
   * 设计原则（v3，最简）：
   * - **没有任何边端点引用 = 孤儿**，三类节点一视同仁。边的 6 种 kind 中只要节点
   *   出现在任一 from/to 字段上就算"被引用"。
   * - **person 孤儿也清**：observePerson 按 (platform, userId) upsert，删掉的"水群幽灵"
   *   下次发言时会自动重建，所以删除安全。
   * - **零保护**：weight/evidence 门槛属于配额淘汰阶段的事，与孤儿无关；
   *   孤儿的语义就是"没人指向"，无条件清。
   * - **零参数**：刻意不暴露任何 opts，避免重新引入误用。
   *
   * 返回被删除的 id 列表，便于 caller 打日志/报告。
   */
  async pruneOrphans(): Promise<{
    deletedPersons: number;
    deletedEvents: number;
    deletedEntities: number;
    deletedPersonIds: string[];
    deletedEventIds: string[];
    deletedEntityIds: string[];
  }> {
    const snap = await this.store.loadAll();
    const referencedPersonIds = new Set<string>();
    const referencedEventIds = new Set<string>();
    const referencedEntityIds = new Set<string>();
    for (const e of snap.edges) {
      switch (e.kind) {
        case 'person-event':
          referencedPersonIds.add(e.fromPersonId);
          referencedEventIds.add(e.toEventId);
          break;
        case 'person-entity':
          referencedPersonIds.add(e.fromPersonId);
          referencedEntityIds.add(e.toEntityId);
          break;
        case 'person-person':
          referencedPersonIds.add(e.fromPersonId);
          referencedPersonIds.add(e.toPersonId);
          break;
        case 'event-event':
          referencedEventIds.add(e.fromEventId);
          referencedEventIds.add(e.toEventId);
          break;
        case 'event-entity':
          referencedEventIds.add(e.fromEventId);
          referencedEntityIds.add(e.toEntityId);
          break;
        case 'entity-entity':
          referencedEntityIds.add(e.fromEntityId);
          referencedEntityIds.add(e.toEntityId);
          break;
      }
    }
    const deletedPersonIds: string[] = [];
    const deletedEventIds: string[] = [];
    const deletedEntityIds: string[] = [];
    for (const p of snap.persons) {
      if (!referencedPersonIds.has(p.id)) {
        await this.store.deletePersonCascade(p.platform, p.userId);
        deletedPersonIds.push(p.id);
      }
    }
    for (const ev of snap.events) {
      if (!referencedEventIds.has(ev.id)) {
        await this.store.deleteEventCascade(ev.id);
        deletedEventIds.push(ev.id);
      }
    }
    for (const en of snap.entities) {
      if (!referencedEntityIds.has(en.id)) {
        await this.store.deleteEntityCascade(en.id);
        deletedEntityIds.push(en.id);
      }
    }
    return {
      deletedPersons: deletedPersonIds.length,
      deletedEvents: deletedEventIds.length,
      deletedEntities: deletedEntityIds.length,
      deletedPersonIds,
      deletedEventIds,
      deletedEntityIds,
    };
  }

  /**
   * 自动老化：按配额淘汰过多节点。模仿 profile 的"写后顺手扫"风格，不开独立调度器。
   *
   * 优先级（每次仅在超额时执行）：
   *   1. **孤儿节点**先删（无任何边引用的 person / event / entity；委托 `pruneOrphans()`）。
   *      孤儿清理与配额无关，旧账噪声任何时候都清。
   *   2. 仍超额时按 `(now - lastReinforcedAt) / (max(weight,0.05) · max(PR,ε))` **降序**删；
   *      即"老旧 + 低权重 + 在 PageRank 上无人指向"的优先丢。
   *   3. **保护节点**（evidence.length ≥ 3 或 weight ≥ 0.8）在配额阶段跳过删除，
   *      避免误删活跃节点。该保护**仅作用于配额阶段**，不影响孤儿清理。
   *   4. **滞回（hysteresis）**：仅当 count > quota·(1+hysteresisPct) 时才触发，
   *      触发后一次性裁到 floor(quota·targetPct)。默认 hysteresis=0.2, target=0.8 ——
   *      quota=500 时会在 600 触发并裁到 400，相当于一次清理 ~200 条；不会每写一条就裁。
   *   5. 边也按配额删——保留 `weight · 端点PR平均` 最高的，让"弱权但连接重要节点"的边受保护。
   *
   * 副作用：每次调用都会把 PageRank 写回三类节点的 `lastPageRank` / `lastPageRankAt`，
   * 用于 WebUI 展示"图重要性"。
   *
   * PageRank 个性化向量按 kind 加权（人=3，物=2，事=1），从而"重要性 人>物>事"
   * 直接体现为分数偏置：人物附近的事件/实体更难被淘汰。
   *
   * 返回各类删除计数，便于日志/测试断言。
   */
  async evictByQuota(quota: {
    maxEvents: number;
    maxEntities: number;
    maxEdges: number;
    protectEvidenceCount?: number;
    protectWeight?: number;
    /** PageRank 阻尼，默认 0.85 */
    pagerankDamping?: number;
    /** PageRank 最大迭代次数，默认 20 */
    pagerankIterations?: number;
    /** PageRank 收敛阈值（L1 误差），默认 1e-4 */
    pagerankEpsilon?: number;
    /** 滞回百分比；count > quota·(1+hysteresisPct) 才触发淘汰。默认 0.2 */
    hysteresisPct?: number;
    /** 触发后裁到 floor(quota·targetPct)。默认 0.8 */
    targetPct?: number;
    /** PageRank 个性化向量种子权（人/物/事），默认 3/2/1 */
    personSeed?: number;
    entitySeed?: number;
    eventSeed?: number;
  }): Promise<{
    deletedPersons: number;
    deletedEvents: number;
    deletedEntities: number;
    deletedEdges: number;
    /** 孤儿阶段被删的 id 列表（前 50 个），便于日志/诊断 */
    orphanSamples: { persons: string[]; events: string[]; entities: string[] };
  }> {
    const protectEv = quota.protectEvidenceCount ?? 3;
    const protectW = quota.protectWeight ?? 0.8;
    const damping = quota.pagerankDamping ?? 0.85;
    const maxIter = quota.pagerankIterations ?? 20;
    const epsilon = quota.pagerankEpsilon ?? 1e-4;
    const hysteresisPct = Math.max(quota.hysteresisPct ?? 0.2, 0);
    const targetPct = Math.min(Math.max(quota.targetPct ?? 0.8, 0.1), 1);
    const personSeed = quota.personSeed ?? 3;
    const entitySeed = quota.entitySeed ?? 2;
    const eventSeed = quota.eventSeed ?? 1;
    let deletedPersons = 0;
    let deletedEvents = 0;
    let deletedEntities = 0;
    let deletedEdges = 0;

    const isProtected = (n: EventNode | EntityNode): boolean =>
      (n.evidence?.length ?? 0) >= protectEv || (n.weight ?? 0.5) >= protectW;

    // 1) 先做孤儿清理（与配额无关，旧账噪声总是清；person / event / entity 一视同仁）
    const orphanResult = await this.pruneOrphans();
    deletedPersons += orphanResult.deletedPersons;
    deletedEvents += orphanResult.deletedEvents;
    deletedEntities += orphanResult.deletedEntities;

    // 之后再加载快照（pruneOrphans 已写入存储）
    const snap = await this.store.loadAll();

    // 2) 超额：用 PageRank 评估节点重要性，把"老旧 + 低权 + PR 边缘"的优先丢
    //    PageRank 个性化向量给人/物/事不同的种子权重，让"重要性 人>物>事"直接体现在分数偏置上。
    //    无需 sqrt(degree+1) 之类启发式 —— 全图 PR 同时反映"度"和"被高重要节点引用"。
    const now = Date.now();
    const pr = computePageRank(snap, {
      damping,
      maxIter,
      epsilon,
      personSeed,
      entitySeed,
      eventSeed,
    });
    const ageScore = (n: EventNode | EntityNode): number => {
      const w = Math.max(n.weight ?? 0.5, 0.05);
      const p = Math.max(pr.get(n.id) ?? 0, 1e-6);
      return (now - n.lastReinforcedAt) / (w * p);
    };

    // ─── 裸 event 加权：无 part-of 实体锚 且 其参与人之间无 person-person 边 → 优先淘汰
    //   背景：纯人际事件应配 person-person 关系；既无 entity 锚也无人际边的 event = 噪声
    //   实现：用绝对偏移（Number.MAX_SAFE_INTEGER 量级）作为分桶标记，确保裸 event 始终排在非裸前面，
    //          不依赖时间差/PageRank 比值，避免毫秒级测试与小图场景下相对差被噪声淹没
    const nakedTier = Number.MAX_SAFE_INTEGER / 2;
    const eventPartOfCount = new Map<string, number>();
    const eventParticipants = new Map<string, Set<string>>();
    for (const e of snap.edges) {
      if (e.kind === 'event-entity' && e.relationType === 'part-of') {
        eventPartOfCount.set(e.fromEventId, (eventPartOfCount.get(e.fromEventId) ?? 0) + 1);
      } else if (e.kind === 'person-event') {
        if (!eventParticipants.has(e.toEventId)) eventParticipants.set(e.toEventId, new Set());
        eventParticipants.get(e.toEventId)!.add(e.fromPersonId);
      }
    }
    const personPersonPairs = new Set<string>();
    for (const e of snap.edges) {
      if (e.kind === 'person-person') {
        const k = [e.fromPersonId, e.toPersonId].sort().join('|');
        personPersonPairs.add(k);
      }
    }
    const isNakedEvent = (ev: EventNode): boolean => {
      if ((eventPartOfCount.get(ev.id) ?? 0) > 0) return false;
      const parts = [...(eventParticipants.get(ev.id) ?? [])];
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const k = [parts[i], parts[j]].sort().join('|');
          if (personPersonPairs.has(k)) return false;
        }
      }
      return true;
    };
    const eventEvictScore = (ev: EventNode): number => (isNakedEvent(ev) ? ageScore(ev) + nakedTier : ageScore(ev));

    // 滞回：仅当超出 quota·(1+hysteresisPct) 才裁；裁到 floor(quota·targetPct)
    const triggerCount = (cap: number): number => Math.ceil(cap * (1 + hysteresisPct));
    const targetCount = (cap: number): number => Math.floor(cap * targetPct);

    if (quota.maxEvents > 0) {
      const remainingEvents = (await this.store.loadAll()).events.filter(e => !isProtected(e));
      if (remainingEvents.length >= triggerCount(quota.maxEvents)) {
        const toDelete = remainingEvents.length - targetCount(quota.maxEvents);
        if (toDelete > 0) {
          const sorted = [...remainingEvents].sort((a, b) => eventEvictScore(b) - eventEvictScore(a));
          for (const ev of sorted.slice(0, toDelete)) {
            await this.store.deleteEventCascade(ev.id);
            deletedEvents++;
          }
        }
      }
    }
    if (quota.maxEntities > 0) {
      const remainingEntities = (await this.store.loadAll()).entities.filter(e => !isProtected(e));
      if (remainingEntities.length >= triggerCount(quota.maxEntities)) {
        const toDelete = remainingEntities.length - targetCount(quota.maxEntities);
        if (toDelete > 0) {
          const sorted = [...remainingEntities].sort((a, b) => ageScore(b) - ageScore(a));
          for (const en of sorted.slice(0, toDelete)) {
            await this.store.deleteEntityCascade(en.id);
            deletedEntities++;
          }
        }
      }
    }

    // 3) 边配额：按 `weight · 端点PR平均` 升序删（弱权且连接边缘节点的边优先丢）
    if (quota.maxEdges > 0) {
      const refreshed = await this.store.loadAll();
      if (refreshed.edges.length >= triggerCount(quota.maxEdges)) {
        const toDelete = refreshed.edges.length - targetCount(quota.maxEdges);
        if (toDelete > 0) {
          const edgeEndpoints = (e: RelationEdge): [string, string] => {
            switch (e.kind) {
              case 'person-event':
                return [e.fromPersonId, e.toEventId];
              case 'person-entity':
                return [e.fromPersonId, e.toEntityId];
              case 'person-person':
                return [e.fromPersonId, e.toPersonId];
              case 'event-event':
                return [e.fromEventId, e.toEventId];
              case 'event-entity':
                return [e.fromEventId, e.toEntityId];
              case 'entity-entity':
                return [e.fromEntityId, e.toEntityId];
            }
          };
          const edgeScore = (e: RelationEdge): number => {
            const [a, b] = edgeEndpoints(e);
            const prAvg = ((pr.get(a) ?? 0) + (pr.get(b) ?? 0)) / 2;
            return (e.weight ?? 0) * Math.max(prAvg, 1e-6);
          };
          const sorted = [...refreshed.edges].sort((a, b) => edgeScore(a) - edgeScore(b));
          for (const e of sorted.slice(0, toDelete)) {
            await this.store.deleteEdge(e.id);
            deletedEdges++;
          }
        }
      }
    }

    // 4) 把 PageRank 写回三类节点，供 WebUI 展示"图重要性"
    {
      const after = await this.store.loadAll();
      for (const p of after.persons) {
        const score = pr.get(p.id);
        if (score !== undefined) await this.store.upsertPerson({ ...p, lastPageRank: score, lastPageRankAt: now });
      }
      for (const ev of after.events) {
        const score = pr.get(ev.id);
        if (score !== undefined) await this.store.upsertEvent({ ...ev, lastPageRank: score, lastPageRankAt: now });
      }
      for (const en of after.entities) {
        const score = pr.get(en.id);
        if (score !== undefined) await this.store.upsertEntity({ ...en, lastPageRank: score, lastPageRankAt: now });
      }
    }

    return {
      deletedPersons,
      deletedEvents,
      deletedEntities,
      deletedEdges,
      orphanSamples: {
        persons: orphanResult.deletedPersonIds.slice(0, 50),
        events: orphanResult.deletedEventIds.slice(0, 50),
        entities: orphanResult.deletedEntityIds.slice(0, 50),
      },
    };
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
    /** 起点节点 id 列表，按 snapshot 自动推断 kind（person / event / entity） */
    startNodeIds: string[];
    maxDepth: number;
    maxBreadth: number;
  }): Promise<{ persons: PersonNode[]; events: EventNode[]; entities: EntityNode[]; edges: RelationEdge[] }> {
    const empty = { persons: [], events: [], entities: [], edges: [] };
    const starts = opts.startNodeIds ?? [];
    if (opts.maxDepth < 0 || opts.maxBreadth < 0 || starts.length === 0) return empty;
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

    type NodeKind = 'person' | 'event' | 'entity';
    // 起点 kind 推断：先查 persons/events/entities 集合
    const personIdSet0 = new Set(snapshot.persons.map(p => p.id));
    const eventIdSet0 = new Set(snapshot.events.map(e => e.id));
    const entityIdSet0 = new Set(snapshot.entities.map(e => e.id));
    const inferKind = (id: string): NodeKind | undefined => {
      if (personIdSet0.has(id)) return 'person';
      if (eventIdSet0.has(id)) return 'event';
      if (entityIdSet0.has(id)) return 'entity';
      // 兜底：含冒号当 person（兼容 platform:userId 即便尚未入库）
      return id.includes(':') ? 'person' : undefined;
    };

    const visited = new Set<string>();
    const queue: Array<{ id: string; kind: NodeKind; depth: number }> = [];
    for (const sid of starts) {
      if (visited.has(sid)) continue;
      const k = inferKind(sid);
      if (!k) continue;
      visited.add(sid);
      queue.push({ id: sid, kind: k, depth: 0 });
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
    fromNodeId: string,
    toNodeId: string,
    maxDepth: number,
  ): Promise<{ nodes: Array<PersonNode | EventNode | EntityNode>; edges: RelationEdge[] } | null> {
    if (maxDepth < 1) return null;
    const snapshot = await this.store.loadAll();
    const personById = new Map(snapshot.persons.map(p => [p.id, p]));
    const eventById = new Map(snapshot.events.map(e => [e.id, e]));
    const entityById = new Map(snapshot.entities.map(e => [e.id, e]));
    if (fromNodeId === toNodeId) {
      const n = personById.get(fromNodeId) ?? eventById.get(fromNodeId) ?? entityById.get(fromNodeId);
      return n ? { nodes: [n], edges: [] } : null;
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
    const visited = new Set<string>([fromNodeId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: fromNodeId, depth: 0 }];
    let found = false;
    bfs: while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) break;
      if (cur.depth >= maxDepth) continue;
      for (const { next, edge } of adj.get(cur.id) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        prev.set(next, { from: cur.id, edge });
        if (next === toNodeId) {
          found = true;
          break bfs;
        }
        queue.push({ id: next, depth: cur.depth + 1 });
      }
    }
    if (!found) return null;
    const pathNodeIds: string[] = [toNodeId];
    const pathEdges: RelationEdge[] = [];
    let cursor = toNodeId;
    while (cursor !== fromNodeId) {
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
   * 计算两节点间「联系强度」(Katz-style limited-depth path enumeration)。
   *
   * 算法：枚举 a→b 所有简单路径（长度 ≤ maxDepth），每条路径贡献
   *   contrib = β^|p| * ∏_{e∈p} w_e
   * 汇总 rawScore = Σ contrib；归一化 score = tanh(rawScore) ∈ [0,1]。
   *
   * - 多条路径累加 → 体现「多途径连通」（如三角闭合）
   * - β（默认 0.5）按路径长度衰减，长路径权重指数减小
   * - 路径上不允许重复节点（简单路径），避免环膨胀
   * - 复杂度 O(deg^maxDepth)，maxDepth ≤ 4 时在中等图上完全可控
   *
   * 返回 topPaths 用于「为什么这么高」的可解释性，对 LLM 友好。
   * 同节点 → score=1。任一端不在图中 → score=0 + paths=[]。
   */
  async scoreBetween(
    fromNodeId: string,
    toNodeId: string,
    opts: { maxDepth?: number; beta?: number; topPaths?: number } = {},
  ): Promise<{
    fromId: string;
    toId: string;
    score: number; // 归一化 [0,1]
    rawScore: number;
    pathsConsidered: number;
    shortestLength: number | null;
    directlyConnected: boolean;
    topPaths: Array<{
      nodes: Array<PersonNode | EventNode | EntityNode>;
      edges: RelationEdge[];
      length: number;
      weightProduct: number;
      contribution: number;
    }>;
  }> {
    const maxDepth = Math.max(1, Math.min(6, opts.maxDepth ?? 4));
    const beta = Math.max(0.05, Math.min(1, opts.beta ?? 0.5));
    const topK = Math.max(1, Math.min(20, opts.topPaths ?? 3));

    const snapshot = await this.store.loadAll();
    const personById = new Map(snapshot.persons.map(p => [p.id, p]));
    const eventById = new Map(snapshot.events.map(e => [e.id, e]));
    const entityById = new Map(snapshot.entities.map(e => [e.id, e]));
    const nodeOf = (id: string) => personById.get(id) ?? eventById.get(id) ?? entityById.get(id);

    if (fromNodeId === toNodeId) {
      return {
        fromId: fromNodeId,
        toId: toNodeId,
        score: nodeOf(fromNodeId) ? 1 : 0,
        rawScore: nodeOf(fromNodeId) ? 1 : 0,
        pathsConsidered: 0,
        shortestLength: 0,
        directlyConnected: false,
        topPaths: [],
      };
    }
    if (!nodeOf(fromNodeId) || !nodeOf(toNodeId)) {
      return {
        fromId: fromNodeId,
        toId: toNodeId,
        score: 0,
        rawScore: 0,
        pathsConsidered: 0,
        shortestLength: null,
        directlyConnected: false,
        topPaths: [],
      };
    }

    // 邻接表（无向化，与 findPath 一致：directed 边只单向，其余双向）
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

    // DFS 枚举所有 a→b 简单路径（限深 maxDepth）
    type Path = { edges: RelationEdge[]; nodeIds: string[]; weightProduct: number };
    const allPaths: Path[] = [];
    const visited = new Set<string>([fromNodeId]);
    const curEdges: RelationEdge[] = [];
    const curNodes: string[] = [fromNodeId];
    const dfs = (cur: string, depth: number) => {
      if (cur === toNodeId) {
        // 计算 weight 乘积
        let prod = 1;
        for (const e of curEdges) prod *= Math.max(1e-6, e.weight);
        allPaths.push({ edges: [...curEdges], nodeIds: [...curNodes], weightProduct: prod });
        return;
      }
      if (depth >= maxDepth) return;
      for (const { next, edge } of adj.get(cur) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        curEdges.push(edge);
        curNodes.push(next);
        dfs(next, depth + 1);
        curEdges.pop();
        curNodes.pop();
        visited.delete(next);
      }
    };
    dfs(fromNodeId, 0);

    if (allPaths.length === 0) {
      return {
        fromId: fromNodeId,
        toId: toNodeId,
        score: 0,
        rawScore: 0,
        pathsConsidered: 0,
        shortestLength: null,
        directlyConnected: false,
        topPaths: [],
      };
    }

    let rawScore = 0;
    let shortestLength = Infinity;
    for (const p of allPaths) {
      const len = p.edges.length;
      const contrib = beta ** len * p.weightProduct;
      rawScore += contrib;
      if (len < shortestLength) shortestLength = len;
    }
    const score = Math.tanh(rawScore);

    // 取 top-K 路径（按 contribution 降序）
    const scored = allPaths
      .map(p => {
        const len = p.edges.length;
        return { p, len, contribution: beta ** len * p.weightProduct };
      })
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, topK);

    const topPaths = scored.map(({ p, len, contribution }) => ({
      nodes: p.nodeIds.map(id => nodeOf(id)).filter((n): n is PersonNode | EventNode | EntityNode => !!n),
      edges: p.edges,
      length: len,
      weightProduct: p.weightProduct,
      contribution,
    }));

    return {
      fromId: fromNodeId,
      toId: toNodeId,
      score,
      rawScore,
      pathsConsidered: allPaths.length,
      shortestLength: shortestLength === Infinity ? null : shortestLength,
      directlyConnected: shortestLength === 1,
      topPaths,
    };
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

  /**
   * 按关键词搜索人物。匹配 displayName / userId / aliases / id（substring，不区分大小写）。
   * - platform：可选，仅返回该平台下的人物
   * - limit：返回上限（默认 20）
   */
  async searchPersons(opts: { keyword?: string; platform?: string; limit?: number }): Promise<PersonNode[]> {
    const snapshot = await this.store.loadAll();
    const kw = opts.keyword?.trim().toLowerCase() ?? '';
    const plat = opts.platform?.trim() || undefined;
    const res = snapshot.persons.filter(p => {
      if (plat && p.platform !== plat) return false;
      if (!kw) return true;
      const hay = `${p.displayName ?? ''} ${p.userId} ${p.id}`.toLowerCase();
      return hay.includes(kw);
    });
    // 排序：按 lastMentionedAt 降序；缺失则按 lastSeenAt 兜底
    res.sort((a, b) => (b.lastMentionedAt ?? b.lastSeenAt ?? 0) - (a.lastMentionedAt ?? a.lastSeenAt ?? 0));
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
    return res.slice(0, limit);
  }

  /**
   * 按关键词搜索实体。匹配 name / aliases / summary / id（substring，不区分大小写）。
   * - kind：可选，仅返回指定 entityKind
   * - limit：返回上限（默认 20）
   */
  async searchEntities(opts: {
    keyword?: string;
    kind?: EntityNode['entityKind'];
    limit?: number;
  }): Promise<EntityNode[]> {
    const snapshot = await this.store.loadAll();
    const kw = opts.keyword?.trim().toLowerCase() ?? '';
    const res = snapshot.entities.filter(e => {
      if (opts.kind && e.entityKind !== opts.kind) return false;
      if (!kw) return true;
      const hay = `${e.name} ${(e.aliases ?? []).join(' ')} ${e.summary ?? ''} ${e.id}`.toLowerCase();
      return hay.includes(kw);
    });
    res.sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt);
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
    return res.slice(0, limit);
  }

  /**
   * 列出符合过滤条件的边。所有过滤器是 AND 关系；不传任何过滤器 = 返回全部（受 limit 限制）。
   * - kinds：边大类（person-event / person-person / person-entity / event-event / event-entity / entity-entity）
   * - relationTypes：仅对带 relationType 的边生效（person-person / event-event / event-entity / entity-entity）
   * - roles：仅对带 role 的边生效（person-event / person-entity）
   * - nodeId：边的任一端等于该 id（用于"这条边和某节点相关"）
   * - fromId/toId：方向敏感（注意无向边的 from/to 由 LLM 提取时给定，未必符合直觉）
   * - days：仅返回 lastReinforcedAt 在 N 天内的；0/未传 → 不限
   * - limit：返回上限（默认 50）
   * 按 lastReinforcedAt 降序。
   */
  async listEdges(opts: {
    kinds?: RelationEdge['kind'][];
    relationTypes?: string[];
    roles?: string[];
    nodeId?: string;
    fromId?: string;
    toId?: string;
    days?: number;
    limit?: number;
  }): Promise<RelationEdge[]> {
    const snapshot = await this.store.loadAll();
    const cutoff = opts.days && opts.days > 0 ? Date.now() - opts.days * 86400_000 : 0;
    const kindSet = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : undefined;
    const relSet = opts.relationTypes && opts.relationTypes.length > 0 ? new Set(opts.relationTypes) : undefined;
    const roleSet = opts.roles && opts.roles.length > 0 ? new Set(opts.roles) : undefined;
    const edgeEnds = (e: RelationEdge): { from: string; to: string } => {
      if (e.kind === 'person-event') return { from: e.fromPersonId, to: e.toEventId };
      if (e.kind === 'person-entity') return { from: e.fromPersonId, to: e.toEntityId };
      if (e.kind === 'event-event') return { from: e.fromEventId, to: e.toEventId };
      if (e.kind === 'event-entity') return { from: e.fromEventId, to: e.toEntityId };
      if (e.kind === 'entity-entity') return { from: e.fromEntityId, to: e.toEntityId };
      return { from: e.fromPersonId, to: e.toPersonId };
    };
    const res = snapshot.edges.filter(e => {
      if (kindSet && !kindSet.has(e.kind)) return false;
      if (e.lastReinforcedAt < cutoff) return false;
      const { from, to } = edgeEnds(e);
      if (opts.nodeId && from !== opts.nodeId && to !== opts.nodeId) return false;
      if (opts.fromId && from !== opts.fromId) return false;
      if (opts.toId && to !== opts.toId) return false;
      if (relSet) {
        if (e.kind === 'person-event' || e.kind === 'person-entity') return false;
        if (!relSet.has(e.relationType)) return false;
      }
      if (roleSet) {
        if (e.kind !== 'person-event' && e.kind !== 'person-entity') return false;
        if (!roleSet.has(e.role)) return false;
      }
      return true;
    });
    res.sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt);
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
    return res.slice(0, limit);
  }

  /**
   * 时间线：给定节点，返回与其相关的事件按时间倒序排列。
   * - 节点是 person → 返回该人参与的事件（按 personEvent.lastReinforcedAt 降序）
   * - 节点是 entity → 返回涉及该实体的事件（按 eventEntity.lastReinforcedAt 降序）
   * - 节点是 event → 返回该事件 + 由 event-event 边相连的相关事件
   * 返回每个事件附带触达它的边信息（用于追溯"为什么相关"）。
   */
  async getTimeline(opts: {
    nodeId: string;
    days?: number;
    limit?: number;
  }): Promise<Array<{ event: EventNode; viaEdge: RelationEdge }>> {
    const snapshot = await this.store.loadAll();
    const eventById = new Map(snapshot.events.map(e => [e.id, e]));
    const cutoff = opts.days && opts.days > 0 ? Date.now() - opts.days * 86400_000 : 0;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 30;
    const collected: Array<{ event: EventNode; viaEdge: RelationEdge }> = [];
    const seen = new Set<string>();
    for (const e of snapshot.edges) {
      let evId: string | undefined;
      if (e.kind === 'person-event' && e.fromPersonId === opts.nodeId) evId = e.toEventId;
      else if (e.kind === 'event-entity' && e.toEntityId === opts.nodeId) evId = e.fromEventId;
      else if (e.kind === 'event-event' && e.fromEventId === opts.nodeId) evId = e.toEventId;
      else if (e.kind === 'event-event' && !e.directed && e.toEventId === opts.nodeId) evId = e.fromEventId;
      if (!evId) continue;
      if (seen.has(evId)) continue;
      const ev = eventById.get(evId);
      if (!ev) continue;
      if (ev.lastReinforcedAt < cutoff) continue;
      seen.add(evId);
      collected.push({ event: ev, viaEdge: e });
    }
    collected.sort((a, b) => b.event.lastReinforcedAt - a.event.lastReinforcedAt);
    return collected.slice(0, limit);
  }

  // 1) 别名候选发现：人物 displayName 与 实体 name/aliases 的高相似对，给出候选
  //    （不自动合并，只输出报告供用户决定；若 confidence 极高且开启 autoLink，则建 is-alias-of 边）
  // 2) 自动 part-of：实体 name 出现在事件 title 中 → 建 event-entity[relationType=part-of]
  // 3) PersonEventEdge 去重：按现行 addPersonEventEdge 吸收规则重排（修旧账）
  // 4) 报告：返回结构化结果，调用方按需展示
  // ────────────────────────────────────────────────────────────────
  async consolidate(
    opts: {
      autoLink?: boolean;
      /** 可选：传入后 consolidate 末尾会调用 LLM 做别名核验与摘要重写 */
      llm?: { ctx: Context; modelRef: ModelRef; disableThinking?: boolean };
      /** 调用来源标识，仅用于 getLastConsolidateInfo() 报告。默认 api。 */
      triggerSource?: 'manual' | 'eviction' | 'api';
      /**
       * 可选 ctx。若传入则 consolidate 会顺带做一次「伪 person 自动清理」：
       * platform 不在 `getPlatformNames(ctx)` 运行时白名单内（或 userId 命中
       * 通用占位 self/me/bot/assistant）的 person，连同级联边一起删除。
       * 与写入守卫 `isPlaceholderSelfPersonId` 共用同一谓词，口径一致。
       *
       * 警告：临时禁用了某个 adapter 时（白名单收缩），这里会把对应平台的
       * **真实历史 person** 误判为 fake。`getPlatformNames(ctx)` 为空时本步骤
       * 自动跳过以保护历史数据。
       */
      ctx?: Context;
    } = {},
  ): Promise<{
    aliasCandidates: Array<{
      aId: string;
      bId: string;
      aKind: 'person' | 'entity';
      bKind: 'person' | 'entity';
      reason: string;
    }>;
    aliasEdgesCreated: number;
    partOfEdgesCreated: number;
    eventEdgesNormalized: number;
    entityHierarchyCandidates: number;
    entityHierarchyEdgesCreated: number;
    llmVerified?: number;
    llmRejected?: number;
    summariesRewritten?: number;
    lateralParentCandidates: number;
    lateralParentsCreated: number;
    lateralEdgesCreated: number;
    /** 自动清理删掉的伪 person 数（platform 不在白名单或 userId 为通用占位）。 */
    fakePersonsDeleted: number;
    /** 自动清理时级联删的 person-* 边总数。 */
    fakePersonEdgesDeleted: number;
  }> {
    // ─── (0) 伪 person 自动清理：与 extractor 落库守卫共用同一谓词。
    //   仅在 opts.ctx 传入且 `getPlatformNames(ctx)` 非空时启用 platform-whitelist
    //   分支；否则只兜底过滤 userId 通用占位（self/me/bot/assistant）。
    //   先做此步，再 loadAll，避免后续 alias / 层级推断把 fake person 牵连进去。
    let fakePersonsDeleted = 0;
    let fakePersonEdgesDeleted = 0;
    {
      const preSnap = await this.store.loadAll();
      const knownPlatforms = opts.ctx ? getKnownPlatformsLower(opts.ctx) : new Set<string>();
      const fakes = preSnap.persons.filter(p => isPlaceholderSelfPersonId(p.platform, p.userId, knownPlatforms));
      for (const p of fakes) {
        const r = await this.store.deletePersonCascade(p.platform, p.userId);
        fakePersonsDeleted++;
        fakePersonEdgesDeleted += r.deletedEdges;
      }
      if (fakes.length > 0 && opts.llm?.ctx?.logger) {
        opts.llm.ctx.logger.info(
          `[user-relation] consolidate 清理伪 person ${fakes.length} 个 / 级联边 ${fakePersonEdgesDeleted} 条`,
        );
      }
    }

    const snapshot = await this.store.loadAll();
    const aliasCandidates: Array<{
      aId: string;
      bId: string;
      aKind: 'person' | 'entity';
      bKind: 'person' | 'entity';
      reason: string;
    }> = [];
    let aliasEdgesCreated = 0;
    let partOfEdgesCreated = 0;
    let eventEdgesNormalized = 0;
    let entityHierarchyCandidates = 0;
    let entityHierarchyEdgesCreated = 0;
    let llmVerified = 0;
    let llmRejected = 0;
    let summariesRewritten = 0;

    // 解析可选 LLM 模型（A: 别名核验；B: 合并后摘要重写）
    const llmModel = opts.llm ? resolveConsolidateModel(opts.llm.ctx, { modelRef: opts.llm.modelRef }) : undefined;
    const llmDisableThinking = opts.llm?.disableThinking ?? true;
    /** 待合并实体 id → 经过 LLM 确认（或未启用 LLM 时直接 true）的列表 */
    const mergedCanonicals = new Set<string>();

    // ─── (1) 别名候选：实体之间 name/aliases 完全相同（不同 id）→ 高置信
    const entitiesByNormName = new Map<string, EntityNode[]>();
    for (const e of snapshot.entities) {
      const all = [e.name, ...(e.aliases ?? [])].map(normalizeName).filter(Boolean);
      for (const n of all) {
        if (!entitiesByNormName.has(n)) entitiesByNormName.set(n, []);
        entitiesByNormName.get(n)!.push(e);
      }
    }
    const reportedEntityPairs = new Set<string>();
    for (const [norm, list] of entitiesByNormName.entries()) {
      if (list.length < 2) continue;
      // 同 norm 多个实体 → 两两为候选
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (a.id === b.id) continue;
          const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (reportedEntityPairs.has(k)) continue;
          reportedEntityPairs.add(k);
          aliasCandidates.push({
            aId: a.id,
            bId: b.id,
            aKind: 'entity',
            bKind: 'entity',
            reason: `name/aliases 完全等价于 "${norm}"`,
          });
          if (opts.autoLink) {
            // (A) LLM 语义核验：仅当传入了 llm 才执行；未启用则按算法直通
            let shouldMerge = true;
            if (llmModel && opts.llm) {
              const v = await verifyAliasPair(opts.llm.ctx, llmModel, a, b, llmDisableThinking);
              if (v.isSame) {
                llmVerified++;
              } else {
                llmRejected++;
                shouldMerge = false;
                if (opts.llm.ctx.logger) {
                  opts.llm.ctx.logger.info(`[user-relation] consolidate LLM 否决合并 ${a.id} ↔ ${b.id}: ${v.reason}`);
                }
              }
            }
            if (!shouldMerge) continue;
            const exists = snapshot.edges.some(
              e =>
                e.kind === 'entity-entity' &&
                e.relationType === 'is-alias-of' &&
                ((e.fromEntityId === a.id && e.toEntityId === b.id) ||
                  (e.fromEntityId === b.id && e.toEntityId === a.id)),
            );
            if (!exists) {
              const now = Date.now();
              await this.store.upsertEdge({
                id: globalThis.crypto.randomUUID(),
                kind: 'entity-entity',
                fromEntityId: a.id,
                toEntityId: b.id,
                relationType: 'is-alias-of',
                directed: true,
                weight: 0.8,
                description: 'consolidate 自动识别：名称/别名等价',
                firstSeenAt: now,
                lastReinforcedAt: now,
                evidence: [],
              });
              aliasEdgesCreated++;
              // 立即触发合并（A 方案：路由+壳子）
              const mergeResult = await this.mergeAlias({ aliasId: a.id, canonicalId: b.id, kind: 'entity' });
              mergedCanonicals.add(mergeResult.effectiveCanonicalId);
            }
          }
        }
      }
    }

    // ─── (1.5) 别名候选「宽召回」：仅当启用 LLM 时执行
    //   目的：让 LLM 看到「绝航」vs「绝航号」、「绝航」vs「Project Juehang」等
    //         normalize 后不严格相等、但语义上可能同一对象的候选对。
    //   召回路径（同 entityKind 内）：
    //     (a) name 子串包含（短名 ⊂ 长名，且短名长度 ≥ 2）
    //     (b) 一方的某个 alias 与另一方的 name 归一相等
    //   严判：交给 verifyAliasPair LLM，否决就不合并。
    //   未启用 LLM 时跳过本段（保持原算法的零误合并保证）。
    if (opts.autoLink && llmModel && opts.llm) {
      const entitiesByKind = new Map<string, EntityNode[]>();
      for (const e of snapshot.entities) {
        const k = e.entityKind ?? 'topic';
        if (!entitiesByKind.has(k)) entitiesByKind.set(k, []);
        entitiesByKind.get(k)!.push(e);
      }
      for (const list of entitiesByKind.values()) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
            if (reportedEntityPairs.has(k)) continue;

            const an = normalizeName(a.name);
            const bn = normalizeName(b.name);
            if (!an || !bn) continue;
            const aAliasNorms = (a.aliases ?? []).map(normalizeName).filter(Boolean);
            const bAliasNorms = (b.aliases ?? []).map(normalizeName).filter(Boolean);

            // (a) 子串包含
            const minSubstrLen = 2;
            const substring =
              (an.length >= minSubstrLen && bn.includes(an)) || (bn.length >= minSubstrLen && an.includes(bn));
            // (b) 别名/名互覆盖
            const aliasCover =
              aAliasNorms.includes(bn) || bAliasNorms.includes(an) || aAliasNorms.some(x => bAliasNorms.includes(x));

            if (!substring && !aliasCover) continue;
            reportedEntityPairs.add(k);

            const reason = substring ? `名称子串包含：${a.name} ↔ ${b.name}` : `别名/名互覆盖：${a.name} ↔ ${b.name}`;
            aliasCandidates.push({ aId: a.id, bId: b.id, aKind: 'entity', bKind: 'entity', reason });

            const v = await verifyAliasPair(opts.llm.ctx, llmModel, a, b, llmDisableThinking);
            if (!v.isSame) {
              llmRejected++;
              if (opts.llm.ctx.logger) {
                opts.llm.ctx.logger.info(
                  `[user-relation] consolidate LLM 否决合并（宽召回）${a.id} ↔ ${b.id}: ${v.reason}`,
                );
              }
              continue;
            }
            llmVerified++;
            const exists = snapshot.edges.some(
              e =>
                e.kind === 'entity-entity' &&
                e.relationType === 'is-alias-of' &&
                ((e.fromEntityId === a.id && e.toEntityId === b.id) ||
                  (e.fromEntityId === b.id && e.toEntityId === a.id)),
            );
            if (!exists) {
              const now = Date.now();
              await this.store.upsertEdge({
                id: globalThis.crypto.randomUUID(),
                kind: 'entity-entity',
                fromEntityId: a.id,
                toEntityId: b.id,
                relationType: 'is-alias-of',
                directed: true,
                weight: 0.7,
                description: `consolidate LLM 确认：${reason}`,
                firstSeenAt: now,
                lastReinforcedAt: now,
                evidence: [],
              });
              aliasEdgesCreated++;
              const mergeResult = await this.mergeAlias({ aliasId: a.id, canonicalId: b.id, kind: 'entity' });
              mergedCanonicals.add(mergeResult.effectiveCanonicalId);
            }
          }
        }
      }
    }

    // ─── (2) 自动 part-of：实体 name 是事件 title 子串（强化版）
    //   规则演进（防误锚 "绝航" ⊂ "绝航刀皮"）：
    //   (a) kind 偏置：仅 work / place / thing 参与（topic/泛人物概念易撞名）
    //   (b) 最短长度 2，覆盖 "原神" "PS5" "BWS" 等真实短名
    //   (c) 最长候选优先：同一 event 命中多个 entity 时，
    //         若 entity A 的归一化名是 entity B 的归一化名的子串 → 剔除 A，
    //         避免 "绝航" 在已有 "绝航刀皮" 实体时被同时锚定
    //   (d) part-of 链祖先剔除：若 candidate 之间已有 entity-entity[part-of] 链
    //         传递关系，剔除上游（最深子已经能通过 hierarchy 传递语义到父）
    //   （中文无 word boundary，靠 (c)(d) 双策略而非字符级边界判断 ——
    //    若临时缺更深子实体导致父被误锚，待 extractor 抽到子实体并建好
    //    entity-entity 链后，下一轮 consolidate 会自动修正。）
    const minNameLen = 2;
    const allowedKinds: ReadonlySet<string> = new Set(['work', 'place', 'thing']);

    // 预构建 entity-entity[part-of] 祖先映射（child → set<ancestor>）
    const partOfAncestors = new Map<string, Set<string>>();
    {
      const directParents = new Map<string, Set<string>>();
      for (const e of snapshot.edges) {
        if (e.kind === 'entity-entity' && e.relationType === 'part-of') {
          if (!directParents.has(e.fromEntityId)) directParents.set(e.fromEntityId, new Set());
          directParents.get(e.fromEntityId)!.add(e.toEntityId);
        }
      }
      const walk = (id: string, acc: Set<string>, depth: number): void => {
        if (depth > 8) return;
        for (const p of directParents.get(id) ?? []) {
          if (acc.has(p)) continue;
          acc.add(p);
          walk(p, acc, depth + 1);
        }
      };
      for (const child of directParents.keys()) {
        const acc = new Set<string>();
        walk(child, acc, 0);
        partOfAncestors.set(child, acc);
      }
    }

    // 第一遍：收集每个 event 的「candidate entity 列表」
    const eventCandidates = new Map<string, EntityNode[]>();
    for (const ent of snapshot.entities) {
      const nm = ent.name.trim();
      if (nm.length < minNameLen) continue;
      if (!allowedKinds.has(ent.entityKind)) continue;
      for (const ev of snapshot.events) {
        if (!ev.title.includes(nm)) continue;
        if (!eventCandidates.has(ev.id)) eventCandidates.set(ev.id, []);
        eventCandidates.get(ev.id)!.push(ent);
      }
    }

    // 第二遍：应用「最长候选优先 + 祖先剔除」
    for (const [eventId, candidates] of eventCandidates.entries()) {
      const ev = snapshot.events.find(e => e.id === eventId);
      if (!ev) continue;
      const dropIds = new Set<string>();
      // 规则 (c)：A.name ⊊ B.name → 剔除 A
      for (const a of candidates) {
        for (const b of candidates) {
          if (a.id === b.id) continue;
          const an = a.name.trim();
          const bn = b.name.trim();
          if (an.length < bn.length && bn.includes(an)) {
            dropIds.add(a.id);
          }
        }
      }
      // 规则 (d)：candidate 间的祖先剔除
      for (const c of candidates) {
        const anc = partOfAncestors.get(c.id);
        if (!anc) continue;
        for (const a of anc) {
          if (candidates.some(x => x.id === a)) dropIds.add(a);
        }
      }
      const finalists = candidates.filter(c => !dropIds.has(c.id));
      for (const ent of finalists) {
        const exists = snapshot.edges.some(
          e => e.kind === 'event-entity' && e.fromEventId === ev.id && e.toEntityId === ent.id,
        );
        if (exists) continue;
        const now = Date.now();
        await this.store.upsertEdge({
          id: globalThis.crypto.randomUUID(),
          kind: 'event-entity',
          fromEventId: ev.id,
          toEntityId: ent.id,
          relationType: 'part-of',
          directed: true,
          weight: 0.6,
          description: `consolidate 自动识别：事件标题包含实体名 "${ent.name.trim()}"`,
          firstSeenAt: now,
          lastReinforcedAt: now,
          evidence: [],
        });
        partOfEdgesCreated++;
      }
    }

    // ─── (3) PersonEventEdge 旧账整理：对每对 (person,event) 跑一次吸收规则
    const pairs = new Map<string, PersonEventEdge[]>();
    for (const e of snapshot.edges) {
      if (e.kind !== 'person-event') continue;
      const k = `${e.fromPersonId}|${e.toEventId}`;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k)!.push(e);
    }
    for (const [, list] of pairs.entries()) {
      if (list.length < 2) continue;
      // 选 evidence 最多 / weight 最高的作为"代表"，调用 addPersonEventEdge 触发合并
      const rep = list.reduce((a, b) => (b.evidence.length > a.evidence.length || b.weight > a.weight ? b : a));
      // 删掉所有现有，再用最高 rank 的 role 写回，触发吸收
      for (const e of list) {
        if (e.id !== rep.id) await this.store.deleteEdge(e.id);
      }
      // 触发一次 add（input.role 取 rep.role），让逻辑重整
      await this.addPersonEventEdge({
        fromPersonId: rep.fromPersonId,
        toEventId: rep.toEventId,
        role: rep.role,
        sentiment: rep.sentiment,
        weight: rep.weight,
        description: rep.description,
        evidence: rep.evidence,
      });
      eventEdgesNormalized++;
    }

    // ─── (3b) PersonEntityEdge 旧账整理：同一 (person,entity) 多条不同 role 行 → 留最强 role
    //    旧版插入逻辑可能未做 (from,to) 级别去重；此处按当前 addPersonEntityEdge 规则修旧账。
    const peEntityPairs = new Map<string, PersonEntityEdge[]>();
    for (const e of snapshot.edges) {
      if (e.kind !== 'person-entity') continue;
      const k = `${e.fromPersonId}|${e.toEntityId}`;
      if (!peEntityPairs.has(k)) peEntityPairs.set(k, []);
      peEntityPairs.get(k)!.push(e);
    }
    for (const [, list] of peEntityPairs.entries()) {
      if (list.length < 2) continue;
      // 选 evidence 最多 / weight 最高的作为"代表"，调用 addPersonEntityEdge 触发"保留最强 role"逻辑
      const rep = list.reduce((a, b) => (b.evidence.length > a.evidence.length || b.weight > a.weight ? b : a));
      for (const e of list) {
        if (e.id !== rep.id) await this.store.deleteEdge(e.id);
      }
      await this.addPersonEntityEdge({
        fromPersonId: rep.fromPersonId,
        toEntityId: rep.toEntityId,
        role: rep.role,
        sentiment: rep.sentiment,
        weight: rep.weight,
        description: rep.description,
        evidence: rep.evidence,
      });
      // 进一步：吸收同对、weaker role 的"残留"——遍历 list 中除 rep 之外的 role，逐条 add 触发吸收
      for (const e of list) {
        if (e.id === rep.id) continue;
        await this.addPersonEntityEdge({
          fromPersonId: e.fromPersonId,
          toEntityId: e.toEntityId,
          role: e.role,
          sentiment: e.sentiment,
          weight: e.weight,
          description: e.description,
          evidence: e.evidence,
        });
      }
      eventEdgesNormalized++; // 共用计数（含人-实体折叠）
    }

    // ─── (3c) EventEntityEdge 旧账整理：同一 (event,entity) 若有 about + 非 about 并存 → 驱逐 about
    //   语义：about = "顺带提及"，是所有 relationType 中最弱的标注。
    //   规则：
    //     · 若同一 (event,entity) 存在任何非 about 边 → 删除全部 about 边，evidence 合并到权重最高的非 about 边。
    //     · 非 about 边之间（part-of / related / involves 等）可以共存，不做折叠。
    //     · 若全为 about → 只保留 weight 最高的一条，合并 evidence。
    const eePairs = new Map<string, EventEntityEdge[]>();
    for (const e of snapshot.edges) {
      if (e.kind !== 'event-entity') continue;
      const k = `${e.fromEventId}|${e.toEntityId}`;
      if (!eePairs.has(k)) eePairs.set(k, []);
      eePairs.get(k)!.push(e);
    }
    for (const [, list] of eePairs.entries()) {
      if (list.length < 2) continue;
      const nonAbout = list.filter(e => e.relationType !== 'about');
      const aboutEdges = list.filter(e => e.relationType === 'about');

      if (nonAbout.length > 0 && aboutEdges.length > 0) {
        // 有非 about → about 全部被驱逐，evidence 合并到权重最高的非 about 边
        const target = nonAbout.reduce((a, b) => ((b.weight ?? 0) > (a.weight ?? 0) ? b : a));
        const seenMsgKey = new Set<string>(
          target.evidence.map(ev => `${ev.sessionId}|${[...(ev.messageIds ?? [])].sort().join(',')}`),
        );
        const extraEvidence: EvidenceRef[] = [];
        for (const ab of aboutEdges) {
          for (const ev of ab.evidence ?? []) {
            const mk = `${ev.sessionId}|${[...(ev.messageIds ?? [])].sort().join(',')}`;
            if (!seenMsgKey.has(mk)) {
              seenMsgKey.add(mk);
              extraEvidence.push(ev);
            }
          }
          await this.store.deleteEdge(ab.id);
        }
        if (extraEvidence.length > 0) {
          await this.store.upsertEdge({
            ...target,
            evidence: trimEvidence([...extraEvidence, ...target.evidence]),
            lastReinforcedAt: Date.now(),
          });
        }
        eventEdgesNormalized++;
      } else if (nonAbout.length === 0 && aboutEdges.length > 1) {
        // 全为 about → 保留 weight 最高的一条，合并 evidence
        const sorted = [...aboutEdges].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
        const keep = sorted[0];
        const mergedEvidence = [...keep.evidence];
        const seenMsgKey = new Set<string>(
          mergedEvidence.map(ev => `${ev.sessionId}|${[...(ev.messageIds ?? [])].sort().join(',')}`),
        );
        let maxWeight = keep.weight ?? 0;
        for (const dup of sorted.slice(1)) {
          for (const ev of dup.evidence ?? []) {
            const mk = `${ev.sessionId}|${[...(ev.messageIds ?? [])].sort().join(',')}`;
            if (!seenMsgKey.has(mk)) {
              seenMsgKey.add(mk);
              mergedEvidence.push(ev);
            }
          }
          if ((dup.weight ?? 0) > maxWeight) maxWeight = dup.weight ?? 0;
          await this.store.deleteEdge(dup.id);
        }
        if (mergedEvidence.length !== keep.evidence.length || maxWeight !== keep.weight) {
          await this.store.upsertEdge({
            ...keep,
            evidence: mergedEvidence,
            weight: maxWeight,
            lastReinforcedAt: Date.now(),
          });
        }
        eventEdgesNormalized++;
      }
      // nonAbout.length > 1 && aboutEdges.length === 0：多条非 about → 全部保留，无需处理
    }

    // (B) 合并后摘要重写：基于最新 snapshot 收集 canonical 的别名/相关事件/相关人物
    if (llmModel && opts.llm && mergedCanonicals.size > 0) {
      const after = await this.store.loadAll();
      const entityById = new Map(after.entities.map(e => [e.id, e]));
      const personById = new Map(after.persons.map(p => [p.id, p]));
      const eventById = new Map(after.events.map(e => [e.id, e]));
      for (const canonicalId of mergedCanonicals) {
        const ent = entityById.get(canonicalId);
        if (!ent) continue;
        // 收集别名（含 is-alias-of 关联实体的 name 与 aliases）
        const aliasSet = new Set<string>(ent.aliases ?? []);
        for (const e of after.edges) {
          if (e.kind === 'entity-entity' && e.relationType === 'is-alias-of') {
            const other =
              e.fromEntityId === canonicalId
                ? entityById.get(e.toEntityId)
                : e.toEntityId === canonicalId
                  ? entityById.get(e.fromEntityId)
                  : undefined;
            if (other) {
              aliasSet.add(other.name);
              for (const al of other.aliases ?? []) aliasSet.add(al);
            }
          }
        }
        // 收集近期相关事件（通过 event-entity 边）
        const recentEvents: Array<Pick<EventNode, 'title' | 'summary'>> = [];
        for (const e of after.edges) {
          if (e.kind === 'event-entity' && e.toEntityId === canonicalId) {
            const ev = eventById.get(e.fromEventId);
            if (ev) recentEvents.push({ title: ev.title, summary: ev.summary });
          }
        }
        recentEvents.sort((a, b) => (b.summary ? 1 : 0) - (a.summary ? 1 : 0));
        // 相关人物（通过 person-entity 边）
        const relatedPersons: Array<Pick<PersonNode, 'displayName'>> = [];
        for (const e of after.edges) {
          if (e.kind === 'person-entity' && e.toEntityId === canonicalId) {
            const p = personById.get(e.fromPersonId);
            if (p?.displayName) relatedPersons.push({ displayName: p.displayName });
          }
        }
        const newSummary = await rewriteEntitySummary(
          opts.llm.ctx,
          llmModel,
          ent,
          {
            aliases: [...aliasSet].filter(a => a && a !== ent.name).slice(0, 10),
            recentEvents: recentEvents.slice(0, 6),
            relatedPersons: relatedPersons.slice(0, 8),
          },
          llmDisableThinking,
        );
        if (newSummary && newSummary !== ent.summary) {
          await this.store.upsertEntity({ ...ent, summary: newSummary, lastReinforcedAt: Date.now() });
          summariesRewritten++;
        }
      }
    }

    // ─── (3d) 实体层级推断：名称包含关系 → 候选 entity-entity[part-of] 边
    //   规则：normName(A) 是 normName(B) 的真子串，A.length >= 3，B > A → A 是 B 的父实体候选。
    //   无 LLM 时（autoLink=true）：仅当 B.name 以 A.name 精确开头，直接建边（高置信启发式）。
    //   有 LLM 时：批量发给 inferEntityHierarchy 核验后建边。
    //   autoLink=false：收集候选但不建边。
    {
      const afterSnapshot = await this.store.loadAll();
      const hierarchyCandidates: Array<{ parent: EntityNode; child: EntityNode }> = [];
      const existingHierarchyKeys = new Set<string>();
      for (const e of afterSnapshot.edges) {
        if (e.kind === 'entity-entity') existingHierarchyKeys.add(`${e.fromEntityId}>${e.toEntityId}`);
      }
      for (const parentEnt of afterSnapshot.entities) {
        const normParent = normalizeName(parentEnt.name);
        if (normParent.length < 3) continue; // 太短的名字不做父实体（防误判）
        for (const childEnt of afterSnapshot.entities) {
          if (parentEnt.id === childEnt.id) continue;
          const normChild = normalizeName(childEnt.name);
          if (normChild.length <= normParent.length) continue; // child 必须比 parent 更长
          if (!normChild.includes(normParent)) continue;
          // 已有任意方向的 entity-entity 边则跳过（含 is-alias-of / part-of 等）
          if (
            existingHierarchyKeys.has(`${childEnt.id}>${parentEnt.id}`) ||
            existingHierarchyKeys.has(`${parentEnt.id}>${childEnt.id}`)
          )
            continue;
          hierarchyCandidates.push({ parent: parentEnt, child: childEnt });
        }
      }
      entityHierarchyCandidates = hierarchyCandidates.length;

      if (hierarchyCandidates.length > 0) {
        const toCreate: Array<{ parentId: string; childId: string }> = [];

        if (llmModel && opts.llm) {
          // LLM 核验：批量确认
          const llmCtx = opts.llm.ctx;
          const results = await inferEntityHierarchy(llmCtx, llmModel, hierarchyCandidates, llmDisableThinking);
          for (const r of results) {
            if (r.confirmed) toCreate.push({ parentId: r.parentId, childId: r.childId });
          }
        } else if (opts.autoLink) {
          // 无 LLM + autoLink：保守启发式 — child.name 精确以 parent.name 开头（字符串级别）
          for (const c of hierarchyCandidates) {
            const normP = normalizeName(c.parent.name);
            const normC = normalizeName(c.child.name);
            if (normC.startsWith(normP)) toCreate.push({ parentId: c.parent.id, childId: c.child.id });
          }
        }

        for (const { parentId, childId } of toCreate) {
          await this.addEntityEntityEdge({
            fromEntityId: childId,
            toEntityId: parentId,
            relationType: 'part-of',
            directed: true,
            weight: 0.7,
            evidence: [],
          });
          entityHierarchyEdgesCreated++;
        }
      }
    }

    // ─── (3e) 兄弟实体 → 共同父实体「侧向推断」（仅 LLM 启用时执行）
    //   场景：同 kind 下 ≥2 个实体名共享前缀 ≥3 字（如「三角洲行动刀皮」+「三角洲行动绝密航天」），
    //   但父实体「三角洲行动」尚未作为节点存在 → (3d) 找不到候选。
    //   流程：
    //     1) 同 kind 内按 name 排序，贪心聚类：相邻 LCP ≥3 字 → 同簇；
    //     2) 跳过已有任意 entity-entity[part-of] 出边的成员（不重复挂父）；
    //     3) 跳过 LCP 已作为同 kind 实体存在的簇（让 (3d) 处理）；
    //     4) 发给 LLM inferMissingParent 核验「父名是否有意义」；
    //     5) accept → 新建父实体（可用 LLM 修正名），并为每个兄弟建 entity-entity[part-of] 边。
    //   未启用 LLM → 不创建（避免误造实体节点），但记录候选数到 lateralParentCandidates。
    let lateralParentCandidates = 0;
    let lateralParentsCreated = 0;
    let lateralEdgesCreated = 0;
    if (opts.autoLink) {
      const minLcpLen = 3;
      const afterSnap = await this.store.loadAll();
      // 已经有 entity-entity[part-of] 出边的子实体 id 集合
      const hasParent = new Set<string>();
      for (const e of afterSnap.edges) {
        if (e.kind === 'entity-entity' && e.relationType === 'part-of') {
          hasParent.add(e.fromEntityId);
        }
      }
      const byKind = new Map<string, EntityNode[]>();
      for (const e of afterSnap.entities) {
        if (hasParent.has(e.id)) continue;
        const k = e.entityKind ?? 'topic';
        if (!byKind.has(k)) byKind.set(k, []);
        byKind.get(k)!.push(e);
      }
      type Cluster = { lcp: string; members: EntityNode[] };
      const clusters: Array<{ kind: string; cluster: Cluster }> = [];
      for (const [kind, list] of byKind.entries()) {
        if (list.length < 2) continue;
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
        let cur: Cluster = { lcp: '', members: [] };
        const flush = () => {
          if (cur.members.length >= 2 && cur.lcp.length >= minLcpLen) {
            clusters.push({ kind, cluster: { lcp: cur.lcp, members: cur.members } });
          }
        };
        for (const e of sorted) {
          if (cur.members.length === 0) {
            cur = { lcp: e.name, members: [e] };
            continue;
          }
          const newLcp = commonPrefix(cur.lcp, e.name);
          if (newLcp.length >= minLcpLen) {
            cur.members.push(e);
            cur.lcp = newLcp;
          } else {
            flush();
            cur = { lcp: e.name, members: [e] };
          }
        }
        flush();
      }
      lateralParentCandidates = clusters.length;

      if (llmModel && opts.llm) {
        for (const { kind, cluster } of clusters) {
          const entityKind = kind as EntityNode['entityKind'];
          // 父名若已作为同 kind 实体存在则跳过（交给 (3d)）
          const existingParent = await this.findEntityByKindAndName(entityKind, cluster.lcp);
          if (existingParent) continue;
          const verdict = await inferMissingParent(
            opts.llm.ctx,
            llmModel,
            { parentName: cluster.lcp, kind, siblings: cluster.members },
            llmDisableThinking,
          );
          if (!verdict.accept) {
            if (opts.llm.ctx.logger) {
              opts.llm.ctx.logger.info(
                `[user-relation] consolidate LLM 否决侧向父实体「${cluster.lcp}」(${kind}): ${verdict.reason}`,
              );
            }
            continue;
          }
          const finalName = verdict.suggestedName ?? cluster.lcp;
          // 再次按 finalName 检查（LLM 可能修正成已有名）
          const dup = await this.findEntityByKindAndName(entityKind, finalName);
          const parentEntity =
            dup ??
            (await this.createEntity({
              name: finalName,
              entityKind,
              evidence: [],
              summary: `consolidate 侧向推断：根据 ${cluster.members.length} 个子实体共同前缀建立。`,
            }));
          if (!dup) lateralParentsCreated++;
          for (const child of cluster.members) {
            if (child.id === parentEntity.id) continue;
            await this.addEntityEntityEdge({
              fromEntityId: child.id,
              toEntityId: parentEntity.id,
              relationType: 'part-of',
              directed: true,
              weight: 0.7,
              evidence: [],
            });
            lateralEdgesCreated++;
          }
        }
      }
    }

    const consolidateResult = {
      aliasCandidates,
      aliasEdgesCreated,
      partOfEdgesCreated,
      eventEdgesNormalized,
      entityHierarchyCandidates,
      entityHierarchyEdgesCreated,
      lateralParentCandidates,
      lateralParentsCreated,
      lateralEdgesCreated,
      fakePersonsDeleted,
      fakePersonEdgesDeleted,
      ...(opts.llm ? { llmVerified, llmRejected, summariesRewritten } : {}),
    };
    this._lastConsolidateAt = Date.now();
    this._lastConsolidateTrigger = opts.triggerSource ?? 'api';
    this._lastConsolidateResultSummary =
      `别名候选 ${aliasCandidates.length}，建别名边 ${aliasEdgesCreated}，part-of ${partOfEdgesCreated}，` +
      `事件边整理 ${eventEdgesNormalized}，实体层级候选 ${entityHierarchyCandidates}，层级边 ${entityHierarchyEdgesCreated}` +
      `，侧向父候选 ${lateralParentCandidates}，新建父 ${lateralParentsCreated}，侧向边 ${lateralEdgesCreated}` +
      (fakePersonsDeleted > 0 ? `，伪 person 清理 ${fakePersonsDeleted}（级联边 ${fakePersonEdgesDeleted}）` : '') +
      (opts.llm ? `，LLM 通过 ${llmVerified} 否决 ${llmRejected} 摘要重写 ${summariesRewritten}` : '');
    return consolidateResult;
  }

  // ============================================================
  //  renameNode —— 仅允许 Event / Entity 改名
  //    - Person.name = platform displayName，禁改（不在此暴露）
  //    - 旧 name/title 自动进 aliases，引用层 0 风险（key = id，非 name）
  //    - 同步追加 nameHistory 审计条目
  // ============================================================
  async renameNode(opts: {
    kind: 'event' | 'entity';
    id: string;
    newName: string;
    /** 调用来源标识：'llm' / 'manual' / 'consolidate' 等；默认 'manual' */
    by?: string;
    /** 改名理由（≤80 字），写入 audit log */
    reason?: string;
  }): Promise<{ from: string; to: string; aliasesAdded: boolean }> {
    const newName = opts.newName.trim();
    if (!newName) throw new Error('renameNode: newName 不能为空');
    if (newName.length > 80) throw new Error('renameNode: newName 过长（>80）');
    const now = Date.now();
    const by = opts.by ?? 'manual';
    const reason = opts.reason?.trim().slice(0, 80);

    if (opts.kind === 'event') {
      const node = await this.store.getEvent(opts.id);
      if (!node) throw new Error(`renameNode: event ${opts.id} 不存在`);
      const from = node.title;
      if (from === newName) return { from, to: newName, aliasesAdded: false };
      const aliases = Array.from(new Set([...(node.aliases ?? []), from]));
      const audit: NodeNameAudit = { from, to: newName, at: now, by, ...(reason ? { reason } : {}) };
      await this.store.upsertEvent({
        ...node,
        title: newName,
        aliases,
        lastReinforcedAt: now,
        nameHistory: [...(node.nameHistory ?? []), audit],
      });
      return { from, to: newName, aliasesAdded: true };
    }
    const node = await this.store.getEntity(opts.id);
    if (!node) throw new Error(`renameNode: entity ${opts.id} 不存在`);
    const from = node.name;
    if (from === newName) return { from, to: newName, aliasesAdded: false };
    const aliases = Array.from(new Set([...(node.aliases ?? []), from]));
    const audit: NodeNameAudit = { from, to: newName, at: now, by, ...(reason ? { reason } : {}) };
    await this.store.upsertEntity({
      ...node,
      name: newName,
      aliases,
      lastReinforcedAt: now,
      nameHistory: [...(node.nameHistory ?? []), audit],
    });
    return { from, to: newName, aliasesAdded: true };
  }

  // ============================================================
  //  Alias merging（方案 A：路由 + 壳子）
  //  is-alias-of / alt-account-of 边写入后立即触发：
  //    - 按启发式校正 canonical 方向（name 较长 / aliases 较多 / 总 evidence 较多）
  //    - 将所有引用 aliasId 的其它边重写为指向 canonicalId
  //    - 同 dedup key 冲突时合并 evidence/weight 并删除冗余
  //    - alias 节点保留，仅保留指向 canonical 的 alias 标记边
  // ============================================================
  async mergeAlias(opts: {
    aliasId: string;
    canonicalId: string;
    kind: 'person' | 'entity' | 'event';
    /** 若为 true，不做启发式校正，强制按传入方向 */
    noCanonicalCorrection?: boolean;
  }): Promise<{
    effectiveCanonicalId: string;
    effectiveAliasId: string;
    edgesRewritten: number;
    edgesMerged: number;
    edgesDeleted: number;
    swapped: boolean;
  }> {
    let aliasId = opts.aliasId;
    let canonicalId = opts.canonicalId;
    let swapped = false;

    if (aliasId === canonicalId) {
      return {
        effectiveCanonicalId: canonicalId,
        effectiveAliasId: aliasId,
        edgesRewritten: 0,
        edgesMerged: 0,
        edgesDeleted: 0,
        swapped,
      };
    }

    const snapshot = await this.store.loadAll();

    if (!opts.noCanonicalCorrection) {
      const corrected = chooseCanonicalDirection(snapshot, aliasId, canonicalId, opts.kind);
      if (corrected) {
        swapped = true;
        aliasId = corrected.alias;
        canonicalId = corrected.canonical;
      }
    }

    // 索引：未被 alias 引用的现有边按 dedupKey 入索引，用于冲突检测
    const byKey = new Map<string, RelationEdge>();
    for (const e of snapshot.edges) {
      if (edgeReferences(e, aliasId)) continue;
      byKey.set(edgeDedupKey(e), e);
    }

    let edgesRewritten = 0;
    let edgesMerged = 0;
    let edgesDeleted = 0;

    for (const e of snapshot.edges) {
      if (!edgeReferences(e, aliasId)) continue;

      // 保留 alias↔canonical 的 alias 标记边自身；必要时翻转方向到 alias→canonical
      if (isAliasMarkerEdge(e) && edgeInvolvesBoth(e, aliasId, canonicalId)) {
        if (!isAliasEdgeDirectionCorrect(e, aliasId, canonicalId)) {
          const flipped = flipDirectedEdge(e, aliasId, canonicalId);
          if (flipped) await this.store.upsertEdge(flipped);
        }
        continue;
      }

      const rewritten = rewriteEdgeIds(e, aliasId, canonicalId);

      // 自环禁止：合并后从 == 到 → 直接删除
      if (isEdgeSelfLoop(rewritten)) {
        await this.store.deleteEdge(e.id);
        edgesDeleted++;
        continue;
      }

      const newKey = edgeDedupKey(rewritten);
      const conflict = byKey.get(newKey);
      if (conflict && conflict.id !== rewritten.id) {
        const merged = mergeTwoEdges(conflict, rewritten);
        await this.store.upsertEdge(merged);
        await this.store.deleteEdge(e.id);
        byKey.set(newKey, merged);
        edgesMerged++;
      } else {
        await this.store.upsertEdge(rewritten);
        byKey.set(newKey, rewritten);
        edgesRewritten++;
      }
    }

    return {
      effectiveCanonicalId: canonicalId,
      effectiveAliasId: aliasId,
      edgesRewritten,
      edgesMerged,
      edgesDeleted,
      swapped,
    };
  }
}
