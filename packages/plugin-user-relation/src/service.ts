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
// type-only import：触发 declare module '@aalis/core' 合并，使 ctx.getService<'embedding'> 可用。
// 运行时通过 ctx.getService 注入，无需把 @aalis/plugin-embedding-api 列入 dependencies。
import type { EmbeddingService } from '@aalis/plugin-embedding-api';
import type { LLMModel, ModelRef } from '@aalis/plugin-llm-api';

import {
  inferEntityHierarchy,
  inferMissingParent,
  resolveConsolidateModel,
  rewriteEntitySummary,
  verifyAliasPair,
  verifyEventPair,
} from './consolidate-llm.js';
import { getKnownPlatformsLower, isPlaceholderSelfPersonId } from './extractor.js';
import type { RelationStore } from './store.js';
import type {
  CommunityMembership,
  EdgeWeightAudit,
  EntityEntityEdge,
  EntityKind,
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
  ScoreMode,
} from './types.js';

import {
  buildAdjacency,
  chooseCanonicalDirection,
  clamp01,
  clusterEntitiesByPairs,
  commonPrefix,
  computeAdaptiveResolution,
  computeEntityEdgeStats,
  computeEventEdgeStats,
  computeEventEmbeddingHash,
  computeLeiden,
  computeLouvain,
  computeModularity,
  computePageRank,
  computeSlpa,
  cosineSimilarity,
  edgeDedupKey,
  edgeInvolvesBoth,
  edgeReferences,
  effectiveWeight,
  flipDirectedEdge,
  isAliasEdgeDirectionCorrect,
  isAliasMarkerEdge,
  isDirectedEntityEntityRelation,
  isDirectedEventEventRelation,
  isEdgeSelfLoop,
  isEvidenceFullyCovered,
  jaccardChars,
  mergeTwoEdges,
  normalizeName,
  normalizeRelationType,
  PERSON_ENTITY_ROLE_RANK,
  PERSON_EVENT_ROLE_RANK,
  pickCanonicalByMergeScore,
  pickCanonicalForEvents,
  reinforceWeight,
  rewriteEdgeIds,
  roleDefaultWeight,
  trimDescription,
  trimEvidence,
  type WeightDecayCfg,
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

  constructor(
    private readonly store: RelationStore,
    /** 可选 ctx：仅用于写 logger 审计（deleteNode / mergeNodes / changeEntityKind 等 agent 写入路径）。测试不传则 fallback 到 console。 */
    private readonly ctx?: Context,
  ) {}

  /** 写 audit 日志；ctx 存在走 logger.warn，否则 fallback console.warn（主要照顾单元测试）。 */
  private _audit(msg: string): void {
    if (this.ctx) this.ctx.logger.warn(msg);
    else console.warn(msg);
  }

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

  /**
   * 同步平台 displayName 到 Person 节点：仅当节点已存在且 displayName 与传入不同时才 upsert。
   * 不创建新节点（避免水群幽灵）；不动 mentionCount / firstSeenAt / lastMentionedAt（与
   * 「显式提及」语义区分）；仅刷新 lastSeenAt。返回是否真的发生了改名。
   *
   * 调用方：rename-watcher（订阅 inbound:message:archived，从 metadata.nickname 同步）。
   */
  async syncDisplayName(platform: string, userId: string, displayName: string): Promise<boolean> {
    const existing = await this.store.getPerson(platform, userId);
    if (!existing) return false;
    if (existing.displayName === displayName) return false;
    await this.store.upsertPerson({
      ...existing,
      displayName,
      lastSeenAt: Date.now(),
    });
    return true;
  }

  deletePerson(platform: string, userId: string) {
    return this.store.deletePersonCascade(platform, userId);
  }

  /**
   * 统一节点查找入口：给定任意节点 ID（person `<platform>:<userId>` 或 event/entity UUID）
   * 返回 { kind, name }；不存在返回 null。供 tools 层做存在性校验+友好报错使用。
   */
  async findNodeById(id: string): Promise<{ kind: 'person' | 'event' | 'entity'; name: string } | null> {
    if (!id) return null;
    if (id.includes(':')) {
      const idx = id.indexOf(':');
      const platform = id.slice(0, idx);
      const userId = id.slice(idx + 1);
      const p = await this.store.getPerson(platform, userId);
      if (p) return { kind: 'person', name: p.displayName ?? p.id };
      return null;
    }
    const ev = await this.store.getEvent(id);
    if (ev) return { kind: 'event', name: ev.title };
    const ent = await this.store.getEntity(id);
    if (ent) return { kind: 'entity', name: ent.name };
    return null;
  }

  // ----- Event -----

  /**
   * 新建事件。严格按 normalized title 去重：若已存在同名事件，**强制合并**到旧节点
   * （追加 evidence、累加权重 += 0.3、occurrences 追加当前时间戳），返回旧节点。
   * 这样保证「同一件事被反复提及」不会产生重复 event，但通过 occurrences[] 保留时间维度。
   */
  async createEvent(input: Omit<EventNode, 'id' | 'firstSeenAt' | 'lastReinforcedAt'>): Promise<EventNode> {
    const now = Date.now();
    // sessionScope 优先取显式传入；其次从 evidence[0].sessionId 推断；最终兜底 'global'。
    // 'global' 哨兵表示「显式跨会话事件」，与"老数据 undefined"区分开（后者表示来源不明）。
    // 若调用方真的没法给出 scope（如批处理脚本），落 'global' 并 audit warn 以便排查。
    let scope = input.sessionScope ?? input.evidence?.[0]?.sessionId;
    if (scope === undefined) {
      scope = 'global';
      this._audit(`[user-relation] createEvent 缺失 sessionScope，回落 'global'；title="${input.title}"`);
    }
    const dup = await this.findEventByTitle(input.title, scope);
    if (dup) {
      const merged: EventNode = {
        ...dup,
        summary: input.summary ?? dup.summary,
        category: input.category ?? dup.category,
        // 只在原节点 scope 为空（老数据）时才回填新 scope，避免覆盖已有隔离。
        sessionScope: dup.sessionScope ?? scope,
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
      sessionScope: scope,
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
   *
   * 若传入 scope：遵循「同名 + 同 scope 才是同事件」原则；只接受
   *   (a) 两者 scope 相同，或 (b) 旧节点 scope 为 undefined（老数据通配）。
   * 不传 scope：只看 title，保留老行为（供手动调用 / 测试 / 迁移）。
   */
  async findEventByTitle(title: string, scope?: string): Promise<EventNode | undefined> {
    const target = normalizeName(title);
    if (!target) return undefined;
    const snap = await this.store.loadAll();
    return snap.events.find(e => {
      if (normalizeName(e.title) !== target) return false;
      if (scope === undefined) return true;
      // 新数据需严格隔离；旧节点 scope=undefined 视为通配。
      return e.sessionScope === undefined || e.sessionScope === scope;
    });
  }

  /**
   * 强化已有事件：追加 evidence、更新 lastReinforcedAt，可选更新 summary/title/category。
   *
   * 跨 sessionScope 软护栏：如果新 evidence 全部来自与 existing.sessionScope 不同的会话，
   * 且 existing 既不是 'global' 也不是未限定 scope，则记录审计但**继续执行**（warn 不阻断）。
   * 与 addEventEventEdge 的 is-alias-of 跨 scope 硬阻断对应——reinforce 走 warn，
   * 因为它在不少正常路径（如 entity 共现、is-alias-of 后回写）也会自然跨 scope 触发。
   */
  async reinforceEvent(
    eventId: string,
    patch: { title?: string; summary?: string; category?: EventNode['category']; evidence?: EvidenceRef[] },
  ): Promise<EventNode | undefined> {
    const existing = await this.store.getEvent(eventId);
    if (!existing) return undefined;

    const existingScope = existing.sessionScope;
    const isScopedEvent = existingScope && existingScope !== 'global';
    if (isScopedEvent && patch.evidence && patch.evidence.length > 0) {
      const newSessionIds = new Set(patch.evidence.map(e => e.sessionId).filter((s): s is string => Boolean(s)));
      const allCross = newSessionIds.size > 0 && !newSessionIds.has(existingScope);
      if (allCross) {
        this._audit(
          `[user-relation] reinforceEvent 跨 sessionScope 警告：event=${eventId} scope="${existingScope}" 收到来自 [${[...newSessionIds].join(',')}] 的 evidence，已继续合并；如非预期请核查 LLM 抽取或 alias 合并路径`,
        );
      }
    }

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
        weight: clamp01(input.weight ?? roleDefaultWeight('person-entity', input.role)),
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
    let normalizedType = input.relationType.trim().toLowerCase().replace(/\s+/g, '-');
    // 跨 sessionScope 的 event 严禁通过 is-alias-of 合并：例如「群A 聊三角洲」与「群B 聊三角洲」
    // 标题撞车不代表是同一件事。允许 global hub 与任意 scope 别名挂接（global 表示已显式跨会话）。
    // 触发条件：两端 scope 都已知 / 都非 global / 且不相等 → 降级为 'related'（弱关联仍保留）+ 审计。
    if (normalizedType === 'is-alias-of') {
      const fromEv = await this.store.getEvent(input.fromEventId);
      const toEv = await this.store.getEvent(input.toEventId);
      const fromScope = fromEv?.sessionScope;
      const toScope = toEv?.sessionScope;
      const isCrossScope =
        fromScope !== undefined &&
        toScope !== undefined &&
        fromScope !== 'global' &&
        toScope !== 'global' &&
        fromScope !== toScope;
      if (isCrossScope) {
        this._audit(
          `[user-relation] 拒绝跨 sessionScope 的 event is-alias-of 合并：` +
            `${input.fromEventId}(scope=${fromScope}) ↔ ${input.toEventId}(scope=${toScope})，已降级为 'related'`,
        );
        normalizedType = 'related';
      }
    }
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
      weight: clamp01(input.weight ?? roleDefaultWeight('event-event', normalizedType)),
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
      weight: clamp01(input.weight ?? roleDefaultWeight('event-entity', normalizedType)),
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
      weight: clamp01(input.weight ?? roleDefaultWeight('entity-entity', normalizedType)),
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
        weight: clamp01(input.weight ?? roleDefaultWeight('person-event', inputTargetRole)),
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
    // ── familiar 占位自动废除 ──
    // 'familiar' 是行为观察兜底标签（"两人常一起说话但不知道具体关系"）；
    // 一旦同一对人之间出现任何**身份性**关系（friend/cp/mentor/colleague/rival/...），
    // familiar 就不再有信息量。在新建或加强非 familiar 关系时顺手删除同对的 familiar 边，
    // 避免视觉冗余。不动 is-alias-of / alt-account-of（别名声明正交于亲密度）。
    if (normalizedType !== 'familiar' && normalizedType !== 'is-alias-of' && normalizedType !== 'alt-account-of') {
      for (const e of snapshot.edges) {
        if (e.kind !== 'person-person') continue;
        if (e.relationType !== 'familiar') continue;
        const sameDyad =
          (e.fromPersonId === input.fromPersonId && e.toPersonId === input.toPersonId) ||
          (e.fromPersonId === input.toPersonId && e.toPersonId === input.fromPersonId);
        if (!sameDyad) continue;
        await this.store.deleteEdge(e.id);
      }
    }
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
      weight: clamp01(input.weight ?? roleDefaultWeight('person-person', normalizedType)),
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
    deletedDanglingEdges: number;
  }> {
    const snap = await this.store.loadAll();
    // 先建节点 id 集合（用于悬空边检测）
    const personIdSet = new Set(snap.persons.map(p => p.id));
    const eventIdSet = new Set(snap.events.map(e => e.id));
    const entityIdSet = new Set(snap.entities.map(e => e.id));
    // 清理悬空边：端点指向不存在节点的边（节点被绕过 cascade 删除时可能残留）
    let deletedDanglingEdges = 0;
    for (const e of snap.edges) {
      let dangling = false;
      switch (e.kind) {
        case 'person-event':
          dangling = !personIdSet.has(e.fromPersonId) || !eventIdSet.has(e.toEventId);
          break;
        case 'person-entity':
          dangling = !personIdSet.has(e.fromPersonId) || !entityIdSet.has(e.toEntityId);
          break;
        case 'person-person':
          dangling = !personIdSet.has(e.fromPersonId) || !personIdSet.has(e.toPersonId);
          break;
        case 'event-event':
          dangling = !eventIdSet.has(e.fromEventId) || !eventIdSet.has(e.toEventId);
          break;
        case 'event-entity':
          dangling = !eventIdSet.has(e.fromEventId) || !entityIdSet.has(e.toEntityId);
          break;
        case 'entity-entity':
          dangling = !entityIdSet.has(e.fromEntityId) || !entityIdSet.has(e.toEntityId);
          break;
      }
      if (dangling) {
        await this.store.deleteEdge(e.id);
        deletedDanglingEdges++;
      }
    }
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
      deletedDanglingEdges,
    };
  }

  /**
   * Eager 时间衰减回写：把所有 event/entity 节点与所有边的 `weight` 字段
   * 物理改写为当前 `effectiveWeight`，并把 `lastReinforcedAt` 重置为 now
   * （作为"新的衰减基准"——否则下次 rewrite 会基于同一基准再次衰减，
   * raw 被反复折半到 0）。
   *
   * 设计动机（lazy → eager 切换）：
   * - 原 lazy 模式 DB 永远存 raw 累积值，effectiveWeight 仅查询时实时算。
   *   问题：raw=1.0 的边被衰减到 effW=0.3 后再次 reinforce 一次，
   *   `reinforceWeight(1.0, 0.1) = 1.0`——**永远卡死在 1**，effW 从 0.3
   *   瞬间跳回 1.0，离散跳跃，不符合"老朋友重逢慢慢回温"的人类直觉。
   * - Eager 回写后：raw 物理变成 0.3，下次 reinforce 从 0.3 出发 → 0.37 →
   *   0.43 …**渐进恢复**，活跃关系靠持续 reinforce 维持高位、长期不活跃的
   *   关系自然回落到 floor 附近。每日压缩前调用一次，DB 字段就能反映
   *   "当下真实强度"，便于调试 / 观察 / 跨时间快照对比。
   *
   * 语义合并（务实简化，避免新增 `lastDecayedAt` 字段）：
   * - `lastReinforcedAt` 在 eager 模式下含义统一为"上次 weight 字段被更新的
   *   时间"——reinforce* 方法与 rewriteWeights 都写它。物理上是衰减基准。
   * - 调用方应理解：稳态下"长期不活跃节点"的 lastReinforcedAt 会被每日
   *   rewrite 推到最近一次压缩时间，age 分子≈0；但它们的 effW 已收敛到 floor，
   *   ageScore 排序退化为 `1 / (floor × PR)`——PR 边缘的依旧最先被淘汰。
   *
   * 副作用与正交性：
   * - Person 节点不参与（无 weight 字段，由 mentionCount / lastSeenAt 表达活跃度）。
   * - `halfLifeDays <= 0`（衰减关闭）时 short-circuit 返回，零写盘开销；
   *   单测默认配置 `{ halfLifeDays: 0 }` 走此路径，**不影响现有测试行为**。
   * - 增量阈值 `|new - raw| < 1e-6` 跳过，避免对几乎无变化的节点做无谓写盘
   *   （也保证幂等：rewrite 后第二次立即调用本方法所有节点都命中阈值跳过）。
   * - 活跃节点保护：被 reinforce 过的节点 lastReinforcedAt > 上次 rewrite 时间，
   *   age 更小受保护——"最近活跃的更新鲜，更应保留"。
   *
   * 调用方：
   * - `evictByQuota` 入口自动调用一次（与每日 scheduler 压缩对齐）。
   * - `/relation rewrite-weights` 手动命令。
   *
   * 返回各类写回计数，便于日志 / 测试断言。
   */
  async rewriteWeights(
    decay: WeightDecayCfg,
    opts: { now?: number } = {},
  ): Promise<{ events: number; entities: number; edges: number; skipped: boolean }> {
    if (decay.halfLifeDays <= 0) {
      return { events: 0, entities: 0, edges: 0, skipped: true };
    }
    const now = opts.now ?? Date.now();
    const snap = await this.store.loadAll();
    let events = 0;
    let entities = 0;
    let edges = 0;
    const EPS = 1e-6;
    for (const ev of snap.events) {
      const raw = ev.weight ?? 0.5;
      const newW = effectiveWeight(raw, ev.lastReinforcedAt, now, decay);
      if (Math.abs(newW - raw) < EPS) continue;
      await this.store.upsertEvent({ ...ev, weight: newW, lastReinforcedAt: now });
      events++;
    }
    for (const en of snap.entities) {
      const raw = en.weight ?? 0.5;
      const newW = effectiveWeight(raw, en.lastReinforcedAt, now, decay);
      if (Math.abs(newW - raw) < EPS) continue;
      await this.store.upsertEntity({ ...en, weight: newW, lastReinforcedAt: now });
      entities++;
    }
    for (const e of snap.edges) {
      const newW = effectiveWeight(e.weight, e.lastReinforcedAt, now, decay);
      if (Math.abs(newW - e.weight) < EPS) continue;
      await this.store.upsertEdge({ ...e, weight: newW, lastReinforcedAt: now });
      edges++;
    }
    return { events, entities, edges, skipped: false };
  }

  /**
   * 自动老化：按配额淘汰过多节点。模仿 profile 的"写后顺手扫"风格，不开独立调度器。
   *
   * 优先级（每次仅在超额时执行）：
   *   1. **孤儿节点**先删（无任何边引用的 person / event / entity；委托 `pruneOrphans()`）。
   *      孤儿清理与配额无关，旧账噪声任何时候都清。
   *   2. 仍超额时按 `(now - lastReinforcedAt) / (max(effW,0.05) · max(PR,ε))` **降序**删；
   *      即"老旧 + 低权重 + 在 PageRank 上无人指向"的优先丢。
   *   3. **不再有硬豁免**（evidence≥3 / effW≥0.8）：避免老节点永久占住名额。
   *      重要性完全由 effW + PageRank 表达：高 evidence/weight 节点自然在打分尾部，
   *      并且随时间衰减后仍可以让出名额。Person 节点同样进入排序，
   *      依靠 PR 个性化向量的人偶偏置（person seed=2 / entity=1.5 / event=1）自然偏保护。
   *   4. **滞回（hysteresis）**：仅当 count > quota·(1+hysteresisPct) 时才触发，
   *      触发后一次性裁到 floor(quota·targetPct)。默认 hysteresis=0.2, target=0.8 ——
   *      quota=500 时会在 600 触发并裁到 400，相当于一次清理 ~200 条；不会每写一条就裁。
   *   5. 边也按配额删——保留 `weight · 端点PR平均` 最高的，让"弱权但连接重要节点"的边受保护。
   *
   * 副作用：每次调用都会把 PageRank 写回三类节点的 `lastPageRank` / `lastPageRankAt`，
   * 用于 WebUI 展示"图重要性"。
   *
   * PageRank 个性化向量按 kind 加权（默认 person=2 / entity=1.5 / event=1），从而"重要性 人>物>事"
   * 直接体现为分数偏置：人物附近的事件/实体更难被淘汰。
   * 另外 utils.computePageRank 在 person→event / person→entity 单向边上加了半权反向虚拟边（系数 0.5），
   * 让"参与重要事件 / 关注热门实体"的人 PR 能拉开差距，避免无 person-person 边的人退化到 seed 常数。
   *
   * 返回各类删除计数，便于日志/测试断言。
   */
  async evictByQuota(quota: {
    /** 人物节点总数上限。0 = 不限（允许人物无限增长）。 */
    maxPersons?: number;
    maxEvents: number;
    maxEntities: number;
    maxEdges: number;
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
    /** PageRank 个性化向量种子权（人/物/事），默认 2/1.5/1 */
    personSeed?: number;
    entitySeed?: number;
    eventSeed?: number;
    /**
     * person→event / person→entity 单向边反向虚拟边权重系数。
     * 0 = 不加反向边；默认 0.5。
     */
    reverseEdgeFactor?: number;
    /**
     * 是否启用 component-size 缩放（Component-weighted Personalized PageRank）：
     * 孤立小连通分量节点 PR 按 sqrt(componentSize/n) 压低，避免
     * "1人1物1事" 这种三角小环被反向虚拟边 + dangling 重分布抬高。默认 true。
     */
    pagerankComponentScale?: boolean;
    /** 时间衰减配置：用于把 raw weight 折算成有效 weight。halfLifeDays<=0 时退化为原 raw 行为。 */
    decay?: WeightDecayCfg;
    /**
     * 社群发现算法；默认 'louvain'。
     * - 'louvain'：标准硬划分，快、主社群清晰；每人恒为 1 个社群。
     * - 'leiden'：Louvain + 内部连通性 refinement；修复 Louvain 社区内部可能不连通的问题。
     * - 'slpa'：Speaker-Listener Label Propagation，**原生重叠社区**；跨群人物能获得多个社群隶属度。
     */
    communityAlgorithm?: 'louvain' | 'leiden' | 'slpa';
  }): Promise<{
    deletedPersons: number;
    deletedEvents: number;
    deletedEntities: number;
    deletedEdges: number;
    /** 孤儿阶段被删的 id 列表（前 50 个），便于日志/诊断 */
    orphanSamples: { persons: string[]; events: string[]; entities: string[] };
  }> {
    const damping = quota.pagerankDamping ?? 0.85;
    const maxIter = quota.pagerankIterations ?? 20;
    const epsilon = quota.pagerankEpsilon ?? 1e-4;
    const hysteresisPct = Math.max(quota.hysteresisPct ?? 0.2, 0);
    const targetPct = Math.min(Math.max(quota.targetPct ?? 0.8, 0.1), 1);
    const personSeed = quota.personSeed ?? 2;
    const entitySeed = quota.entitySeed ?? 1.5;
    const eventSeed = quota.eventSeed ?? 1;
    const reverseEdgeFactor = quota.reverseEdgeFactor ?? 0.5;
    const pagerankComponentScale = quota.pagerankComponentScale ?? true;
    const decayCfg: WeightDecayCfg = quota.decay ?? { halfLifeDays: 0, floor: 0.3 };
    let deletedPersons = 0;
    let deletedEvents = 0;
    let deletedEntities = 0;
    let deletedEdges = 0;

    // 0) Eager 时间衰减回写：把 raw weight 折算成"当下真实强度"再做后续淘汰。
    //    halfLifeDays<=0 时 rewriteWeights 内部 short-circuit，零写盘开销。
    //    与 ageScore 公式正交：rewrite 后未活跃节点共享同一 lastReinforcedAt 基线（分子≈0、相互按 weight 排），
    //    被 reinforce 过的节点 lastReinforcedAt > rewrite 时间，age 更小受保护——
    //    "最近活跃的更新鲜，更应保留"。详见 rewriteWeights 注释。
    await this.rewriteWeights(decayCfg);

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
      reverseEdgeFactor,
      componentScale: pagerankComponentScale,
    });
    const ageScore = (n: EventNode | EntityNode): number => {
      // 使用 effectiveWeight：raw weight 经过时间衰减后，老节点的"分母"自动变小，
      // 让 ageScore 进一步抬高、更早进入淘汰候选；新被强化过的节点 effW 接近 raw，被保护。
      // evidence count 作为软加权：证据越多越不易淘汰，但不是硬豁免。
      const evBoost = 1 + Math.log1p(n.evidence?.length ?? 0);
      const w = Math.max(effectiveWeight(n.weight ?? 0.5, n.lastReinforcedAt, now, decayCfg), 0.05);
      const p = Math.max(pr.get(n.id) ?? 0, 1e-6);
      return (now - n.lastReinforcedAt) / (w * p * evBoost);
    };

    // Person 的 ageScore：无 weight/evidence，依靠 mentionCount / lastSeenAt / PR。
    // PR 种子权 person seed=2 会让人在排序里自然偏位保护，但不豁免。
    const personAgeScore = (p: PersonNode): number => {
      const lastActive = p.lastMentionedAt ?? p.lastSeenAt;
      // mentionCount 起到"软 weight"作用；未被提及过的人仅留一个底值。
      const mc = Math.max(p.mentionCount ?? 0, 1);
      const pr0 = Math.max(pr.get(p.id) ?? 0, 1e-6);
      return (now - lastActive) / (mc * pr0);
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

    const maxPersons = quota.maxPersons ?? 0;
    if (maxPersons > 0) {
      const remainingPersons = (await this.store.loadAll()).persons;
      if (remainingPersons.length >= triggerCount(maxPersons)) {
        const toDelete = remainingPersons.length - targetCount(maxPersons);
        if (toDelete > 0) {
          const sorted = [...remainingPersons].sort((a, b) => personAgeScore(b) - personAgeScore(a));
          for (const p of sorted.slice(0, toDelete)) {
            await this.store.deletePersonCascade(p.platform, p.userId);
            deletedPersons++;
          }
        }
      }
    }
    if (quota.maxEvents > 0) {
      const remainingEvents = (await this.store.loadAll()).events;
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
      const remainingEntities = (await this.store.loadAll()).entities;
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
            // 边的 lastReinforcedAt 与节点同理；effW 反映"近期强度"，老边自然向尾部沉淀
            const effW = effectiveWeight(e.weight, e.lastReinforcedAt, now, decayCfg);
            return effW * Math.max(prAvg, 1e-6);
          };
          const sorted = [...refreshed.edges].sort((a, b) => edgeScore(a) - edgeScore(b));
          for (const e of sorted.slice(0, toDelete)) {
            await this.store.deleteEdge(e.id);
            deletedEdges++;
          }
        }
      }
    }

    // 4) 把 PageRank 写回三类节点，供 WebUI 展示"图重要性"；
    //    顺手跑社群发现（Louvain / Leiden / SLPA 可切换），把 communityId + communityMemberships 一并写回（同一批 snapshot 保证可比）。
    //    存储 schema 统一：louvain/leiden 永远写单元素 memberships=[{id, weight:1}]，slpa 写全多元素；
    //    communityId 始终等于 memberships[0].id（主社群，向下兼容旧消费方）。
    {
      const after = await this.store.loadAll();
      const alg: 'louvain' | 'leiden' | 'slpa' = quota.communityAlgorithm ?? 'louvain';
      // 统一到 Map<nodeId, CommunityMembership[]>。
      let memberships: Map<string, CommunityMembership[]>;
      if (alg === 'slpa') {
        memberships = computeSlpa(after);
      } else {
        const com = alg === 'leiden' ? computeLeiden(after) : computeLouvain(after);
        memberships = new Map();
        for (const [id, cid] of com) memberships.set(id, [{ id: cid, weight: 1 }]);
      }
      // 取主社群 id（memberships[0].id）做 modularity 与社群计数。
      // modularity 只在硬划分算法下有标准定义；SLPA 用主社群作为近似参考值（仅诊断不作质量裁决）。
      const primary = new Map<string, string>();
      const allCommIds = new Set<string>();
      for (const [id, list] of memberships) {
        if (list.length > 0) primary.set(id, list[0].id);
        for (const m of list) allCommIds.add(m.id);
      }
      const q = computeModularity(after, primary);
      this.ctx?.logger?.info(
        `[user-relation] community algorithm=${alg} Q=${q.toFixed(4)} communities=${allCommIds.size} (nodes=${after.persons.length + after.events.length + after.entities.length})`,
      );
      for (const p of after.persons) {
        const score = pr.get(p.id);
        const list = memberships.get(p.id);
        const cid = list && list.length > 0 ? list[0].id : undefined;
        if (score === undefined && cid === undefined) continue;
        await this.store.upsertPerson({
          ...p,
          ...(score !== undefined ? { lastPageRank: score, lastPageRankAt: now } : {}),
          ...(cid !== undefined ? { communityId: cid, communityIdAt: now, communityMemberships: list } : {}),
        });
      }
      for (const ev of after.events) {
        const score = pr.get(ev.id);
        const list = memberships.get(ev.id);
        const cid = list && list.length > 0 ? list[0].id : undefined;
        if (score === undefined && cid === undefined) continue;
        await this.store.upsertEvent({
          ...ev,
          ...(score !== undefined ? { lastPageRank: score, lastPageRankAt: now } : {}),
          ...(cid !== undefined ? { communityId: cid, communityIdAt: now, communityMemberships: list } : {}),
        });
      }
      for (const en of after.entities) {
        const score = pr.get(en.id);
        const list = memberships.get(en.id);
        const cid = list && list.length > 0 ? list[0].id : undefined;
        if (score === undefined && cid === undefined) continue;
        await this.store.upsertEntity({
          ...en,
          ...(score !== undefined ? { lastPageRank: score, lastPageRankAt: now } : {}),
          ...(cid !== undefined ? { communityId: cid, communityIdAt: now, communityMemberships: list } : {}),
        });
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
   * 计算两节点间联系强度（方向感知版）。
   *
   * **方向语义模型**：
   * - **桥型边**（person-event / person-entity / event-entity）：事件/实体没有主观能动，
   *   仅作中介出现 → 邻接表里总是双向（无视 edge.directed）
   * - **主体间边**（person-person / event-event / entity-entity）：
   *   - `directed=false` → 双向（如 event "related" event）
   *   - `directed=true` → 严格 from→to 单向（如 A "admirer" B：B 不一定认识 A）
   *
   * **mode 参数**：
   * - `'symmetric'`（默认）= **联系紧密度**。跑 a→b 与 b→a 两遍取 max。
   *   语义："存在任意方向的关系连通"。单方面声明至少会从一侧贡献。
   * - `'directed'` = **关注/影响传播度**。仅跑 fromNodeId → toNodeId 一次。
   *   语义："从 A 出发能否通过主动声明触达 B"。适用于"A 都关心了谁/A 的影响波及谁"。
   *
   * **kindMultiplier**（待数据观察调整，目前为直觉估计）：
   * - person-person = 1.0（社会语义最强）
   * - person-event = 0.8（事件 = 真实互动）
   * - person-entity = 0.5（兴趣共鸣 < 真实互动）
   * - event-event = 0.4
   * - event-entity = 0.4
   * - entity-entity = 0.3（内容关联，非社会信号）
   *
   * **算法**：限深简单路径枚举（Katz 风格） + Adamic-Adar 共同邻居
   * - contrib = β^|p| × Π w_e × (len==1 ? 1.5 : 1) — 直接连接 boost
   * - common = Σ 1/log(deg(C)+1.7) — 惩罚高度共同节点（群聊噪声）
   * - raw = katz + 0.3 × common；score = tanh(raw) ∈ [0, 1]
   *
   * **未来扩展点**（在 opts 里预留）：hierarchy 反向降权、relationType 加权、时间衰减…
   */
  async scoreBetween(
    fromNodeId: string,
    toNodeId: string,
    opts: {
      maxDepth?: number;
      beta?: number;
      topPaths?: number;
      /** 'symmetric'（默认）= 联系紧密度；'directed' = 关注/影响传播度 */
      mode?: ScoreMode;
    } = {},
  ): Promise<{
    fromId: string;
    toId: string;
    mode: ScoreMode;
    score: number;
    rawScore: number;
    katzScore: number;
    commonNeighborsScore: number;
    pathsConsidered: number;
    shortestLength: number | null;
    directlyConnected: boolean;
    /** 仅 symmetric 模式同时利用；directed 模式 backward* 固定 0 */
    forwardKatzScore: number;
    backwardKatzScore: number;
    topPaths: Array<{
      direction: 'forward' | 'backward';
      nodes: Array<PersonNode | EventNode | EntityNode>;
      edges: RelationEdge[];
      length: number;
      weightProduct: number;
      contribution: number;
    }>;
    commonNeighbors: Array<{
      node: PersonNode | EventNode | EntityNode;
      degree: number;
      aaContribution: number;
    }>;
  }> {
    const mode: ScoreMode = opts.mode ?? 'symmetric';
    const maxDepth = Math.max(1, Math.min(6, opts.maxDepth ?? 4));
    const beta = Math.max(0.05, Math.min(1, opts.beta ?? 0.5));
    const topK = Math.max(1, Math.min(20, opts.topPaths ?? 3));

    const snapshot = await this.store.loadAll();
    const personById = new Map(snapshot.persons.map(p => [p.id, p]));
    const eventById = new Map(snapshot.events.map(e => [e.id, e]));
    const entityById = new Map(snapshot.entities.map(e => [e.id, e]));
    const nodeOf = (id: string) => personById.get(id) ?? eventById.get(id) ?? entityById.get(id);

    type TopPath = {
      direction: 'forward' | 'backward';
      nodes: Array<PersonNode | EventNode | EntityNode>;
      edges: RelationEdge[];
      length: number;
      weightProduct: number;
      contribution: number;
    };
    type CN = { node: PersonNode | EventNode | EntityNode; degree: number; aaContribution: number };

    const empty = (score: number, katz: number, shortest: number | null) => ({
      fromId: fromNodeId,
      toId: toNodeId,
      mode,
      score,
      rawScore: katz,
      katzScore: katz,
      commonNeighborsScore: 0,
      pathsConsidered: 0,
      shortestLength: shortest,
      directlyConnected: false,
      forwardKatzScore: katz,
      backwardKatzScore: 0,
      topPaths: [] as TopPath[],
      commonNeighbors: [] as CN[],
    });

    if (fromNodeId === toNodeId) {
      const present = !!nodeOf(fromNodeId);
      return empty(present ? 1 : 0, present ? 1 : 0, present ? 0 : null);
    }
    if (!nodeOf(fromNodeId) || !nodeOf(toNodeId)) return empty(0, 0, null);

    // ---- kind 缩放（待数据观察调整） ----
    const kindMultiplier = (kind: RelationEdge['kind']): number => {
      switch (kind) {
        case 'person-person':
          return 1.0;
        case 'person-event':
          return 0.8;
        case 'person-entity':
          return 0.5;
        case 'event-event':
        case 'event-entity':
          return 0.4;
        default:
          return 0.3; // entity-entity
      }
    };
    const effectiveWeight = (e: RelationEdge) => Math.max(1e-6, e.weight) * kindMultiplier(e.kind);

    // ---- 邻接表（方向感知） ----
    // 桥型边：双向；主体边按 directed 字段决定。
    // commonNeighbors 也用同一张表，保持方向语义一致（单向声明的 admirer 不算共同邻居）。
    const adj = new Map<string, Array<{ next: string; edge: RelationEdge }>>();
    const addArc = (a: string, b: string, edge: RelationEdge) => {
      const arr = adj.get(a);
      if (arr) arr.push({ next: b, edge });
      else adj.set(a, [{ next: b, edge }]);
    };
    const addBoth = (a: string, b: string, edge: RelationEdge) => {
      addArc(a, b, edge);
      addArc(b, a, edge);
    };
    for (const e of snapshot.edges) {
      if (e.kind === 'person-event') addBoth(e.fromPersonId, e.toEventId, e);
      else if (e.kind === 'person-entity') addBoth(e.fromPersonId, e.toEntityId, e);
      else if (e.kind === 'event-entity') addBoth(e.fromEventId, e.toEntityId, e);
      else {
        // 主体边：person-person / event-event / entity-entity
        const directed = e.directed !== false;
        let f: string;
        let t: string;
        if (e.kind === 'person-person') {
          f = e.fromPersonId;
          t = e.toPersonId;
        } else if (e.kind === 'event-event') {
          f = e.fromEventId;
          t = e.toEventId;
        } else {
          f = e.fromEntityId;
          t = e.toEntityId;
        }
        if (directed) addArc(f, t, e);
        else addBoth(f, t, e);
      }
    }

    // ---- DFS 限深简单路径枚举 ----
    const enumPaths = (start: string, end: string) => {
      const result: Array<{ edges: RelationEdge[]; nodeIds: string[]; weightProduct: number }> = [];
      const visited = new Set<string>([start]);
      const curEdges: RelationEdge[] = [];
      const curNodes: string[] = [start];
      const dfs = (cur: string, depth: number) => {
        if (cur === end) {
          let prod = 1;
          for (const e of curEdges) prod *= effectiveWeight(e);
          result.push({ edges: [...curEdges], nodeIds: [...curNodes], weightProduct: prod });
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
      dfs(start, 0);
      return result;
    };

    const contribOf = (len: number, prod: number) => beta ** len * prod * (len === 1 ? 1.5 : 1);

    const forwardPaths = enumPaths(fromNodeId, toNodeId);
    const backwardPaths = mode === 'symmetric' ? enumPaths(toNodeId, fromNodeId) : [];

    let forwardKatz = 0;
    let backwardKatz = 0;
    let shortestF = Number.POSITIVE_INFINITY;
    let shortestB = Number.POSITIVE_INFINITY;
    for (const p of forwardPaths) {
      forwardKatz += contribOf(p.edges.length, p.weightProduct);
      if (p.edges.length < shortestF) shortestF = p.edges.length;
    }
    for (const p of backwardPaths) {
      backwardKatz += contribOf(p.edges.length, p.weightProduct);
      if (p.edges.length < shortestB) shortestB = p.edges.length;
    }

    // ---- Adamic-Adar 共同邻居 ----
    // AA 衡量"两端共同接触的第三方"，是无方向概念（A 关注 C / D 关注 A 都让 A 与 C/D 相邻）。
    // 用 出邻居 ∪ 入邻居 构造无向邻居集；度数也取无向度，避免与 Katz 方向语义混淆。
    const undirectedAdj = new Map<string, Set<string>>();
    const linkUndir = (a: string, b: string) => {
      let sa = undirectedAdj.get(a);
      if (!sa) {
        sa = new Set();
        undirectedAdj.set(a, sa);
      }
      sa.add(b);
      let sb = undirectedAdj.get(b);
      if (!sb) {
        sb = new Set();
        undirectedAdj.set(b, sb);
      }
      sb.add(a);
    };
    for (const [a, arcs] of adj) {
      for (const { next } of arcs) linkUndir(a, next);
    }
    const nFrom = undirectedAdj.get(fromNodeId) ?? new Set<string>();
    const nTo = undirectedAdj.get(toNodeId) ?? new Set<string>();
    const commonNeighborsList: CN[] = [];
    let commonNeighborsScore = 0;
    for (const c of nFrom) {
      if (!nTo.has(c) || c === fromNodeId || c === toNodeId) continue;
      const node = nodeOf(c);
      if (!node) continue;
      const deg = undirectedAdj.get(c)?.size ?? 0;
      const aa = 1 / Math.log(deg + 1.7);
      commonNeighborsScore += aa;
      commonNeighborsList.push({ node, degree: deg, aaContribution: aa });
    }
    commonNeighborsList.sort((a, b) => b.aaContribution - a.aaContribution);

    if (forwardPaths.length === 0 && backwardPaths.length === 0 && commonNeighborsScore === 0) {
      return empty(0, 0, null);
    }

    // ---- 汇总 ----
    const katzScore = mode === 'directed' ? forwardKatz : Math.max(forwardKatz, backwardKatz);
    const rawScore = katzScore + 0.3 * commonNeighborsScore;
    const score = Math.tanh(rawScore);
    const sl = mode === 'directed' ? shortestF : Math.min(shortestF, shortestB);
    const shortestLength = sl === Number.POSITIVE_INFINITY ? null : sl;

    const topPaths: TopPath[] = [
      ...forwardPaths.map(p => ({
        direction: 'forward' as const,
        p,
        len: p.edges.length,
        contribution: contribOf(p.edges.length, p.weightProduct),
      })),
      ...backwardPaths.map(p => ({
        direction: 'backward' as const,
        p,
        len: p.edges.length,
        contribution: contribOf(p.edges.length, p.weightProduct),
      })),
    ]
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, topK)
      .map(({ direction, p, len, contribution }) => ({
        direction,
        nodes: p.nodeIds.map(id => nodeOf(id)).filter((n): n is PersonNode | EventNode | EntityNode => !!n),
        edges: p.edges,
        length: len,
        weightProduct: p.weightProduct,
        contribution,
      }));

    return {
      fromId: fromNodeId,
      toId: toNodeId,
      mode,
      score,
      rawScore,
      katzScore,
      commonNeighborsScore,
      pathsConsidered: forwardPaths.length + backwardPaths.length,
      shortestLength,
      directlyConnected: shortestLength === 1,
      forwardKatzScore: forwardKatz,
      backwardKatzScore: backwardKatz,
      topPaths,
      commonNeighbors: commonNeighborsList.slice(0, topK),
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
       * (1.5) 宽召回 LLM 性能优化：
       * - skipLowScorePairs：若 true，pair 双方 compositeScore 均 < lowScoreThreshold 时跳过 LLM 核验
       *   （两端都是 edge tier，合并价值低，不值得花 LLM 调用），默认 true。
       * - lowScoreThreshold：阈值，默认 0.2（与 scoreToTier 的 edge 边界一致）。设 0 = 不跳过。
       */
      skipLowScorePairs?: boolean;
      lowScoreThreshold?: number;
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
    /** event 重复合并：召回候选数（pair 数，dry-run 报告用） */
    eventDuplicateCandidates: number;
    /** event 重复合并：实际合并的 event 数（被合并到 canonical 的别名 event 数） */
    eventDuplicatesMerged: number;
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
    /** consolidate 命中持久化 negativeCache 而省下的 LLM 调用次数。 */
    let llmRejectCacheHits = 0;
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
              // negativeCache：双方 lastReinforcedAt 都未变 → 跳过 LLM，复用上次否决结论
              const cached = await this.store.getMergeReject(a.id, b.id);
              if (
                cached &&
                cached.aReinforcedAt === (a.lastReinforcedAt ?? 0) &&
                cached.bReinforcedAt === (b.lastReinforcedAt ?? 0)
              ) {
                llmRejectCacheHits++;
                shouldMerge = false;
                if (opts.llm.ctx.logger) {
                  opts.llm.ctx.logger.debug(
                    `[user-relation] consolidate 命中 mergeReject 缓存 ${a.id} ↔ ${b.id}（${cached.decidedBy}）：${cached.reason}`,
                  );
                }
              } else {
                const v = await verifyAliasPair(opts.llm.ctx, llmModel, a, b, llmDisableThinking);
                if (v.isSame) {
                  llmVerified++;
                  if (opts.llm.ctx.logger) {
                    opts.llm.ctx.logger.info(`[user-relation] consolidate LLM 同意合并 ${a.id} ↔ ${b.id}: ${v.reason}`);
                  }
                  // 之前否决但本次同意 → 清掉缓存（节点已演化）
                  if (cached) await this.store.deleteMergeReject(a.id, b.id);
                } else {
                  llmRejected++;
                  shouldMerge = false;
                  if (opts.llm.ctx.logger) {
                    opts.llm.ctx.logger.info(`[user-relation] consolidate LLM 否决合并 ${a.id} ↔ ${b.id}: ${v.reason}`);
                  }
                  // 落 negativeCache，避免下次 maintain 重复送 LLM
                  const [smaller, larger] = a.id < b.id ? [a, b] : [b, a];
                  await this.store.saveMergeReject({
                    aId: smaller.id,
                    bId: larger.id,
                    aReinforcedAt: smaller.lastReinforcedAt ?? 0,
                    bReinforcedAt: larger.lastReinforcedAt ?? 0,
                    reason: v.reason,
                    decidedAt: Date.now(),
                    decidedBy: 'strict-equiv',
                    kind: 'entity',
                  });
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
            }
            // 无条件触发真合并：即便 alias 边已存在（如老版本"路由+壳子"残留的
            // 半合并状态），也要把 alias 节点真正合并掉，确保收敛。mergeAlias 幂等：
            // alias 节点已不存在 → 直接 no-op；还在 → 正常合并。
            const mergeResult = await this.mergeAlias({ aliasId: a.id, canonicalId: b.id, kind: 'entity' });
            mergedCanonicals.add(mergeResult.effectiveCanonicalId);
            if (mergeResult.aliasDeleted && this.ctx?.logger) {
              this.ctx.logger.info(
                `[user-relation] consolidate strict-equiv 真合并：${mergeResult.effectiveAliasId} → ${mergeResult.effectiveCanonicalId}`,
              );
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
    //
    //   ── 决策范式 (2026-05 P1)：批量决策 → 并查集分簇 → 一次合并 ──
    //     1) 召回所有 pair 候选
    //     2) 对每个候选跑 verifyAliasPair（只记结果，不立即合并）
    //     3) 把所有 LLM 判 yes 的候选丢进并查集 (union-find)，
    //        自然处理传递闭包：A↔B yes & B↔C yes ⇒ {A,B,C} 一簇
    //     4) 每个 size≥2 的簇内按 mergeScore 选 canonical
    //        (mergeScore = 0.5·weightSum + 0.3·edgeCount + 0.2·evidenceCount，
    //         不含 recency；与 compositeScore 解耦，专为"挑代表"语义)，
    //        把其它成员逐个 mergeAlias 到 canonical
    //   动机：旧逻辑是"判一对合一对"，snapshot 不刷新会出现悬空合并 / 漏传递闭包。
    //         本范式让决策与应用分离，所有 LLM 判定基于同一份 snapshot，行为可预测。
    //   未启用 LLM 时跳过本段（保持原算法的零误合并保证）。
    if (opts.autoLink && llmModel && opts.llm) {
      const entitiesByKind = new Map<string, EntityNode[]>();
      for (const e of snapshot.entities) {
        const k = e.entityKind ?? 'topic';
        if (!entitiesByKind.has(k)) entitiesByKind.set(k, []);
        entitiesByKind.get(k)!.push(e);
      }

      // ─── F3 候选预收集：先把召回条件命中的 pair 全捞出来，不立刻调 LLM ───
      // 目的：拿到全集后才能按 compositeScore 排序、按低权阈值跳过，
      //      避免无脑顺序跑 LLM 把预算花在两端都很 edge 的低价值候选上。
      type Candidate = { a: EntityNode; b: EntityNode; reason: string; pairKey: string };
      const candidates: Candidate[] = [];

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
            candidates.push({ a, b, reason, pairKey: k });
          }
        }
      }

      // 给候选里出现过的每个 entity 算一次 compositeScore（snapshot 已固定，避免重复扫边）
      // F2：缓存完整 score 对象（含 relatedPeople/Events/Entities），用于喂给 verifyAliasPair 的上下文。
      const scoreCache = new Map<
        string,
        { compositeScore: number; relatedPeople: number; relatedEvents: number; relatedEntities: number } | null
      >();
      const getScoreInfo = (
        id: string,
      ): { compositeScore: number; relatedPeople: number; relatedEvents: number; relatedEntities: number } | null => {
        if (scoreCache.has(id)) return scoreCache.get(id) ?? null;
        const s = this._computeSingleNodeScore(id, snapshot);
        const v = s
          ? {
              compositeScore: s.compositeScore,
              relatedPeople: s.relatedPeople,
              relatedEvents: s.relatedEvents,
              relatedEntities: s.relatedEntities,
            }
          : null;
        scoreCache.set(id, v);
        return v;
      };
      const scoreOf = (id: string): number => getScoreInfo(id)?.compositeScore ?? 0;

      // F3 排序：按 max(scoreA, scoreB) 倒序——优先把"至少一端重要"的候选送给 LLM；
      // 平局时按 pairKey 字典序，保证可复现。
      candidates.sort((x, y) => {
        const sx = Math.max(scoreOf(x.a.id), scoreOf(x.b.id));
        const sy = Math.max(scoreOf(y.a.id), scoreOf(y.b.id));
        if (sx !== sy) return sy - sx;
        return x.pairKey < y.pairKey ? -1 : 1;
      });

      // F3 阈值跳过：双方都很 edge（compositeScore < threshold）→ 不调 LLM。
      // 默认 threshold=0.2 与 scoreToTier 的 edge 边界一致；设 0 则全部送 LLM。
      const skipLowScore = opts.skipLowScorePairs !== false;
      const lowScoreThreshold = opts.lowScoreThreshold ?? 0.2;

      // 收集所有 LLM 判 yes 的 pair，连同各自 reason；之后按 entityKind 分簇合并
      type YesPair = { aId: string; bId: string; reason: string };
      const yesPairs: YesPair[] = [];
      let lowScoreSkipped = 0;

      for (const cand of candidates) {
        const { a, b, reason } = cand;
        const sA = scoreOf(a.id);
        const sB = scoreOf(b.id);
        if (skipLowScore && lowScoreThreshold > 0 && sA < lowScoreThreshold && sB < lowScoreThreshold) {
          lowScoreSkipped++;
          if (opts.llm.ctx.logger) {
            opts.llm.ctx.logger.debug(
              `[user-relation] consolidate 跳过低权候选 ${a.id}(${sA.toFixed(2)}) ↔ ${b.id}(${sB.toFixed(2)})：双方都低于 ${lowScoreThreshold}`,
            );
          }
          continue;
        }
        // negativeCache：双方 lastReinforcedAt 都未变 → 跳过 LLM，复用上次否决结论
        const cached = await this.store.getMergeReject(a.id, b.id);
        if (
          cached &&
          cached.aReinforcedAt === (a.lastReinforcedAt ?? 0) &&
          cached.bReinforcedAt === (b.lastReinforcedAt ?? 0)
        ) {
          llmRejectCacheHits++;
          if (opts.llm.ctx.logger) {
            opts.llm.ctx.logger.debug(
              `[user-relation] consolidate 命中 mergeReject 缓存（宽召回）${a.id} ↔ ${b.id}：${cached.reason}`,
            );
          }
          continue;
        }
        const v = await verifyAliasPair(opts.llm.ctx, llmModel, a, b, llmDisableThinking, {
          aEvidenceQuotes: (a.evidence ?? [])
            .slice(-3)
            .map(ev => (ev.quote ?? '').trim())
            .filter(Boolean),
          bEvidenceQuotes: (b.evidence ?? [])
            .slice(-3)
            .map(ev => (ev.quote ?? '').trim())
            .filter(Boolean),
          aNeighbors: (() => {
            const info = getScoreInfo(a.id);
            return info
              ? { people: info.relatedPeople, events: info.relatedEvents, entities: info.relatedEntities }
              : { people: 0, events: 0, entities: 0 };
          })(),
          bNeighbors: (() => {
            const info = getScoreInfo(b.id);
            return info
              ? { people: info.relatedPeople, events: info.relatedEvents, entities: info.relatedEntities }
              : { people: 0, events: 0, entities: 0 };
          })(),
        });
        if (!v.isSame) {
          llmRejected++;
          if (opts.llm.ctx.logger) {
            opts.llm.ctx.logger.info(
              `[user-relation] consolidate LLM 否决合并（宽召回）${a.id} ↔ ${b.id}: ${v.reason}`,
            );
          }
          // 落 negativeCache，下次扫描双方未变就跳过
          const [smaller, larger] = a.id < b.id ? [a, b] : [b, a];
          await this.store.saveMergeReject({
            aId: smaller.id,
            bId: larger.id,
            aReinforcedAt: smaller.lastReinforcedAt ?? 0,
            bReinforcedAt: larger.lastReinforcedAt ?? 0,
            reason: v.reason,
            decidedAt: Date.now(),
            decidedBy: 'wide-recall',
            kind: 'entity',
          });
          continue;
        }
        llmVerified++;
        if (opts.llm.ctx.logger) {
          opts.llm.ctx.logger.info(`[user-relation] consolidate LLM 同意合并（宽召回）${a.id} ↔ ${b.id}: ${v.reason}`);
        }
        // 之前否决但本次同意 → 清掉旧缓存
        if (cached) await this.store.deleteMergeReject(a.id, b.id);
        yesPairs.push({ aId: a.id, bId: b.id, reason });
      }

      if (lowScoreSkipped > 0 && opts.llm.ctx.logger) {
        opts.llm.ctx.logger.info(
          `[user-relation] consolidate F3 低权阈值跳过 ${lowScoreSkipped} 个 pair（阈值 ${lowScoreThreshold}）`,
        );
      }

      // ─── 并查集分簇 + 簇内挑 canonical + 统一合并 ───
      if (yesPairs.length > 0) {
        // 节点边/权聚合：供 mergeScore 使用。一次性扫边表，避免 O(N·E)。
        const entityEdgeStats = computeEntityEdgeStats(snapshot.edges);
        const entityById = new Map(snapshot.entities.map(e => [e.id, e] as const));

        // 并查集分簇：自然处理传递闭包 (A↔B yes & B↔C yes ⇒ {A,B,C} 一簇)
        const clusters = clusterEntitiesByPairs(yesPairs);

        // 候选合并时优先 reason 字典——非 canonical 成员要找到与 canonical 之间的召回 reason 作为 is-alias-of 边的 description
        // 若簇大小 >2，可能某对没有直接召回 reason（靠传递闭包入簇），fallback：用簇内"语义同一对象（传递闭包）"。
        const reasonLookup = new Map<string, string>();
        for (const p of yesPairs) {
          const k1 = `${p.aId}|${p.bId}`;
          const k2 = `${p.bId}|${p.aId}`;
          reasonLookup.set(k1, p.reason);
          reasonLookup.set(k2, p.reason);
        }

        for (const [, members] of clusters) {
          if (members.size < 2) continue;
          // 簇内 mergeScore 最高者当 canonical
          const canonicalId = pickCanonicalByMergeScore(members, entityById, entityEdgeStats);
          if (!canonicalId) continue;

          // 把其他成员逐个合并到 canonical
          for (const memberId of members) {
            if (memberId === canonicalId) continue;
            // 重新校验 canonical 仍存在（safety）
            const stillExists = snapshot.entities.some(e => e.id === canonicalId);
            if (!stillExists) break;
            const reason =
              reasonLookup.get(`${memberId}|${canonicalId}`) ??
              `consolidate 簇内传递闭包：${entityById.get(memberId)?.name ?? memberId} ↔ ${entityById.get(canonicalId)?.name ?? canonicalId}`;
            // is-alias-of 边可能已存在（之前轮已建过），先查
            const exists = snapshot.edges.some(
              e =>
                e.kind === 'entity-entity' &&
                e.relationType === 'is-alias-of' &&
                ((e.fromEntityId === memberId && e.toEntityId === canonicalId) ||
                  (e.fromEntityId === canonicalId && e.toEntityId === memberId)),
            );
            if (!exists) {
              const now = Date.now();
              await this.store.upsertEdge({
                id: globalThis.crypto.randomUUID(),
                kind: 'entity-entity',
                fromEntityId: memberId,
                toEntityId: canonicalId,
                relationType: 'is-alias-of',
                directed: true,
                weight: 0.7,
                description: `consolidate LLM 确认：${reason}`,
                firstSeenAt: now,
                lastReinforcedAt: now,
                evidence: [],
              });
              aliasEdgesCreated++;
            }
            const mergeResult = await this.mergeAlias({
              aliasId: memberId,
              canonicalId,
              kind: 'entity',
            });
            mergedCanonicals.add(mergeResult.effectiveCanonicalId);
            if (mergeResult.aliasDeleted && this.ctx?.logger) {
              this.ctx.logger.info(
                `[user-relation] consolidate wide-recall 真合并：${mergeResult.effectiveAliasId} → ${mergeResult.effectiveCanonicalId}`,
              );
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

    // ─── (3c) EventEntityEdge 旧账整理：同一 (event,entity) 仅保留最强关系
    //   语义强度排序：part-of > related > about
    //     · part-of = "属于/承载该实体"，是最强的结构性绑定
    //     · related = "围绕/相关"，中等
    //     · about   = "顺带提及"，最弱
    //   规则：
    //     · 同一 (event,entity) 下不应同时存在多种关系标注（"属于"已经包含了"关于"）
    //     · 取强度最高的一条作为 keep，其它边的 evidence 合并进来后删除
    //     · 若同强度有多条 → 取 weight 最大者
    //     · weight 取所有被合并边的最大值（保留强化记录）
    const eePairs = new Map<string, EventEntityEdge[]>();
    for (const e of snapshot.edges) {
      if (e.kind !== 'event-entity') continue;
      const k = `${e.fromEventId}|${e.toEntityId}`;
      if (!eePairs.has(k)) eePairs.set(k, []);
      eePairs.get(k)!.push(e);
    }
    const eeStrength: Record<string, number> = { 'part-of': 3, related: 2, about: 1 };
    for (const [, list] of eePairs.entries()) {
      if (list.length < 2) continue;
      // 选 keep：先按强度降序，强度相同按 weight 降序
      const sorted = [...list].sort((a, b) => {
        const sa = eeStrength[a.relationType] ?? 0;
        const sb = eeStrength[b.relationType] ?? 0;
        if (sa !== sb) return sb - sa;
        return (b.weight ?? 0) - (a.weight ?? 0);
      });
      const keep = sorted[0];
      const drop = sorted.slice(1);
      const seenMsgKey = new Set<string>(
        keep.evidence.map(ev => `${ev.sessionId}|${[...(ev.messageIds ?? [])].sort().join(',')}`),
      );
      const mergedEvidence = [...keep.evidence];
      let maxWeight = keep.weight ?? 0;
      for (const dup of drop) {
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
      if (mergedEvidence.length !== keep.evidence.length || maxWeight !== (keep.weight ?? 0)) {
        await this.store.upsertEdge({
          ...keep,
          evidence: trimEvidence(mergedEvidence),
          weight: maxWeight,
          lastReinforcedAt: Date.now(),
        });
      }
      eventEdgesNormalized++;
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

    // ─── (3) Event 重复合并 ─────────────────────────────────────────
    //   触发：autoLink && LLM 已配置（与 entity wide-recall 同口径）
    //   边界：sessionScope 相同 或 双方均 'global' —— 跨 scope 由 mergeAlias 硬护栏（L537）兜底
    //   召回：每个 scope 池内 O(N²) pair；
    //     有 embedding 服务：fused = 0.3·cos + 0.7·struct ≥ fusedThreshold
    //     无 embedding 服务：jaccard(chars) ≥ 0.4 或 struct ≥ 0.5
    //   终判：verifyEventPair（必经 LLM；mergeReject 缓存命中跳过）
    //   合并：并查集 → pickCanonicalForEvents → mergeAlias(kind:'event')
    //   注：本段以前面 entity 合并后的最新 snapshot 为准（重新 loadAll）。
    let eventDuplicateCandidates = 0;
    let eventDuplicatesMerged = 0;
    if (opts.autoLink && llmModel && opts.llm) {
      const r = await this._consolidateEventDuplicates({
        llmModel,
        llmCtx: opts.llm.ctx,
        disableThinking: llmDisableThinking,
        embedding: this.ctx?.getService<EmbeddingService>('embedding'),
        dryRun: false,
      });
      eventDuplicateCandidates = r.candidates.length;
      eventDuplicatesMerged = r.merged;
      llmVerified += r.llmVerified;
      llmRejected += r.llmRejected;
      llmRejectCacheHits += r.llmRejectCacheHits;
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
      eventDuplicateCandidates,
      eventDuplicatesMerged,
      ...(opts.llm ? { llmVerified, llmRejected, llmRejectCacheHits, summariesRewritten } : {}),
    };
    this._lastConsolidateAt = Date.now();
    this._lastConsolidateTrigger = opts.triggerSource ?? 'api';
    this._lastConsolidateResultSummary =
      `别名候选 ${aliasCandidates.length}，建别名边 ${aliasEdgesCreated}，part-of ${partOfEdgesCreated}，` +
      `事件边整理 ${eventEdgesNormalized}，实体层级候选 ${entityHierarchyCandidates}，层级边 ${entityHierarchyEdgesCreated}` +
      `，侧向父候选 ${lateralParentCandidates}，新建父 ${lateralParentsCreated}，侧向边 ${lateralEdgesCreated}` +
      (fakePersonsDeleted > 0 ? `，伪 person 清理 ${fakePersonsDeleted}（级联边 ${fakePersonEdgesDeleted}）` : '') +
      (eventDuplicateCandidates > 0
        ? `，event 重复候选 ${eventDuplicateCandidates}（合并 ${eventDuplicatesMerged}）`
        : '') +
      (opts.llm
        ? `，LLM 通过 ${llmVerified} 否决 ${llmRejected}` +
          (llmRejectCacheHits > 0 ? `（缓存命中 ${llmRejectCacheHits}）` : '') +
          ` 摘要重写 ${summariesRewritten}`
        : '');
    return consolidateResult;
  }

  // ============================================================
  //  Event 重复合并：consolidate (3) 段提取出的可复用实现 + dry-run API
  // ============================================================

  /**
   * 内部入口：执行一次 event 重复检测；可选 dryRun 仅返回候选不合并。
   *
   * 召回融合公式（前提条件）：
   *  - 有 embedding 时：fused = 0.3·cos + 0.7·struct，阈值 fusedThreshold（默认 0.7）；
   *    任一端有 embedding 失败 → 该 pair fallback 到 jaccard 分支
   *  - 无 embedding 时：jaccard(chars) ≥ jaccardThreshold(默认 0.4) **或** struct ≥ structuralThreshold(默认 0.5)
   *
   * sessionScope 隔离：
   *  - 同 scope 池内才比对（含「都 'global'」、「同 sessionId」、「都 undefined → 兜底当 'global'」）；
   *  - 跨 scope 永不比对，与 L537 mergeAlias 硬护栏一致
   *
   * Lazy embed：当 EventNode.embeddingHash !== computeEventEmbeddingHash(title, summary) 时，
   *  实时调 embedding.embed() 并写回（持久化），下次 consolidate 复用。
   */
  private async _consolidateEventDuplicates(opts: {
    llmModel?: LLMModel;
    llmCtx?: Context;
    embedding?: EmbeddingService;
    disableThinking?: boolean;
    /** dryRun=true: 仅返回候选 + LLM 终判结果，不执行 mergeAlias */
    dryRun?: boolean;
    fusedThreshold?: number;
    jaccardThreshold?: number;
    structuralThreshold?: number;
  }): Promise<{
    /** 进入 LLM 终判前的所有候选 pair（包含相似度信号，便于 dry-run 报告） */
    candidates: Array<{
      aId: string;
      bId: string;
      aTitle: string;
      bTitle: string;
      sessionScope: string;
      cosineScore: number | null;
      jaccardScore: number;
      structuralScore: number;
      fusedScore: number | null;
      llmVerdict?: { isSame: boolean; reason: string };
      cacheHit?: boolean;
    }>;
    llmVerified: number;
    llmRejected: number;
    llmRejectCacheHits: number;
    /** 实际合并的别名 event 数（dryRun=true 时为 0） */
    merged: number;
  }> {
    const fusedThreshold = opts.fusedThreshold ?? 0.7;
    const jaccardThreshold = opts.jaccardThreshold ?? 0.4;
    const structuralThreshold = opts.structuralThreshold ?? 0.5;
    const logger = opts.llmCtx?.logger ?? this.ctx?.logger;

    const snapshot = await this.store.loadAll();
    const events = snapshot.events;

    // 按 sessionScope 分组：undefined → 'global'（与硬护栏 L537 兼容）
    const scopeOf = (e: EventNode): string => e.sessionScope ?? 'global';
    const pools = new Map<string, EventNode[]>();
    for (const ev of events) {
      const s = scopeOf(ev);
      if (!pools.has(s)) pools.set(s, []);
      pools.get(s)!.push(ev);
    }

    // Lazy embed：把所有需要 embed 的 event 一次性扫出，按需算
    const ensureEmbedding = async (ev: EventNode): Promise<number[] | null> => {
      if (!opts.embedding) return null;
      const expectedHash = computeEventEmbeddingHash(ev.title, ev.summary);
      if (ev.embeddingHash === expectedHash && Array.isArray(ev.embeddingVector) && ev.embeddingVector.length > 0) {
        return ev.embeddingVector;
      }
      // 需要 embed
      const text = `${(ev.title || '').trim()}\n${(ev.summary || '').trim()}`.trim();
      if (!text) return null;
      try {
        const vec = await opts.embedding.embed(text);
        if (!Array.isArray(vec) || vec.length === 0) return null;
        // 写回持久化
        await this.store.upsertEvent({ ...ev, embeddingVector: vec, embeddingHash: expectedHash });
        // 同步缓存到本地副本（snapshot 不会再 reload）
        ev.embeddingVector = vec;
        ev.embeddingHash = expectedHash;
        return vec;
      } catch (err) {
        logger?.warn(
          `[user-relation] consolidate event embed 失败 ${ev.id} (${ev.title.slice(0, 20)}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    };

    type Candidate = {
      a: EventNode;
      b: EventNode;
      sessionScope: string;
      cosineScore: number | null;
      jaccardScore: number;
      structuralScore: number;
      fusedScore: number | null;
    };

    const candidates: Candidate[] = [];

    for (const [scope, list] of pools.entries()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          // 标题完全相同的硬合并候选不在本段处理（extractor 阶段就强化了），跳过避免重复
          // 但若 sessionScope 相同 + title 相同 + 仍是两个节点 → 通常是异常，让 wide-recall 接住
          // 这里允许 title 相等的也进 LLM
          const cosA = await ensureEmbedding(a);
          const cosB = await ensureEmbedding(b);
          let cosineScore: number | null = null;
          if (cosA && cosB && cosA.length === cosB.length) {
            cosineScore = cosineSimilarity(cosA, cosB);
          }
          const jaccardScore = jaccardChars(`${a.title} ${a.summary ?? ''}`, `${b.title} ${b.summary ?? ''}`);
          // 结构相似（Katz + AA）：可能较慢，仅在文本相似度已经达到门槛时才算
          // 预过滤：cosineScore >= 0.5 或 jaccard >= 0.3 才值得算 struct
          const preTextual = (cosineScore ?? 0) >= 0.5 || jaccardScore >= 0.3;
          let structuralScore = 0;
          if (preTextual) {
            try {
              const sb = await this.scoreBetween(a.id, b.id, { maxDepth: 3, topPaths: 1 });
              structuralScore = sb.score;
            } catch {
              structuralScore = 0;
            }
          }
          let fusedScore: number | null = null;
          let isCandidate = false;
          if (cosineScore !== null) {
            fusedScore = 0.3 * cosineScore + 0.7 * structuralScore;
            isCandidate = fusedScore >= fusedThreshold;
          } else {
            isCandidate = jaccardScore >= jaccardThreshold || structuralScore >= structuralThreshold;
          }
          if (!isCandidate) continue;
          candidates.push({ a, b, sessionScope: scope, cosineScore, jaccardScore, structuralScore, fusedScore });
        }
      }
    }

    // 按融合分倒序 / jaccard 倒序，优先把高置信送 LLM
    candidates.sort((x, y) => {
      const sx = x.fusedScore ?? x.jaccardScore;
      const sy = y.fusedScore ?? y.jaccardScore;
      return sy - sx;
    });

    const report: Array<{
      aId: string;
      bId: string;
      aTitle: string;
      bTitle: string;
      sessionScope: string;
      cosineScore: number | null;
      jaccardScore: number;
      structuralScore: number;
      fusedScore: number | null;
      llmVerdict?: { isSame: boolean; reason: string };
      cacheHit?: boolean;
    }> = [];

    let llmVerified = 0;
    let llmRejected = 0;
    let llmRejectCacheHits = 0;
    const yesPairs: Array<{ aId: string; bId: string; reason: string }> = [];

    for (const cand of candidates) {
      const { a, b } = cand;
      const reportEntry = {
        aId: a.id,
        bId: b.id,
        aTitle: a.title,
        bTitle: b.title,
        sessionScope: cand.sessionScope,
        cosineScore: cand.cosineScore,
        jaccardScore: cand.jaccardScore,
        structuralScore: cand.structuralScore,
        fusedScore: cand.fusedScore,
      } as (typeof report)[number];

      if (!opts.llmModel || !opts.llmCtx) {
        // dryRun 但没传 LLM —— 直接收集候选不判定
        report.push(reportEntry);
        continue;
      }

      const cached = await this.store.getMergeReject(a.id, b.id);
      if (
        cached &&
        cached.aReinforcedAt === (a.lastReinforcedAt ?? 0) &&
        cached.bReinforcedAt === (b.lastReinforcedAt ?? 0)
      ) {
        llmRejectCacheHits++;
        reportEntry.cacheHit = true;
        reportEntry.llmVerdict = { isSame: false, reason: `mergeReject 缓存：${cached.reason}` };
        report.push(reportEntry);
        continue;
      }

      const verdict = await verifyEventPair(opts.llmCtx, opts.llmModel, a, b, opts.disableThinking ?? true, {
        aEvidenceQuotes: (a.evidence ?? [])
          .slice(-3)
          .map(ev => (ev.quote ?? '').trim())
          .filter(Boolean),
        bEvidenceQuotes: (b.evidence ?? [])
          .slice(-3)
          .map(ev => (ev.quote ?? '').trim())
          .filter(Boolean),
        structuralScore: cand.structuralScore,
        textualScore: cand.fusedScore ?? cand.jaccardScore,
      });
      reportEntry.llmVerdict = verdict;
      report.push(reportEntry);

      if (!verdict.isSame) {
        llmRejected++;
        const [smaller, larger] = a.id < b.id ? [a, b] : [b, a];
        await this.store.saveMergeReject({
          aId: smaller.id,
          bId: larger.id,
          aReinforcedAt: smaller.lastReinforcedAt ?? 0,
          bReinforcedAt: larger.lastReinforcedAt ?? 0,
          reason: verdict.reason,
          decidedAt: Date.now(),
          decidedBy: 'wide-recall',
          kind: 'event',
        });
        logger?.info(
          `[user-relation] consolidate event LLM 否决 ${a.id}(${a.title.slice(0, 20)}) ↔ ${b.id}(${b.title.slice(0, 20)}): ${verdict.reason}`,
        );
        continue;
      }
      llmVerified++;
      if (cached) await this.store.deleteMergeReject(a.id, b.id);
      const reason =
        cand.fusedScore !== null
          ? `fused ${cand.fusedScore.toFixed(2)} (cos ${cand.cosineScore?.toFixed(2)}, struct ${cand.structuralScore.toFixed(2)})`
          : `jaccard ${cand.jaccardScore.toFixed(2)} / struct ${cand.structuralScore.toFixed(2)}`;
      yesPairs.push({ aId: a.id, bId: b.id, reason });
      logger?.info(
        `[user-relation] consolidate event LLM 同意合并 ${a.id}(${a.title.slice(0, 20)}) ↔ ${b.id}(${b.title.slice(0, 20)}): ${verdict.reason}`,
      );
    }

    // dryRun 不合并
    let merged = 0;
    if (!opts.dryRun && yesPairs.length > 0) {
      const eventEdgeStats = computeEventEdgeStats(snapshot.edges);
      const eventById = new Map(snapshot.events.map(e => [e.id, e] as const));
      const clusters = clusterEntitiesByPairs(yesPairs);
      for (const [, members] of clusters) {
        if (members.size < 2) continue;
        const canonicalId = pickCanonicalForEvents(members, eventById, eventEdgeStats);
        if (!canonicalId) continue;
        for (const memberId of members) {
          if (memberId === canonicalId) continue;
          // mergeAlias 内部有跨 sessionScope 硬护栏，重复保险
          try {
            const r = await this.mergeAlias({ aliasId: memberId, canonicalId, kind: 'event' });
            if (r.aliasDeleted) {
              merged++;
              logger?.info(
                `[user-relation] consolidate event 真合并：${r.effectiveAliasId} → ${r.effectiveCanonicalId}`,
              );
            }
          } catch (err) {
            logger?.warn(
              `[user-relation] consolidate event 合并失败 ${memberId} → ${canonicalId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    return { candidates: report, llmVerified, llmRejected, llmRejectCacheHits, merged };
  }

  /**
   * 公开 API：dry-run 查找 event 重复（不执行任何合并）。
   * 给 `/relation event-duplicates` 命令 / webui 调用使用。
   *
   * 与 consolidate 行为口径完全一致：sessionScope 同池 + 加权融合阈值 + mergeReject 缓存复用 + LLM 终判。
   * 但不写图，仅返回候选 + LLM 判定。
   */
  async findEventDuplicates(
    opts: {
      llm?: { ctx: Context; modelRef: ModelRef; disableThinking?: boolean };
      fusedThreshold?: number;
      jaccardThreshold?: number;
      structuralThreshold?: number;
    } = {},
  ): Promise<{
    candidates: Array<{
      aId: string;
      bId: string;
      aTitle: string;
      bTitle: string;
      sessionScope: string;
      cosineScore: number | null;
      jaccardScore: number;
      structuralScore: number;
      fusedScore: number | null;
      llmVerdict?: { isSame: boolean; reason: string };
      cacheHit?: boolean;
    }>;
    llmVerified: number;
    llmRejected: number;
    llmRejectCacheHits: number;
    embeddingAvailable: boolean;
  }> {
    const llmModel = opts.llm ? resolveConsolidateModel(opts.llm.ctx, { modelRef: opts.llm.modelRef }) : undefined;
    const embedding = this.ctx?.getService<EmbeddingService>('embedding');
    const r = await this._consolidateEventDuplicates({
      llmModel,
      llmCtx: opts.llm?.ctx,
      disableThinking: opts.llm?.disableThinking ?? true,
      embedding,
      dryRun: true,
      fusedThreshold: opts.fusedThreshold,
      jaccardThreshold: opts.jaccardThreshold,
      structuralThreshold: opts.structuralThreshold,
    });
    return {
      candidates: r.candidates,
      llmVerified: r.llmVerified,
      llmRejected: r.llmRejected,
      llmRejectCacheHits: r.llmRejectCacheHits,
      embeddingAvailable: !!embedding,
    };
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

  /**
   * 关系边修正：LLM 发现某条边过弱 / 过强 / 是幻觉时调用。
   *
   * 设计原则（小破坏性 + 高效修正）：
   * - **阶梯保护**：weight 越高越难物理删除，避免误删强关系
   *   - weight ≥ 0.5：只允许 weaken；想 remove 需先反复 weaken 到 < 0.5（或 force=true）
   *   - 0.3 ≤ weight < 0.5：可 weaken 或 remove
   *   - weight < 0.3：自由（含 strengthen 重建）
   * - **alias 边禁操作**：is-alias-of / alt-account-of 是结构性边，
   *   修改会破坏 mergeAlias 不变量。需取消别名请走未来的 splitAlias 工具。
   * - **必填 reason**（≤80 字），写入 weightHistory[] 留痕
   * - **物理删除清理干净**：deleteEdge 直接落盘，不留墓碑（避免脏数据）
   *
   * 不接受 multiplier > 1 的 weaken / multiplier < 1 的 strengthen
   * （语义错位会让 LLM 误用）。
   */
  async correctEdge(opts: {
    edgeId: string;
    action: 'weaken' | 'strengthen' | 'remove';
    /** weaken 默认 0.5；strengthen 默认 1.5；remove 忽略 */
    multiplier?: number;
    reason: string;
    /** 调用来源标识，默认 'llm' */
    by?: string;
    /** true → 跳过阶梯保护（仅 manual / 系统纠错使用） */
    force?: boolean;
  }): Promise<{
    action: 'weakened' | 'strengthened' | 'removed';
    edgeId: string;
    from: number;
    to: number;
    edge?: RelationEdge;
  }> {
    const reason = opts.reason?.trim().slice(0, 80);
    if (!reason) throw new Error('correctEdge: reason 必填，请说明修正理由');

    const edge = await this.store.getEdge(opts.edgeId);
    if (!edge) throw new Error(`correctEdge: edge ${opts.edgeId} 不存在`);

    // alias / alt-account 边禁操作
    if (edge.kind === 'person-person' || edge.kind === 'entity-entity') {
      const rt = edge.relationType;
      if (rt === 'is-alias-of' || rt === 'alt-account-of') {
        throw new Error(
          `correctEdge: 禁止操作 alias 边 (relationType=${rt})。alias 是结构性边，错绑请走未来的 splitAlias 流程，不要直接 weaken/remove。`,
        );
      }
    }

    const by = opts.by ?? 'llm';
    const now = Date.now();
    const prevWeight = edge.weight;

    if (opts.action === 'remove') {
      // 阶梯保护
      if (!opts.force && prevWeight >= 0.5) {
        throw new Error(
          `correctEdge: edge.weight=${prevWeight.toFixed(2)} ≥ 0.5，禁止直接 remove。请先用 weaken 把权重降到 < 0.5（建议反复 weaken 直至 < 0.3 再 remove），或确认后传 force=true。`,
        );
      }
      await this.store.deleteEdge(opts.edgeId);
      return { action: 'removed', edgeId: opts.edgeId, from: prevWeight, to: 0 };
    }

    if (opts.action === 'weaken') {
      const m = opts.multiplier ?? 0.5;
      if (m <= 0 || m >= 1) {
        throw new Error(`correctEdge: weaken multiplier 必须 ∈ (0, 1)，收到 ${m}`);
      }
      const newWeight = Math.max(0.001, prevWeight * m);
      const audit: EdgeWeightAudit = { from: prevWeight, to: newWeight, action: 'weaken', at: now, by, reason };
      const updated = {
        ...edge,
        weight: newWeight,
        lastReinforcedAt: now,
        weightHistory: [...(edge.weightHistory ?? []), audit],
      } as RelationEdge;
      await this.store.upsertEdge(updated);
      return { action: 'weakened', edgeId: opts.edgeId, from: prevWeight, to: newWeight, edge: updated };
    }

    // strengthen
    const m = opts.multiplier ?? 1.5;
    if (m <= 1 || m > 5) {
      throw new Error(`correctEdge: strengthen multiplier 必须 ∈ (1, 5]，收到 ${m}`);
    }
    const newWeight = Math.min(1, prevWeight * m);
    const audit: EdgeWeightAudit = { from: prevWeight, to: newWeight, action: 'strengthen', at: now, by, reason };
    const updated = {
      ...edge,
      weight: newWeight,
      lastReinforcedAt: now,
      weightHistory: [...(edge.weightHistory ?? []), audit],
    } as RelationEdge;
    await this.store.upsertEdge(updated);
    return { action: 'strengthened', edgeId: opts.edgeId, from: prevWeight, to: newWeight, edge: updated };
  }

  // ============================================================
  //  Alias merging（真合并：rewire 边 + 合并 aliases + 删 alias 节点）
  //  is-alias-of / alt-account-of 边写入后立即触发：
  //    - 按启发式校正 canonical 方向（name 较长 / aliases 较多 / 总 evidence 较多）
  //    - 将所有引用 aliasId 的其它边重写为指向 canonicalId
  //    - 同 dedup key 冲突时合并 evidence/weight 并删除冗余
  //    - 合并 alias 的 name + aliases 到 canonical.aliases（仅 entity/event；
  //      PersonNode 无 aliases 字段，留作未来扩展点）
  //    - 级联删除 alias 节点本身（含 alias↔canonical 的 is-alias-of 标记边，
  //      由 cascade 自动清掉）
  //  设计对齐：docs/plugins/user-relation.md §3 合并语义
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
    /** alias 节点是否被物理删除（即"真合并"是否完成）。person 当前总为 true（无 aliases 字段需合并） */
    aliasDeleted: boolean;
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
        aliasDeleted: false,
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

    // 清理涉及 aliasId 的 mergeReject 缓存：alias id 即将被吸收，旧缓存对未来无意义
    await this.store.deleteMergeRejectsByNode(aliasId);

    // ─── 真合并：合并 aliases + 级联删除 alias 节点 ───
    //  说明：mergeAlias 自身只 rewire 边，不能依赖此时的 snapshot 看到 canonical 节点最新状态
    //  （上面已对 store 做了若干 upsertEdge / deleteEdge）。重新 loadAll 以拿到最新 nodes。
    //  Person 节点目前没有 aliases 字段（PersonNode 见 types.ts L45），只删壳子。
    //  Entity/Event 节点把 alias.name(或 title) + alias.aliases 并入 canonical.aliases。
    let aliasDeleted = false;
    try {
      const fresh = await this.store.loadAll();
      if (opts.kind === 'entity') {
        const aliasNode = fresh.entities.find(e => e.id === aliasId);
        const canonicalNode = fresh.entities.find(e => e.id === canonicalId);
        if (aliasNode && canonicalNode) {
          const merged = Array.from(
            new Set([...(canonicalNode.aliases ?? []), aliasNode.name, ...(aliasNode.aliases ?? [])]),
          ).filter(s => !!s && s !== canonicalNode.name);
          if (merged.length !== (canonicalNode.aliases?.length ?? 0)) {
            await this.store.upsertEntity({ ...canonicalNode, aliases: merged });
          }
          await this.store.deleteEntityCascade(aliasId);
          aliasDeleted = true;
        }
      } else if (opts.kind === 'event') {
        const aliasNode = fresh.events.find(e => e.id === aliasId);
        const canonicalNode = fresh.events.find(e => e.id === canonicalId);
        if (aliasNode && canonicalNode) {
          const merged = Array.from(
            new Set([...(canonicalNode.aliases ?? []), aliasNode.title, ...(aliasNode.aliases ?? [])]),
          ).filter(s => !!s && s !== canonicalNode.title);
          if (merged.length !== (canonicalNode.aliases?.length ?? 0)) {
            await this.store.upsertEvent({ ...canonicalNode, aliases: merged });
          }
          await this.store.deleteEventCascade(aliasId);
          aliasDeleted = true;
        }
      } else {
        // person：复合 id `${platform}:${userId}`
        const idx = aliasId.indexOf(':');
        if (idx > 0) {
          const platform = aliasId.slice(0, idx);
          const userId = aliasId.slice(idx + 1);
          const aliasNode = fresh.persons.find(p => p.id === aliasId);
          if (aliasNode) {
            await this.store.deletePersonCascade(platform, userId);
            aliasDeleted = true;
          }
        }
      }
    } catch (err) {
      // 真合并失败不应阻塞调用链（边已经 rewire 成功，最差情况退化为旧的"路由+壳子"行为）
      // eslint-disable-next-line no-console
      console.warn(
        `[user-relation] mergeAlias: 删除 alias 壳子失败 alias=${aliasId} canonical=${canonicalId} kind=${opts.kind}`,
        err,
      );
    }

    return {
      effectiveCanonicalId: canonicalId,
      effectiveAliasId: aliasId,
      edgesRewritten,
      edgesMerged,
      edgesDeleted,
      swapped,
      aliasDeleted,
    };
  }

  // ============================================================
  //  Agent 写工具：deleteNode / deleteEdge / mergeNodes / changeEntityKind
  //  设计要点（与 correctEdge / renameNode 对称）：
  //    - Person 节点禁止 agent 物理删除（platform 身份只能由 user-profile 同步）
  //    - 阶梯保护：weight ≥ 0.8 或 evidence ≥ 5 视为强节点 / 强边 → 拒绝
  //    - alias 边（is-alias-of / alt-account-of）禁删（破坏身份合并）
  //    - 全部 logger.warn 记审计（含 by / reason / 影响范围）
  // ============================================================

  /**
   * 物理删除 event / entity 节点（级联删边）。Person 节点禁用。
   * 保护门：weight ≥ 0.8 或 evidence.length ≥ 5 直接拒绝。
   */
  async deleteNode(opts: {
    kind: 'event' | 'entity';
    id: string;
    reason: string;
    by?: string;
  }): Promise<{ kind: 'event' | 'entity'; id: string; deletedEdges: number }> {
    const reason = opts.reason?.trim().slice(0, 120);
    if (!reason) throw new Error('deleteNode: reason 必填');
    const by = opts.by ?? 'manual';

    if (opts.kind === 'event') {
      const node = await this.store.getEvent(opts.id);
      if (!node) throw new Error(`deleteNode: event ${opts.id} 不存在`);
      this._assertNodeDeletable(node.weight ?? 0.5, node.evidence?.length ?? 0, node.title);
      const { deletedEdges } = await this.store.deleteEventCascade(opts.id);
      this._audit(
        `[user-relation][AUDIT] deleteNode event id=${opts.id} title="${node.title}" by=${by} reason="${reason}" edges=${deletedEdges}`,
      );
      return { kind: 'event', id: opts.id, deletedEdges };
    }
    const node = await this.store.getEntity(opts.id);
    if (!node) throw new Error(`deleteNode: entity ${opts.id} 不存在`);
    this._assertNodeDeletable(node.weight ?? 0.5, node.evidence?.length ?? 0, node.name);
    const { deletedEdges } = await this.store.deleteEntityCascade(opts.id);
    this._audit(
      `[user-relation][AUDIT] deleteNode entity id=${opts.id} name="${node.name}" by=${by} reason="${reason}" edges=${deletedEdges}`,
    );
    return { kind: 'entity', id: opts.id, deletedEdges };
  }

  private _assertNodeDeletable(weight: number, evidenceCount: number, nameForErr: string): void {
    if (weight >= 0.8) {
      throw new Error(
        `节点 "${nameForErr}" 权重 ${weight.toFixed(2)} ≥ 0.8（强节点保护）。请先通过 correctEdge 或多次 cleanup 自然淡化，或走 /relation cleanup 人工命令。`,
      );
    }
    if (evidenceCount >= 5) {
      throw new Error(
        `节点 "${nameForErr}" evidence ${evidenceCount} ≥ 5（强节点保护）。证据充足的节点不允许 agent 直接删除。`,
      );
    }
  }

  /**
   * 物理删除一条边（带保护门，供 agent 调用）。alias 边（is-alias-of / alt-account-of）禁删；
   * weight ≥ 0.8 或 evidence ≥ 5 拒绝（请先 correctEdge weaken）。
   *
   * 注：与旧 deleteEdge(edgeId)（无保护，供 consolidate 内部使用）区别开。
   */
  async deleteEdgeWithGuard(opts: {
    edgeId: string;
    reason: string;
    by?: string;
  }): Promise<{ edgeId: string; kind: string; relationType: string; weight: number }> {
    const reason = opts.reason?.trim().slice(0, 120);
    if (!reason) throw new Error('deleteEdgeWithGuard: reason 必填');
    const by = opts.by ?? 'manual';
    const edge = await this.store.getEdge(opts.edgeId);
    if (!edge) throw new Error(`deleteEdgeWithGuard: edge ${opts.edgeId} 不存在`);
    const rt = String((edge as { relationType?: string }).relationType ?? '');
    if (rt === 'is-alias-of' || rt === 'alt-account-of') {
      throw new Error(`alias 边（${rt}）禁止删除——会破坏身份合并。请走 /relation cleanup 人工命令。`);
    }
    if ((edge.weight ?? 0) >= 0.8) {
      throw new Error(`边权重 ${(edge.weight ?? 0).toFixed(2)} ≥ 0.8（强边保护）。请先用 correctEdge weaken 衰减。`);
    }
    if ((edge.evidence?.length ?? 0) >= 5) {
      throw new Error(`边 evidence ${edge.evidence?.length ?? 0} ≥ 5（强边保护）。证据充足的边不允许直接删除。`);
    }
    await this.store.deleteEdge(opts.edgeId);
    this._audit(
      `[user-relation][AUDIT] deleteEdge id=${opts.edgeId} kind=${edge.kind} relationType=${rt} weight=${edge.weight} by=${by} reason="${reason}"`,
    );
    return { edgeId: opts.edgeId, kind: edge.kind, relationType: rt, weight: edge.weight ?? 0 };
  }

  /**
   * 物理合并：把 aliasIds 全部并入 canonicalId，并物理删除 aliasIds。
   * 仅支持 event / entity（person 合并请走 mergeAlias，保留 alias 标记边）。
   *
   * 内部分两步：
   *  1) 复用 mergeAlias 把每个 alias 的边改写到 canonical（保留同名 alias 标记边以便回溯）；
   *  2) 物理删除 alias 节点本身（cascade 顺手清理残留的 alias 标记边）。
   */
  async mergeNodes(opts: {
    kind: 'event' | 'entity';
    canonicalId: string;
    aliasIds: string[];
    reason: string;
    by?: string;
  }): Promise<{
    canonicalId: string;
    mergedAliasIds: string[];
    totalEdgesRewritten: number;
    totalEdgesMerged: number;
    totalEdgesDeleted: number;
  }> {
    const reason = opts.reason?.trim().slice(0, 120);
    if (!reason) throw new Error('mergeNodes: reason 必填');
    const by = opts.by ?? 'manual';
    const aliasIds = Array.from(new Set(opts.aliasIds ?? [])).filter(id => id && id !== opts.canonicalId);
    if (aliasIds.length === 0) throw new Error('mergeNodes: aliasIds 至少 1 个且不可等于 canonicalId');

    // 校验 canonical 存在
    const canonical =
      opts.kind === 'event'
        ? await this.store.getEvent(opts.canonicalId)
        : await this.store.getEntity(opts.canonicalId);
    if (!canonical) throw new Error(`mergeNodes: canonical ${opts.kind} ${opts.canonicalId} 不存在`);

    let totalEdgesRewritten = 0;
    let totalEdgesMerged = 0;
    let totalEdgesDeleted = 0;
    const mergedAliasIds: string[] = [];

    for (const aliasId of aliasIds) {
      // alias 节点也要存在 & 与 canonical 同类
      const aliasNode =
        opts.kind === 'event' ? await this.store.getEvent(aliasId) : await this.store.getEntity(aliasId);
      if (!aliasNode) {
        this._audit(`[user-relation] mergeNodes 跳过不存在的 alias ${aliasId}`);
        continue;
      }
      // 不做删除保护（合并是「保留语义」而非「丢失」），但仍记审计
      const r = await this.mergeAlias({
        aliasId,
        canonicalId: opts.canonicalId,
        kind: opts.kind,
        noCanonicalCorrection: true,
      });
      totalEdgesRewritten += r.edgesRewritten;
      totalEdgesMerged += r.edgesMerged;
      totalEdgesDeleted += r.edgesDeleted;

      // 物理删除 alias 节点（级联清掉残留的 alias 标记边自身）
      if (opts.kind === 'event') {
        const { deletedEdges } = await this.store.deleteEventCascade(aliasId);
        totalEdgesDeleted += deletedEdges;
      } else {
        const { deletedEdges } = await this.store.deleteEntityCascade(aliasId);
        totalEdgesDeleted += deletedEdges;
      }
      mergedAliasIds.push(aliasId);
    }

    this._audit(
      `[user-relation][AUDIT] mergeNodes kind=${opts.kind} canonical=${opts.canonicalId} aliases=[${mergedAliasIds.join(',')}] by=${by} reason="${reason}" edges(rewritten=${totalEdgesRewritten} merged=${totalEdgesMerged} deleted=${totalEdgesDeleted})`,
    );
    return {
      canonicalId: opts.canonicalId,
      mergedAliasIds,
      totalEdgesRewritten,
      totalEdgesMerged,
      totalEdgesDeleted,
    };
  }

  /**
   * 修改 entity 的 kind（topic/place/thing/work）。轻量操作，仅写入字段 + audit。
   * 不变更 id，所有引用边 0 风险。
   */
  async changeEntityKind(opts: {
    entityId: string;
    newKind: EntityKind;
    reason: string;
    by?: string;
  }): Promise<{ entityId: string; from: EntityKind; to: EntityKind }> {
    const reason = opts.reason?.trim().slice(0, 120);
    if (!reason) throw new Error('changeEntityKind: reason 必填');
    const by = opts.by ?? 'manual';
    const valid: EntityKind[] = ['topic', 'place', 'thing', 'work'];
    if (!valid.includes(opts.newKind)) {
      throw new Error(`changeEntityKind: newKind 必须是 ${valid.join('/')}`);
    }
    const node = await this.store.getEntity(opts.entityId);
    if (!node) throw new Error(`changeEntityKind: entity ${opts.entityId} 不存在`);
    const from = node.entityKind;
    if (from === opts.newKind) return { entityId: opts.entityId, from, to: opts.newKind };
    await this.store.upsertEntity({ ...node, entityKind: opts.newKind, lastReinforcedAt: Date.now() });
    this._audit(
      `[user-relation][AUDIT] changeEntityKind id=${opts.entityId} name="${node.name}" ${from}→${opts.newKind} by=${by} reason="${reason}"`,
    );
    return { entityId: opts.entityId, from, to: opts.newKind };
  }

  /**
   * 计算单个节点的「综合活跃度评分 + 排名 + 分级」，供 agent 快速判断节点份量。
   *
   * 返回字段语义：
   *   - compositeScore: 0..1 综合分（pagerank 0.4 + edgeWeight 0.3 + recency 0.2 + degree 0.1）
   *   - tier: 'core' | 'active' | 'normal' | 'edge'，绝对分 + 同 kind 百分位双门槛分级
   *   - rankInKind / rankInGlobal: 'k/N' 字符串，按 compositeScore 降序，1=最高
   *   - percentileInKind / percentileInGlobal: 0..1，0.95=前 5%，越大越中心
   *   - pagerankFresh: false=节点从未参与过 PR 计算（lastPageRankAt=0），pagerank=0 不代表"边缘"
   *   - 其它字段：相关邻居计数 / 入边权 / pagerank 快照 / evidence 数 / 距上次强化天数
   *
   * 复杂度：O(N) 全图扫描，N=节点总数（几百到几千可接受；如果发现卡顿可加节点缓存）。
   */
  async computeNodeScore(nodeId: string): Promise<{
    nodeId: string;
    kind: 'person' | 'event' | 'entity';
    name: string;
    relatedPeople: number;
    relatedEvents: number;
    relatedEntities: number;
    maxIncomingEdgeWeight: number;
    avgIncomingEdgeWeight: number;
    pagerank: number;
    pagerankFresh: boolean;
    evidenceCount: number;
    daysSinceLastReinforced: number;
    compositeScore: number;
    tier: 'core' | 'active' | 'normal' | 'edge';
    rankInKind: string;
    rankInGlobal: string;
    percentileInKind: number;
    percentileInGlobal: number;
  } | null> {
    const snap = await this.store.loadAll();
    const target = this._computeSingleNodeScore(nodeId, snap);
    if (!target) return null;

    // 全图排名：对每个节点算一次 compositeScore 并按 kind/全局排序。
    const allScores: { id: string; kind: 'person' | 'event' | 'entity'; score: number }[] = [];
    for (const p of snap.persons) {
      const s = this._computeSingleNodeScore(p.id, snap);
      if (s) allScores.push({ id: p.id, kind: 'person', score: s.compositeScore });
    }
    for (const e of snap.events) {
      const s = this._computeSingleNodeScore(e.id, snap);
      if (s) allScores.push({ id: e.id, kind: 'event', score: s.compositeScore });
    }
    for (const e of snap.entities) {
      const s = this._computeSingleNodeScore(e.id, snap);
      if (s) allScores.push({ id: e.id, kind: 'entity', score: s.compositeScore });
    }
    const sameKind = allScores.filter(s => s.kind === target.kind).sort((a, b) => b.score - a.score);
    const global = [...allScores].sort((a, b) => b.score - a.score);
    const rankK = sameKind.findIndex(s => s.id === nodeId) + 1;
    const rankG = global.findIndex(s => s.id === nodeId) + 1;
    const percentileInKind =
      sameKind.length > 1 ? Number(((sameKind.length - rankK) / (sameKind.length - 1)).toFixed(4)) : 1;
    const percentileInGlobal =
      global.length > 1 ? Number(((global.length - rankG) / (global.length - 1)).toFixed(4)) : 1;
    const tier = scoreToTier(target.compositeScore, percentileInKind);

    return {
      ...target,
      tier,
      rankInKind: `${rankK}/${sameKind.length}`,
      rankInGlobal: `${rankG}/${global.length}`,
      percentileInKind,
      percentileInGlobal,
    };
  }

  /**
   * 内部：单节点综合分计算（不含排名）。抽出复用：computeNodeScore 与 actions graph_data。
   */
  _computeSingleNodeScore(
    nodeId: string,
    snap: { persons: PersonNode[]; events: EventNode[]; entities: EntityNode[]; edges: RelationEdge[] },
  ): {
    nodeId: string;
    kind: 'person' | 'event' | 'entity';
    name: string;
    relatedPeople: number;
    relatedEvents: number;
    relatedEntities: number;
    maxIncomingEdgeWeight: number;
    avgIncomingEdgeWeight: number;
    pagerank: number;
    pagerankFresh: boolean;
    evidenceCount: number;
    daysSinceLastReinforced: number;
    compositeScore: number;
  } | null {
    let kind: 'person' | 'event' | 'entity' | null = null;
    let name = '';
    let evidenceCount = 0;
    let lastReinforcedAt = 0;
    let pagerank = 0;
    let pagerankAt = 0;

    const person = snap.persons.find(p => p.id === nodeId);
    if (person) {
      kind = 'person';
      name = person.displayName ?? person.id;
      evidenceCount = 0;
      lastReinforcedAt = person.lastSeenAt ?? person.firstSeenAt ?? 0;
      pagerank = person.lastPageRank ?? 0;
      pagerankAt = person.lastPageRankAt ?? 0;
    } else {
      const event = snap.events.find(e => e.id === nodeId);
      if (event) {
        kind = 'event';
        name = event.title;
        evidenceCount = event.evidence?.length ?? 0;
        lastReinforcedAt = event.lastReinforcedAt;
        pagerank = event.lastPageRank ?? 0;
        pagerankAt = event.lastPageRankAt ?? 0;
      } else {
        const entity = snap.entities.find(e => e.id === nodeId);
        if (entity) {
          kind = 'entity';
          name = entity.name;
          evidenceCount = entity.evidence?.length ?? 0;
          lastReinforcedAt = entity.lastReinforcedAt;
          pagerank = entity.lastPageRank ?? 0;
          pagerankAt = entity.lastPageRankAt ?? 0;
        }
      }
    }
    if (!kind) return null;

    const peopleSet = new Set<string>();
    const eventSet = new Set<string>();
    const entitySet = new Set<string>();
    let maxIncomingEdgeWeight = 0;
    let sumIncomingEdgeWeight = 0;
    let inEdgeCount = 0;

    const isPersonId = (id: string) => id.includes(':');
    for (const e of snap.edges) {
      if (!edgeReferences(e, nodeId)) continue;
      const toId = (e as { to?: string; toId?: string }).to ?? (e as { toId?: string }).toId ?? '';
      const fromId = (e as { from?: string; fromId?: string }).from ?? (e as { fromId?: string }).fromId ?? '';
      const otherId = fromId === nodeId ? toId : fromId;
      if (!otherId || otherId === nodeId) continue;
      if (isPersonId(otherId)) peopleSet.add(otherId);
      else if (snap.events.some(ev => ev.id === otherId)) eventSet.add(otherId);
      else if (snap.entities.some(et => et.id === otherId)) entitySet.add(otherId);
      if (toId === nodeId) {
        const w = e.weight ?? 0;
        if (w > maxIncomingEdgeWeight) maxIncomingEdgeWeight = w;
        sumIncomingEdgeWeight += w;
        inEdgeCount++;
      }
    }

    const avgIncomingEdgeWeight = inEdgeCount > 0 ? sumIncomingEdgeWeight / inEdgeCount : 0;
    const totalDegree = peopleSet.size + eventSet.size + entitySet.size;
    const daysSinceLastReinforced = lastReinforcedAt
      ? Math.max(0, (Date.now() - lastReinforcedAt) / 86400_000)
      : Number.POSITIVE_INFINITY;
    const prNorm = Math.min(1, pagerank * 10);
    const wNorm = Math.min(1, maxIncomingEdgeWeight);
    const recency = Number.isFinite(daysSinceLastReinforced) ? Math.exp(-daysSinceLastReinforced / 30) : 0;
    const degreeNorm = Math.min(1, totalDegree / 20);
    const compositeScore = Math.min(1, prNorm * 0.4 + wNorm * 0.3 + recency * 0.2 + degreeNorm * 0.1);

    return {
      nodeId,
      kind,
      name,
      relatedPeople: peopleSet.size,
      relatedEvents: eventSet.size,
      relatedEntities: entitySet.size,
      maxIncomingEdgeWeight: Number(maxIncomingEdgeWeight.toFixed(4)),
      avgIncomingEdgeWeight: Number(avgIncomingEdgeWeight.toFixed(4)),
      pagerank: Number(pagerank.toFixed(6)),
      pagerankFresh: pagerankAt > 0,
      evidenceCount,
      daysSinceLastReinforced: Number.isFinite(daysSinceLastReinforced)
        ? Number(daysSinceLastReinforced.toFixed(1))
        : -1,
      compositeScore: Number(compositeScore.toFixed(4)),
    };
  }

  /**
   * 计算节点的「有向出/入度剖面」，用于刻画粉丝/偶像、师徒上下游、因果 source/sink、part-of 上下游等
   * 单向语义信号。
   *
   * 仅统计 **有向的主体边**（person-person / event-event / entity-entity 且 directed=true）。
   * 桥型边（person-event / person-entity / event-entity）按设计天然双向，是"参与"不是"指代"，
   * 不计入此剖面。
   *
   * 返回的 `outByType` 含义：节点作为 from 端发出的边（"我主动指向谁"），按 relationType 分桶；
   * `inByType`：节点作为 to 端接收的边（"谁指向我"）。每个桶含 count / totalWeight / top-K 对端节点。
   *
   * `dominance` 启发式判断：
   * - outTotal - inTotal >= 2 且 outTotal/inTotal >= 1.5 → 'outgoing'（更偏向"主动方"，如典型粉丝/学生）
   * - inTotal - outTotal >= 2 且 inTotal/outTotal >= 1.5 → 'incoming'（更偏向"被指方"，如典型偶像/导师）
   * - 否则 'balanced'
   *
   * `fanIdolHint` 专门拎出 admirer 关系：fansCount = 入度 admirer（多少人 admire 我），
   * idolsCount = 出度 admirer（我 admire 多少人）。verdict 给出粗判。
   */
  async computeDirectionalDegree(
    nodeId: string,
    options: { topPerType?: number } = {},
  ): Promise<{
    nodeId: string;
    kind: 'person' | 'event' | 'entity';
    name: string;
    outTotal: number;
    inTotal: number;
    outByType: Record<
      string,
      {
        count: number;
        totalWeight: number;
        top: Array<{ otherId: string; otherName: string; weight: number; kind: 'person' | 'event' | 'entity' }>;
      }
    >;
    inByType: Record<
      string,
      {
        count: number;
        totalWeight: number;
        top: Array<{ otherId: string; otherName: string; weight: number; kind: 'person' | 'event' | 'entity' }>;
      }
    >;
    dominance: 'outgoing' | 'incoming' | 'balanced';
    fanIdolHint: { fansCount: number; idolsCount: number; verdict: 'idol-leaning' | 'fan-leaning' | 'mutual' | 'none' };
  } | null> {
    const topPerType = Math.max(1, Math.min(20, options.topPerType ?? 5));
    const snap = await this.store.loadAll();

    let kind: 'person' | 'event' | 'entity' | null = null;
    let name = '';
    const person = snap.persons.find(p => p.id === nodeId);
    if (person) {
      kind = 'person';
      name = person.displayName ?? person.id;
    } else {
      const ev = snap.events.find(e => e.id === nodeId);
      if (ev) {
        kind = 'event';
        name = ev.title;
      } else {
        const ent = snap.entities.find(e => e.id === nodeId);
        if (ent) {
          kind = 'entity';
          name = ent.name;
        }
      }
    }
    if (!kind) return null;

    const nodeKindOf = (id: string): 'person' | 'event' | 'entity' | null => {
      if (id.includes(':')) return snap.persons.some(p => p.id === id) ? 'person' : null;
      if (snap.events.some(e => e.id === id)) return 'event';
      if (snap.entities.some(e => e.id === id)) return 'entity';
      return null;
    };
    const nodeNameOf = (id: string, k: 'person' | 'event' | 'entity'): string => {
      if (k === 'person') return snap.persons.find(p => p.id === id)?.displayName ?? id;
      if (k === 'event') return snap.events.find(e => e.id === id)?.title ?? id;
      return snap.entities.find(e => e.id === id)?.name ?? id;
    };

    type Bucket = Map<
      string,
      { count: number; totalWeight: number; items: Array<{ otherId: string; weight: number }> }
    >;
    const outBuckets: Bucket = new Map();
    const inBuckets: Bucket = new Map();

    const add = (bucket: Bucket, relType: string, otherId: string, weight: number): void => {
      let b = bucket.get(relType);
      if (!b) {
        b = { count: 0, totalWeight: 0, items: [] };
        bucket.set(relType, b);
      }
      b.count += 1;
      b.totalWeight += weight;
      b.items.push({ otherId, weight });
    };

    for (const e of snap.edges) {
      // 仅有向的主体边
      if (e.kind === 'person-person' && e.directed) {
        if (e.fromPersonId === nodeId) add(outBuckets, e.relationType, e.toPersonId, e.weight ?? 0);
        else if (e.toPersonId === nodeId) add(inBuckets, e.relationType, e.fromPersonId, e.weight ?? 0);
      } else if (e.kind === 'event-event' && e.directed) {
        if (e.fromEventId === nodeId) add(outBuckets, e.relationType, e.toEventId, e.weight ?? 0);
        else if (e.toEventId === nodeId) add(inBuckets, e.relationType, e.fromEventId, e.weight ?? 0);
      } else if (e.kind === 'entity-entity' && e.directed) {
        if (e.fromEntityId === nodeId) add(outBuckets, e.relationType, e.toEntityId, e.weight ?? 0);
        else if (e.toEntityId === nodeId) add(inBuckets, e.relationType, e.fromEntityId, e.weight ?? 0);
      }
    }

    const serialize = (
      bucket: Bucket,
    ): Record<
      string,
      {
        count: number;
        totalWeight: number;
        top: Array<{ otherId: string; otherName: string; weight: number; kind: 'person' | 'event' | 'entity' }>;
      }
    > => {
      const out: Record<
        string,
        {
          count: number;
          totalWeight: number;
          top: Array<{ otherId: string; otherName: string; weight: number; kind: 'person' | 'event' | 'entity' }>;
        }
      > = {};
      for (const [relType, b] of bucket) {
        const sorted = b.items
          .slice()
          .sort((a, c) => c.weight - a.weight)
          .slice(0, topPerType);
        out[relType] = {
          count: b.count,
          totalWeight: Number(b.totalWeight.toFixed(4)),
          top: sorted
            .map(it => {
              const k = nodeKindOf(it.otherId);
              if (!k) return null;
              return {
                otherId: it.otherId,
                otherName: nodeNameOf(it.otherId, k),
                weight: Number(it.weight.toFixed(4)),
                kind: k,
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null),
        };
      }
      return out;
    };

    let outTotal = 0;
    let inTotal = 0;
    for (const b of outBuckets.values()) outTotal += b.count;
    for (const b of inBuckets.values()) inTotal += b.count;

    let dominance: 'outgoing' | 'incoming' | 'balanced' = 'balanced';
    if (outTotal - inTotal >= 2 && outTotal >= 1.5 * Math.max(1, inTotal)) dominance = 'outgoing';
    else if (inTotal - outTotal >= 2 && inTotal >= 1.5 * Math.max(1, outTotal)) dominance = 'incoming';

    const fansCount = inBuckets.get('admirer')?.count ?? 0;
    const idolsCount = outBuckets.get('admirer')?.count ?? 0;
    let verdict: 'idol-leaning' | 'fan-leaning' | 'mutual' | 'none' = 'none';
    if (fansCount === 0 && idolsCount === 0) verdict = 'none';
    else if (fansCount >= idolsCount + 2) verdict = 'idol-leaning';
    else if (idolsCount >= fansCount + 2) verdict = 'fan-leaning';
    else verdict = 'mutual';

    return {
      nodeId,
      kind,
      name,
      outTotal,
      inTotal,
      outByType: serialize(outBuckets),
      inByType: serialize(inBuckets),
      dominance,
      fanIdolHint: { fansCount, idolsCount, verdict },
    };
  }

  /**
   * 同社群活跃成员（Louvain 社群标签由 evictByQuota 写入；未跑过则返回空）。
   *
   * 用途：profile 注入 / agent 工具——「跟 X 同一个圈子的高活跃成员是谁」。
   *
   * - personId 必须是 `<platform>:<userId>` 完整 ID；
   * - 仅返回 person 类型的同社群成员（事件/实体也有 communityId 但用户视角无意义）；
   * - 按 lastPageRank desc 排序，截断到 limit；
   * - 自己不会出现在结果里；
   * - 如果 personId 没有 communityId（节点太新或从未跑过 evict）→ communitySize=0、peers=[]。
   */
  async getCommunityPeers(
    personId: string,
    limit = 5,
  ): Promise<{
    personId: string;
    communityId: string | null;
    communitySize: number;
    peers: Array<{ id: string; displayName: string; pagerank: number; communityId: string }>;
  }> {
    const snap = await this.store.loadAll();
    const me = snap.persons.find(p => p.id === personId);
    if (!me?.communityId) {
      return { personId, communityId: me?.communityId ?? null, communitySize: 0, peers: [] };
    }
    const cid = me.communityId;
    const same = snap.persons.filter(p => p.communityId === cid && p.id !== personId);
    const ranked = same.slice().sort((a, b) => (b.lastPageRank ?? 0) - (a.lastPageRank ?? 0));
    const peers = ranked.slice(0, Math.max(1, Math.min(limit, 20))).map(p => ({
      id: p.id,
      displayName: p.displayName ?? p.id,
      pagerank: Number((p.lastPageRank ?? 0).toFixed(6)),
      communityId: cid,
    }));
    // communitySize 含自己
    return { personId, communityId: cid, communitySize: same.length + 1, peers };
  }

  /**
   * 两人是否同社群 + 各自社群信息（agent 工具 community_bridge 用）。
   *
   * 不算路径——find_path 已有同等能力，重复实现徒增维护。
   */
  async getCommunityBridge(
    personAId: string,
    personBId: string,
  ): Promise<{
    a: { id: string; displayName: string; communityId: string | null; communitySize: number };
    b: { id: string; displayName: string; communityId: string | null; communitySize: number };
    sameCommunity: boolean;
  }> {
    const snap = await this.store.loadAll();
    const pa = snap.persons.find(p => p.id === personAId);
    const pb = snap.persons.find(p => p.id === personBId);
    const sizeOf = (cid: string | null | undefined): number => {
      if (!cid) return 0;
      return snap.persons.filter(p => p.communityId === cid).length;
    };
    return {
      a: {
        id: personAId,
        displayName: pa?.displayName ?? personAId,
        communityId: pa?.communityId ?? null,
        communitySize: sizeOf(pa?.communityId),
      },
      b: {
        id: personBId,
        displayName: pb?.displayName ?? personBId,
        communityId: pb?.communityId ?? null,
        communitySize: sizeOf(pb?.communityId),
      },
      sameCommunity: !!pa?.communityId && pa.communityId === pb?.communityId,
    };
  }

  /**
   * 全图社群概览：按 community 分组，每组列 top 成员/话题/事件，再算 modularity Q 和"桥梁人"。
   *
   * 设计要点：
   * - `algorithm` 不传默认实时跑一遍 Louvain；传 'leiden' 跑 Leiden-lite；传 'slpa' 跑 SLPA（原生重叠）。
   *   **不读节点上的 communityId 缓存**，保证每次调用结果与当前快照严格一致（即使 evictByQuota 还没跑）。
   * - `sessionScope` 是**后过滤**：先在全图上跑社群算法（保证社群划分准确），再只统计 evidence 含该 scope
   *   的节点，避免把"跨群关系"切断。
   * - 每个节点的**分组归属**始终按"主社群"（memberships[0].id，即 SLPA 下 weight 最高的 label）；
   *   保持 topMembers/Topics/Events 语义清晰，避免一个节点在多社群重复出现稀释 LLM 注意力。
   * - `topN`：每个社群展示的成员/话题/事件条数。默认动态：log2 自适应。传 0 = 不限。
   * - `bridges`：跨社群联系最广的 top-K person。`crossCommunityDegree` = 邻居中不在该 person 自身**任一**社群
   *   隶属里的"外社群"个数（SLPA 下自然把跨群人物的多归属考虑进去）；`communityWeights` 给出按"外社群"分组的
   *   邻居边权累计（边越重 / 邻居越多 → weight 越大），供 LLM 判断该桥梁人物的跨群强度分布。
   *
   * Q（modularity）值粗判：Q > 0.3 = 圈子分明；0.1 ~ 0.3 = 一般；< 0.1 = 接近随机划分。
   * SLPA 下 Q 用"主社群"作为硬划分近似计算，仅作参考——重叠社区没有标准 modularity 定义。
   */
  async getCommunityOverview(opts?: {
    sessionScope?: string;
    /** 0 = 不限 */
    topN?: number;
    /** 不传则跑 louvain；可临时切 leiden 或 slpa */
    algorithm?: 'louvain' | 'leiden' | 'slpa';
    /**
     * Louvain/Leiden 分辨率 γ：默认 1.0（标准模块度）。
     * - γ > 1：划得更细 → 社群数变多、单社群更小
     * - γ < 1：划得更粗 → 社群数变少、单社群更大
     * 常用范围 0.5 ~ 3.0。超出 [0.01, 100] 会被夹紧。
     * **SLPA 不使用该参数**（SLPA 的粒度由阈值 r 控制，本服务暂不暴露）。
     *
     * 传 `'auto'` 启用图规模自适应（推荐）：γ = clamp(0.6, 2.5, 0.5 + log10(n / 30))。
     * 详见 `computeAdaptiveResolution`。数值默认仍为 1.0，向后兼容。
     */
    resolution?: number | 'auto';
  }): Promise<{
    algorithm: 'louvain' | 'leiden' | 'slpa';
    /**
     * 本次实际生效的 γ。SLPA 下为 `null`（不使用）。
     * `resolutionMode='auto'` 时为 `computeAdaptiveResolution(snap)` 的输出；
     * `'explicit'` 时为调用方传入的数值；`'default'` 时为 1.0。
     */
    effectiveResolution: number | null;
    resolutionMode: 'auto' | 'explicit' | 'default';
    numCommunities: number;
    /** SLPA 下基于主社群的硬划分近似 modularity，仅供参考。 */
    modularity: number;
    totalPersonsInScope: number;
    totalEventsInScope: number;
    totalEntitiesInScope: number;
    communities: Array<{
      communityId: string;
      size: number;
      topMembers: Array<{ id: string; displayName: string; pagerank: number }>;
      topTopics: Array<{ id: string; name: string; pagerank: number }>;
      topEvents: Array<{ id: string; title: string; weight: number; sessionScope?: string }>;
    }>;
    bridges: Array<{
      id: string;
      displayName: string;
      /** 该 person 自身的主社群（SLPA 下即权重最高的 label） */
      communityId: string;
      /** SLPA 下该 person 的全部社群隶属度（按 weight 降序）；louvain/leiden 永远单元素 */
      communityMemberships: CommunityMembership[];
      /** 邻居中不在自身任一社群隶属里的"外社群"个数（向下兼容老消费方） */
      crossCommunityDegree: number;
      /**
       * 按"外社群"分组的邻居边权累计（按 weight 降序）。weight = ∑(邻居边权 × 邻居在该外社群的隶属度)。
       * 用这个字段判断桥梁人物在每个跨群方向上的强度分布；degree 只告诉数量，weights 告诉力度。
       */
      communityWeights: Array<{ communityId: string; weight: number }>;
    }>;
  }> {
    const snap = await this.store.loadAll();
    const alg: 'louvain' | 'leiden' | 'slpa' = opts?.algorithm ?? 'louvain';
    const resolutionMode: 'auto' | 'explicit' | 'default' =
      opts?.resolution === 'auto' ? 'auto' : opts?.resolution !== undefined ? 'explicit' : 'default';
    const resolution = opts?.resolution === 'auto' ? computeAdaptiveResolution(snap) : opts?.resolution;
    const effectiveResolution: number | null = alg === 'slpa' ? null : (resolution ?? 1.0);
    // 统一到 Map<nodeId, CommunityMembership[]>（按 weight 降序，memberships[0] = 主社群）
    let memberships: Map<string, CommunityMembership[]>;
    if (alg === 'slpa') {
      memberships = computeSlpa(snap);
    } else {
      const com = alg === 'leiden' ? computeLeiden(snap, { resolution }) : computeLouvain(snap, { resolution });
      memberships = new Map();
      for (const [id, cid] of com) memberships.set(id, [{ id: cid, weight: 1 }]);
    }
    // 主社群映射（用于分组与 modularity 近似计算）
    const primary = new Map<string, string>();
    for (const [id, list] of memberships) {
      if (list.length > 0) primary.set(id, list[0].id);
    }
    const modularity = computeModularity(snap, primary);

    // topN 解析（保持原逻辑）
    const rawTopN = opts?.topN;
    const useAdaptive = rawTopN === undefined;
    const fixedCap =
      rawTopN === 0
        ? Number.MAX_SAFE_INTEGER
        : rawTopN !== undefined
          ? Math.max(1, Math.min(rawTopN, 2000))
          : Number.MAX_SAFE_INTEGER;
    const adaptiveTopN = (size: number) => Math.max(3, Math.ceil(Math.log2(Math.max(size, 1) + 1)));

    // sessionScope 后过滤
    const scope = opts?.sessionScope;
    const inScopeEvent = (ev: (typeof snap.events)[number]): boolean => {
      if (!scope) return true;
      return ev.sessionScope === scope;
    };
    const inScopeEntity = (en: (typeof snap.entities)[number]): boolean => {
      if (!scope) return true;
      return en.evidence.some(e => e.sessionId === scope);
    };
    const eventsInScope = snap.events.filter(inScopeEvent);
    const entitiesInScope = snap.entities.filter(inScopeEntity);
    let personsInScope: typeof snap.persons;
    if (!scope) {
      personsInScope = snap.persons;
    } else {
      const scopeEventIds = new Set(eventsInScope.map(e => e.id));
      const scopePersonIds = new Set<string>();
      for (const e of snap.edges) {
        if (e.kind === 'person-event' && scopeEventIds.has(e.toEventId)) {
          scopePersonIds.add(e.fromPersonId);
        }
      }
      personsInScope = snap.persons.filter(p => scopePersonIds.has(p.id));
    }
    const inScopePerson = (p: (typeof snap.persons)[number]): boolean => {
      if (!scope) return true;
      return personsInScope.includes(p);
    };

    // 按 community 分组（用 primary 主社群，避免一节点重复列在多社群）
    const personsByCom = new Map<string, typeof personsInScope>();
    const eventsByCom = new Map<string, typeof eventsInScope>();
    const entitiesByCom = new Map<string, typeof entitiesInScope>();
    for (const p of personsInScope) {
      const c = primary.get(p.id);
      if (!c) continue;
      if (!personsByCom.has(c)) personsByCom.set(c, []);
      personsByCom.get(c)!.push(p);
    }
    for (const ev of eventsInScope) {
      const c = primary.get(ev.id);
      if (!c) continue;
      if (!eventsByCom.has(c)) eventsByCom.set(c, []);
      eventsByCom.get(c)!.push(ev);
    }
    for (const en of entitiesInScope) {
      const c = primary.get(en.id);
      if (!c) continue;
      if (!entitiesByCom.has(c)) entitiesByCom.set(c, []);
      entitiesByCom.get(c)!.push(en);
    }

    const allCommunityIds = Array.from(
      new Set<string>([...personsByCom.keys(), ...eventsByCom.keys(), ...entitiesByCom.keys()]),
    );
    allCommunityIds.sort((a, b) => (personsByCom.get(b)?.length ?? 0) - (personsByCom.get(a)?.length ?? 0));

    const communities = allCommunityIds.map(cid => {
      const members = (personsByCom.get(cid) ?? [])
        .slice()
        .sort((a, b) => (b.lastPageRank ?? 0) - (a.lastPageRank ?? 0));
      const topics = (entitiesByCom.get(cid) ?? [])
        .slice()
        .sort((a, b) => (b.lastPageRank ?? 0) - (a.lastPageRank ?? 0));
      const events = (eventsByCom.get(cid) ?? []).slice().sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      const comTotal = members.length + topics.length + events.length;
      const perComTopN = useAdaptive ? adaptiveTopN(comTotal) : fixedCap;
      return {
        communityId: cid,
        size: members.length,
        topMembers: members.slice(0, perComTopN).map(p => ({
          id: p.id,
          displayName: p.displayName ?? p.id,
          pagerank: Number((p.lastPageRank ?? 0).toFixed(6)),
        })),
        topTopics: topics.slice(0, perComTopN).map(en => ({
          id: en.id,
          name: en.name,
          pagerank: Number((en.lastPageRank ?? 0).toFixed(6)),
        })),
        topEvents: events.slice(0, perComTopN).map(ev => ({
          id: ev.id,
          title: ev.title ?? ev.id,
          weight: Number((ev.weight ?? 0).toFixed(4)),
          ...(ev.sessionScope ? { sessionScope: ev.sessionScope } : {}),
        })),
      };
    });

    // bridges：对每个 person，累计"邻居外社群"的边权
    //   外社群定义：邻居的某社群隶属 ∉ 该 person 自身的 memberships id 集合
    //   weight = ∑(edge_weight × 邻居在该外社群的隶属度)
    //   - louvain/leiden 下邻居隶属永远 1，退化为"邻居的边权 × 1"，等价于老语义但带权重
    //   - SLPA 下能反映邻居的多重身份对该 person 跨群强度的真实贡献
    // 邻接：person-person 直接 + person-event-person 二跳 + person-entity-person 二跳（与原实现一致，仅升级权重）
    type PersonNbrs = Map<string, number>; // otherPersonId → 累计边权（无向）
    const personNbrs = new Map<string, PersonNbrs>();
    const ensureNbrs = (id: string): PersonNbrs => {
      let m = personNbrs.get(id);
      if (!m) {
        m = new Map();
        personNbrs.set(id, m);
      }
      return m;
    };
    const addNbr = (a: string, b: string, w: number) => {
      if (a === b) return;
      const ma = ensureNbrs(a);
      ma.set(b, (ma.get(b) ?? 0) + w);
      const mb = ensureNbrs(b);
      mb.set(a, (mb.get(a) ?? 0) + w);
    };
    // 直连 person-person
    for (const e of snap.edges) {
      if (e.kind === 'person-person') {
        addNbr(e.fromPersonId, e.toPersonId, Math.max(e.weight ?? 0.5, 0.05));
      }
    }
    // 通过 event 二跳：同 event 下任意两人配对
    const personsByEvent = new Map<string, Array<{ id: string; w: number }>>();
    for (const e of snap.edges) {
      if (e.kind === 'person-event') {
        const arr = personsByEvent.get(e.toEventId) ?? [];
        arr.push({ id: e.fromPersonId, w: Math.max(e.weight ?? 0.5, 0.05) });
        personsByEvent.set(e.toEventId, arr);
      }
    }
    for (const arr of personsByEvent.values()) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          // 二跳边权取两端 min（更保守，避免热点事件把边权放大）
          addNbr(arr[i].id, arr[j].id, Math.min(arr[i].w, arr[j].w));
        }
      }
    }
    // 通过 entity 二跳：同 entity 下任意两人配对
    const personsByEntity = new Map<string, Array<{ id: string; w: number }>>();
    for (const e of snap.edges) {
      if (e.kind === 'person-entity') {
        const arr = personsByEntity.get(e.toEntityId) ?? [];
        arr.push({ id: e.fromPersonId, w: Math.max(e.weight ?? 0.5, 0.05) });
        personsByEntity.set(e.toEntityId, arr);
      }
    }
    for (const arr of personsByEntity.values()) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          addNbr(arr[i].id, arr[j].id, Math.min(arr[i].w, arr[j].w));
        }
      }
    }

    const personById = new Map(snap.persons.map(p => [p.id, p]));
    const bridgeArr: Array<{
      id: string;
      displayName: string;
      communityId: string;
      communityMemberships: CommunityMembership[];
      crossCommunityDegree: number;
      communityWeights: Array<{ communityId: string; weight: number }>;
    }> = [];
    for (const [pid, nbrs] of personNbrs) {
      const p = personById.get(pid);
      if (!p) continue;
      if (scope && !inScopePerson(p)) continue;
      const myList = memberships.get(pid) ?? [];
      if (myList.length === 0) continue;
      const myCom = new Set(myList.map(m => m.id));
      // 累计邻居外社群的加权得分
      const weightByCom = new Map<string, number>();
      for (const [nbId, edgeW] of nbrs) {
        const nbList = memberships.get(nbId);
        if (!nbList || nbList.length === 0) continue;
        for (const m of nbList) {
          if (myCom.has(m.id)) continue; // 跳过自身社群
          weightByCom.set(m.id, (weightByCom.get(m.id) ?? 0) + edgeW * m.weight);
        }
      }
      if (weightByCom.size === 0) continue;
      const communityWeights = [...weightByCom.entries()]
        .map(([communityId, weight]) => ({ communityId, weight: Number(weight.toFixed(4)) }))
        .sort((a, b) => b.weight - a.weight);
      bridgeArr.push({
        id: pid,
        displayName: p.displayName ?? pid,
        communityId: myList[0].id,
        communityMemberships: myList,
        crossCommunityDegree: communityWeights.length,
        communityWeights,
      });
    }
    // 按"跨群总权重"降序排（不再只看 degree 数量，权重更能反映强度）
    bridgeArr.sort((a, b) => {
      const sa = a.communityWeights.reduce((s, w) => s + w.weight, 0);
      const sb = b.communityWeights.reduce((s, w) => s + w.weight, 0);
      return sb - sa;
    });

    const bridgesTopN = useAdaptive
      ? Math.max(3, Math.ceil(Math.log2(Math.max(personsInScope.length, 1) + 1)))
      : fixedCap;

    return {
      algorithm: alg,
      effectiveResolution,
      resolutionMode,
      numCommunities: allCommunityIds.length,
      modularity: Number(modularity.toFixed(4)),
      totalPersonsInScope: personsInScope.length,
      totalEventsInScope: eventsInScope.length,
      totalEntitiesInScope: entitiesInScope.length,
      communities,
      bridges: bridgeArr.slice(0, bridgesTopN),
    };
  }
}

/**
 * compositeScore + 同 kind 百分位双门槛分级。绝对分给"够亮"的小图节点保底，
 * 百分位给"大图但绝对分都低"的相对核心节点保底。
 */
export function scoreToTier(score: number, percentile: number): 'core' | 'active' | 'normal' | 'edge' {
  if (score >= 0.6 || percentile >= 0.9) return 'core';
  if (score >= 0.4 || percentile >= 0.7) return 'active';
  if (score >= 0.2 || percentile >= 0.4) return 'normal';
  return 'edge';
}
