/**
 * RelationExtractor —— 监听对话归档事件，按"消息条数"触发 LLM 提取并写图。
 *
 * 触发模型（与 plugin-user-profile 思路一致，但 scope 为 sessionId 而非 user）：
 * - 监听 `inbound:message:archived`
 * - 内存维护 per-sessionId 的累计计数
 * - 累计到 `triggerEveryNMessages`（默认 20）触发一次
 * - 提取时读取最近 `readWindowSize`（默认 30）条 → 窗口与触发步长有意 overlap，
 *   让上一轮窗口尾部 ~10 条与本轮重合，形成"层叠上下文"，缓解 LLM
 *   对话题/关系单次识别不稳定的问题
 * - per-sessionId 在飞中标记：同一 session 同时只跑一次提取，避免风暴
 *
 * "all-new" 模式：把读窗口放大到 `allNewMaxMessages`，一次性消化所有累积；
 * 默认不启用（容易超 context window）。
 *
 * LLM 集成：用 `resolveLLMModel(ctx, cfg.extractionModel)` 拿模型 entry；
 * cfg.extractionModel 为空时退化到默认 'llm' service。
 */
import type { Context } from '@aalis/core';
import { LLMCapabilities, type LLMModel, type ModelRef, resolveLLMModel } from '@aalis/plugin-llm-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { Message } from '@aalis/plugin-message-api';
import type { RelationService } from './service.js';
import type {
  EntityKind,
  EntityNode,
  EventCategory,
  EventNode,
  EvidenceRef,
  PersonEntityRole,
  PersonEventRole,
  PersonNode,
  RelationEdge,
  Sentiment,
} from './types.js';
import {
  RecommendedEntityEntityRelationTypes,
  RecommendedEventEntityRelationTypes,
  RecommendedEventEventRelationTypes,
  RecommendedPersonRelationTypes,
} from './types.js';

export interface ExtractorConfig {
  triggerEveryNMessages: number;
  readWindowSize: number;
  mode: 'incremental' | 'all-new';
  allNewMaxMessages: number;
  /** 提取时把"最近 N 天的活跃事件"作为候选清单交给 LLM 复用 */
  candidateEventDays: number;
  candidateEventLimit: number;
  /** 提取时，对窗口内每位已知发言人附带其 1 跳邻居子图（已关联的事件/实体/人际关系，按权重降序），上限条数。0=关闭 */
  senderNeighborhoodEdgeLimit: number;
  /** LLM model 引用；为空走默认 'llm' service */
  extractionModel?: ModelRef;
  /** 是否禁用思考模式（思考型模型上）。提取是结构化输出任务，默认禁用以避免 budget 被 reasoning 吃掉 */
  disableThinking: boolean;
  /** 严格自证：每条 person-* 边必须有 evidence 且 evidence.messageId.sender == fromPersonId */
  strictSelfAssertion: boolean;
  /** 自动老化：每次写入完成后扫一遍并按 quota 删除（profile 风格，不开调度器）。默认 true。 */
  evictionEnabled: boolean;
  /** 事件节点总数上限；超过则按 (age/weight) 排序删除老旧低权重节点。0=不限。 */
  maxEvents: number;
  /** 实体节点总数上限。0=不限。 */
  maxEntities: number;
  /** 边总数上限（保留 weight 最高的）。0=不限。 */
  maxEdges: number;
  /** debug 日志 */
  debug: boolean;
}

interface ArchivedEventData {
  sessionId: string;
  incoming: {
    sessionId: string;
    platform?: string;
    sessionType?: string;
  };
  archivedMessage: Message;
}

/** 单个候选人 1 跳邻居子图视图（已按 weight 降序截断）。 */
interface SenderNeighborhood {
  personId: string;
  platform: string;
  userId: string;
  nickname?: string;
  edges: RelationEdge[];
  eventById: Map<string, EventNode>;
  entityById: Map<string, EntityNode>;
  personById: Map<string, PersonNode>;
}

interface LLMExtraction {
  persons?: Array<{ platform: string; userId: string; displayName?: string }>;
  events?: Array<{
    refKey: string;
    existingEventId?: string | null;
    title: string;
    summary?: string;
    category?: string;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  entities?: Array<{
    refKey: string;
    existingEntityId?: string | null;
    name: string;
    aliases?: string[];
    summary?: string;
    entityKind?: string;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  personEventEdges?: Array<{
    personPlatform: string;
    personUserId: string;
    eventRefKey: string;
    role: string;
    sentiment?: string;
    description?: string;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  personEntityEdges?: Array<{
    personPlatform: string;
    personUserId: string;
    entityRefKey: string;
    role: string;
    sentiment?: string;
    description?: string;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  personPersonEdges?: Array<{
    fromPlatform: string;
    fromUserId: string;
    toPlatform: string;
    toUserId: string;
    relationType: string;
    directed?: boolean;
    description?: string;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  eventEventEdges?: Array<{
    fromEventRefKey: string;
    toEventRefKey: string;
    relationType: string;
    directed?: boolean;
    description?: string;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  eventEntityEdges?: Array<{
    eventRefKey: string;
    entityRefKey: string;
    relationType: string;
    description?: string;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  entityEntityEdges?: Array<{
    fromEntityRefKey: string;
    toEntityRefKey: string;
    relationType: string;
    directed?: boolean;
    description?: string;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
}

const VALID_ROLES: PersonEventRole[] = ['initiator', 'participant', 'witness', 'target', 'reporter'];
const VALID_SENTIMENTS: Sentiment[] = ['positive', 'negative', 'neutral', 'mixed'];
const VALID_CATEGORIES: EventCategory[] = ['discussion', 'conflict', 'collaboration', 'incident', 'milestone', 'other'];
const VALID_ENTITY_KINDS: EntityKind[] = ['topic', 'place', 'thing', 'work'];
const VALID_PERSON_ENTITY_ROLES: PersonEntityRole[] = [
  'enthusiast',
  'participant',
  'owner',
  'creator',
  'critic',
  'visitor',
  'mentioned',
];

export class RelationExtractor {
  private readonly counts = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private disposeListener?: () => void;

  constructor(
    private readonly ctx: Context,
    private readonly service: RelationService,
    private readonly cfg: ExtractorConfig,
  ) {}

  start(): void {
    const handler = (...args: unknown[]) => {
      const data = args[0] as ArchivedEventData | undefined;
      if (!data?.sessionId) return;
      const n = (this.counts.get(data.sessionId) ?? 0) + 1;
      this.counts.set(data.sessionId, n);
      if (this.cfg.triggerEveryNMessages <= 0) return;
      if (n % this.cfg.triggerEveryNMessages !== 0) return;
      void this.extractSession(data.sessionId).catch(err =>
        this.ctx.logger.debug(`[user-relation] 提取异常 session=${data.sessionId}: ${stringifyErr(err)}`),
      );
    };
    this.ctx.on('inbound:message:archived', handler);
    this.disposeListener = () => {
      // ctx.on 在 dispose 时已自动清理，这里仅做幂等占位
    };
  }

  stop(): void {
    this.disposeListener?.();
    this.counts.clear();
    this.inFlight.clear();
  }

  /** 手动触发某 session 的提取（用于 page-action 的"立即提取"按钮） */
  async triggerNow(sessionId: string): Promise<{ status: 'ok' | 'skipped' | 'error'; reason?: string }> {
    if (this.inFlight.has(sessionId)) return { status: 'skipped', reason: 'in-flight' };
    try {
      await this.extractSession(sessionId);
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', reason: stringifyErr(err) };
    }
  }

  private async extractSession(sessionId: string): Promise<void> {
    if (this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    try {
      const memory = this.ctx.getService<MemoryService>('memory');
      if (!memory?.getHistory) {
        if (this.cfg.debug) this.ctx.logger.debug('[user-relation] memory.getHistory 不可用，跳过');
        return;
      }
      const limit = this.cfg.mode === 'all-new' ? this.cfg.allNewMaxMessages : this.cfg.readWindowSize;
      const history = await memory.getHistory(sessionId, limit);
      const userMsgs = history.filter(m => m.role === 'user' && hasMessageId(m));
      if (userMsgs.length === 0) {
        if (this.cfg.debug) this.ctx.logger.debug(`[user-relation] ${sessionId} 窗口内无可提取消息`);
        return;
      }

      const modelEntry = resolveLLMModel(this.ctx, this.cfg.extractionModel, [LLMCapabilities.Chat]);
      if (!modelEntry) {
        if (this.cfg.debug) this.ctx.logger.debug('[user-relation] 未找到可用 LLM，跳过提取');
        return;
      }

      const platform = inferPlatform(userMsgs);
      const { candidateEvents, candidateEntities } = await this.pickCandidates();
      const senderNeighbors = await this.pickSenderNeighbors(userMsgs);
      const promptMessages = buildExtractionPrompt(
        history,
        userMsgs,
        candidateEvents,
        candidateEntities,
        senderNeighbors,
      );

      const raw = await callLLM(modelEntry.instance, promptMessages, this.cfg.disableThinking);
      const result = parseExtraction(raw);
      if (result.kind === 'parse-error') {
        this.ctx.logger.warn(
          `[user-relation] LLM 输出无法解析为 JSON（model=${modelEntry.contextId}）: ${raw.slice(0, 200)}`,
        );
        return;
      }
      if (result.kind === 'empty') {
        if (this.cfg.debug) {
          this.ctx.logger.debug(`[user-relation] ${sessionId} LLM 明确表示本批次无可提取`);
        }
        return;
      }

      await this.applyExtraction(result.value, { sessionId, platform, history });
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  /** 拉取近 N 天活跃事件 + 实体作为候选清单（缩短 LLM 上下文，避免重复创建） */
  private async pickCandidates(): Promise<{ candidateEvents: EventNode[]; candidateEntities: EntityNode[] }> {
    const snap = await this.service.loadAll();
    const cutoff = Date.now() - this.cfg.candidateEventDays * 86_400_000;
    const candidateEvents = snap.events
      .filter(e => e.lastReinforcedAt >= cutoff)
      .sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt)
      .slice(0, this.cfg.candidateEventLimit);
    // entities 复用同一份天数 / 上限 —— 实体一般比事件更长寿，给一倍 limit 上限
    const candidateEntities = snap.entities
      .filter(e => e.lastReinforcedAt >= cutoff)
      .sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt)
      .slice(0, this.cfg.candidateEventLimit * 2);
    return { candidateEvents, candidateEntities };
  }

  /**
   * 对窗口内每个已知发言人，拿其 1 跳邻居子图（按 weight 降序，截断到 N 条）。
   * 目的：让 LLM 在「加强已有 vs 新建」判断时手里有真证据，避免反复创建同一人 / 同一兴趣的重复节点。
   * 若 senderNeighborhoodEdgeLimit=0 或某 sender 在图中尚未存在，则跳过该 sender。
   */
  private async pickSenderNeighbors(userMsgs: Message[]): Promise<SenderNeighborhood[]> {
    const limit = this.cfg.senderNeighborhoodEdgeLimit;
    if (!limit || limit <= 0) return [];
    const senders = new Map<string, { platform: string; userId: string; nickname?: string }>();
    for (const m of userMsgs) {
      const meta = (m.metadata as { userId?: string; nickname?: string; platform?: string } | undefined) ?? {};
      if (!meta.userId || !meta.platform) continue;
      const key = `${meta.platform}:${meta.userId}`;
      if (!senders.has(key)) {
        senders.set(key, { platform: meta.platform, userId: meta.userId, nickname: meta.nickname });
      }
    }
    if (senders.size === 0) return [];
    const snapshot = await this.service.loadAll();
    const personById = new Map(snapshot.persons.map(p => [p.id, p]));
    const eventById = new Map(snapshot.events.map(e => [e.id, e]));
    const entityById = new Map(snapshot.entities.map(e => [e.id, e]));

    const out: SenderNeighborhood[] = [];
    for (const [key, s] of senders) {
      if (!personById.has(key)) continue; // 新人 — 无邻居可注入
      const edges = snapshot.edges.filter(e => {
        if (e.kind === 'person-event') return e.fromPersonId === key;
        if (e.kind === 'person-entity') return e.fromPersonId === key;
        if (e.kind === 'person-person') return e.fromPersonId === key || e.toPersonId === key;
        return false;
      });
      if (edges.length === 0) continue;
      // 按 weight 降序，取 top N
      const top = [...edges].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, limit);
      out.push({
        personId: key,
        platform: s.platform,
        userId: s.userId,
        nickname: s.nickname,
        edges: top,
        eventById,
        entityById,
        personById,
      });
    }
    return out;
  }

  /** 把 LLM 输出落到关系图中 */
  private async applyExtraction(
    parsed: LLMExtraction,
    ctxInfo: { sessionId: string; platform: string; history: Message[] },
  ): Promise<void> {
    const validMessageIds = new Set<string>();
    const contentBySid = new Map<string, string>();
    const senderBySid = new Map<string, string>(); // messageId -> "platform:userId"
    for (const m of ctxInfo.history) {
      const meta = (m.metadata as { messageId?: string; userId?: string; platform?: string } | undefined) ?? {};
      const sid = meta.messageId;
      if (sid) {
        validMessageIds.add(sid);
        contentBySid.set(sid, typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        if (m.role === 'user' && meta.userId) {
          senderBySid.set(sid, `${meta.platform ?? ctxInfo.platform}:${meta.userId}`);
        }
      }
    }
    const strict = this.cfg.strictSelfAssertion;
    /** 严格自证校验：evidence.messageIds 中是否有至少一条的 sender == fromPersonId */
    const isSelfAsserted = (fromPersonId: string, ev: EvidenceRef | null): boolean => {
      if (!ev) return false;
      for (const mid of ev.messageIds) {
        if (senderBySid.get(mid) === fromPersonId) return true;
      }
      return false;
    };
    const debugSkip = (label: string, reason: string) => {
      if (this.cfg.debug) this.ctx.logger.debug(`[user-relation] 严格自证丢弃 ${label}: ${reason}`);
    };
    const now = Date.now();
    const mkEvidence = (raw?: { messageIds?: string[]; quote?: string }): EvidenceRef | null => {
      if (!raw) return null;
      const ids = (raw.messageIds ?? []).filter(id => validMessageIds.has(id));
      if (ids.length === 0) return null;
      // quote 必须能在至少一条窗口消息里找到子串（去空白对齐），否则视为幻觉
      const quote = raw.quote?.trim();
      if (quote) {
        const normalizedQuote = quote.replace(/\s+/g, '');
        const ok = ids.some(id => (contentBySid.get(id) ?? '').replace(/\s+/g, '').includes(normalizedQuote));
        if (!ok) return null;
      }
      return {
        sessionId: ctxInfo.sessionId,
        messageIds: ids,
        quote,
        extractedAt: now,
      };
    };

    // 1) persons
    for (const p of parsed.persons ?? []) {
      if (!p.platform || !p.userId) continue;
      await this.service.observePerson(p.platform, p.userId, p.displayName);
    }

    // 2) events: refKey → real eventId
    const refToEventId = new Map<string, string>();
    for (const e of parsed.events ?? []) {
      if (!e.refKey || !e.title) continue;
      const ev = mkEvidence(e.evidence);
      const category = VALID_CATEGORIES.includes(e.category as EventCategory)
        ? (e.category as EventCategory)
        : undefined;
      let eventId: string | undefined;
      if (e.existingEventId) {
        const reinforced = await this.service.reinforceEvent(e.existingEventId, {
          title: e.title,
          summary: e.summary,
          category,
          evidence: ev ? [ev] : [],
        });
        if (reinforced) eventId = reinforced.id;
      }
      if (!eventId) {
        const created = await this.service.createEvent({
          title: e.title,
          summary: e.summary,
          category,
          evidence: ev ? [ev] : [],
        });
        eventId = created.id;
      }
      refToEventId.set(e.refKey, eventId);
    }

    // 2b) entities: refKey → real entityId
    const refToEntityId = new Map<string, string>();
    for (const e of parsed.entities ?? []) {
      if (!e.refKey || !e.name) continue;
      const ev = mkEvidence(e.evidence);
      const entityKind = VALID_ENTITY_KINDS.includes(e.entityKind as EntityKind)
        ? (e.entityKind as EntityKind)
        : 'topic';
      let entityId: string | undefined;
      // 优先尊重 LLM 指明的 existingEntityId；service.createEntity 内部已按 (kind,name) 强制去重
      if (e.existingEntityId) {
        const reinforced = await this.service.reinforceEntity(e.existingEntityId, {
          name: e.name,
          aliases: e.aliases,
          summary: e.summary,
          entityKind,
          evidence: ev ? [ev] : [],
        });
        if (reinforced) entityId = reinforced.id;
      }
      if (!entityId) {
        // createEntity 自身做 (kind, name) 去重；不再在 extractor 层重复
        const created = await this.service.createEntity({
          name: e.name,
          aliases: e.aliases,
          summary: e.summary,
          entityKind,
          evidence: ev ? [ev] : [],
        });
        entityId = created.id;
      }
      refToEntityId.set(e.refKey, entityId);
    }

    // 3) person-event edges
    for (const pe of parsed.personEventEdges ?? []) {
      const eventId = refToEventId.get(pe.eventRefKey);
      if (!eventId) continue;
      if (!pe.personPlatform || !pe.personUserId) continue;
      const role = VALID_ROLES.includes(pe.role as PersonEventRole) ? (pe.role as PersonEventRole) : 'participant';
      const sentiment = VALID_SENTIMENTS.includes(pe.sentiment as Sentiment) ? (pe.sentiment as Sentiment) : undefined;
      const ev = mkEvidence(pe.evidence);
      const fromPersonId = `${pe.personPlatform}:${pe.personUserId}`;
      if (strict && !isSelfAsserted(fromPersonId, ev)) {
        debugSkip('person-event', `from=${fromPersonId} 无本人 evidence`);
        continue;
      }
      await this.service.addPersonEventEdge({
        fromPersonId,
        toEventId: eventId,
        role,
        sentiment,
        description: pe.description,
        evidence: ev ? [ev] : [],
      });
    }

    // 3b) person-entity edges
    for (const pe of parsed.personEntityEdges ?? []) {
      const entityId = refToEntityId.get(pe.entityRefKey);
      if (!entityId) continue;
      if (!pe.personPlatform || !pe.personUserId) continue;
      const role = VALID_PERSON_ENTITY_ROLES.includes(pe.role as PersonEntityRole)
        ? (pe.role as PersonEntityRole)
        : 'mentioned';
      const sentiment = VALID_SENTIMENTS.includes(pe.sentiment as Sentiment) ? (pe.sentiment as Sentiment) : undefined;
      const ev = mkEvidence(pe.evidence);
      const fromPersonId = `${pe.personPlatform}:${pe.personUserId}`;
      if (strict && !isSelfAsserted(fromPersonId, ev)) {
        debugSkip('person-entity', `from=${fromPersonId} 无本人 evidence`);
        continue;
      }
      await this.service.addPersonEntityEdge({
        fromPersonId,
        toEntityId: entityId,
        role,
        sentiment,
        description: pe.description,
        evidence: ev ? [ev] : [],
      });
    }

    // 4) person-person edges
    for (const pp of parsed.personPersonEdges ?? []) {
      if (!pp.fromPlatform || !pp.fromUserId || !pp.toPlatform || !pp.toUserId || !pp.relationType) continue;
      if (pp.fromPlatform === pp.toPlatform && pp.fromUserId === pp.toUserId) continue; // 自环
      const ev = mkEvidence(pp.evidence);
      const fromPersonId = `${pp.fromPlatform}:${pp.fromUserId}`;
      const toPersonId = `${pp.toPlatform}:${pp.toUserId}`;
      if (strict && !isSelfAsserted(fromPersonId, ev)) {
        debugSkip('person-person', `from=${fromPersonId} 无本人 evidence`);
        continue;
      }
      try {
        await this.service.addPersonPersonEdge({
          fromPersonId,
          toPersonId,
          relationType: pp.relationType,
          directed: pp.directed,
          description: pp.description,
          evidence: ev ? [ev] : [],
        });
      } catch (err) {
        // to 不存在为 PersonNode → 防孤儿报错，这里静默跳过
        debugSkip('person-person', stringifyErr(err));
      }
    }

    // 5) event-event edges
    for (const ee of parsed.eventEventEdges ?? []) {
      const fromId = refToEventId.get(ee.fromEventRefKey);
      const toId = refToEventId.get(ee.toEventRefKey);
      if (!fromId || !toId || fromId === toId) continue;
      if (!ee.relationType) continue;
      const ev = mkEvidence(ee.evidence);
      await this.service.addEventEventEdge({
        fromEventId: fromId,
        toEventId: toId,
        relationType: ee.relationType,
        directed: ee.directed,
        description: ee.description,
        evidence: ev ? [ev] : [],
      });
    }

    // 5b) event-entity edges
    for (const ee of parsed.eventEntityEdges ?? []) {
      const eventId = refToEventId.get(ee.eventRefKey);
      const entityId = refToEntityId.get(ee.entityRefKey);
      if (!eventId || !entityId || !ee.relationType) continue;
      const ev = mkEvidence(ee.evidence);
      await this.service.addEventEntityEdge({
        fromEventId: eventId,
        toEntityId: entityId,
        relationType: ee.relationType,
        description: ee.description,
        evidence: ev ? [ev] : [],
      });
    }

    // 5c) entity-entity edges
    for (const ee of parsed.entityEntityEdges ?? []) {
      const fromId = refToEntityId.get(ee.fromEntityRefKey);
      const toId = refToEntityId.get(ee.toEntityRefKey);
      if (!fromId || !toId || fromId === toId || !ee.relationType) continue;
      const ev = mkEvidence(ee.evidence);
      try {
        await this.service.addEntityEntityEdge({
          fromEntityId: fromId,
          toEntityId: toId,
          relationType: ee.relationType,
          directed: ee.directed,
          description: ee.description,
          evidence: ev ? [ev] : [],
        });
      } catch (err) {
        debugSkip('entity-entity', stringifyErr(err));
      }
    }

    if (this.cfg.debug) {
      this.ctx.logger.debug(
        `[user-relation] ${ctxInfo.sessionId} 提取完成: persons=${parsed.persons?.length ?? 0}, events=${parsed.events?.length ?? 0}, entities=${parsed.entities?.length ?? 0}, pe=${parsed.personEventEdges?.length ?? 0}, pent=${parsed.personEntityEdges?.length ?? 0}, pp=${parsed.personPersonEdges?.length ?? 0}, ee=${parsed.eventEventEdges?.length ?? 0}, eent=${parsed.eventEntityEdges?.length ?? 0}, entent=${parsed.entityEntityEdges?.length ?? 0}`,
      );
    }

    // 写后顺手老化（模仿 profile 风格，不开独立调度器）。配额来自 cfg；任一为 0 跳过该维度。
    if (this.cfg.evictionEnabled && (this.cfg.maxEvents > 0 || this.cfg.maxEntities > 0 || this.cfg.maxEdges > 0)) {
      try {
        const evicted = await this.service.evictByQuota({
          maxEvents: this.cfg.maxEvents,
          maxEntities: this.cfg.maxEntities,
          maxEdges: this.cfg.maxEdges,
        });
        if (this.cfg.debug && (evicted.deletedEvents || evicted.deletedEntities || evicted.deletedEdges)) {
          this.ctx.logger.debug(
            `[user-relation] 自动老化: 删除 events=${evicted.deletedEvents} entities=${evicted.deletedEntities} edges=${evicted.deletedEdges}`,
          );
        }
      } catch (err) {
        this.ctx.logger.warn(`[user-relation] 自动老化失败: ${(err as Error).message}`);
      }
    }
  }
}

// ───── helpers ─────

function hasMessageId(m: Message): boolean {
  return typeof (m.metadata as { messageId?: string } | undefined)?.messageId === 'string';
}

function inferPlatform(msgs: Message[]): string {
  for (const m of msgs) {
    const p = (m.metadata as { platform?: string } | undefined)?.platform;
    if (p) return p;
  }
  return '';
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 渲染窗口内每条消息为 LLM 可读行：`[mid] (sender) content` */
function renderHistoryForLLM(history: Message[]): string {
  const lines: string[] = [];
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const meta = (m.metadata as { messageId?: string; userId?: string; nickname?: string } | undefined) ?? {};
    const sender = m.role === 'assistant' ? 'aalis(我)' : `${meta.nickname ?? '匿名'}(${meta.userId ?? '?'})`;
    const mid = meta.messageId ?? '-';
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    lines.push(`[${mid}] (${sender}) ${content.replace(/\n+/g, ' ').slice(0, 400)}`);
  }
  return lines.join('\n');
}

function buildExtractionPrompt(
  history: Message[],
  userMsgs: Message[],
  candidateEvents: EventNode[],
  candidateEntities: EntityNode[],
  senderNeighbors: SenderNeighborhood[],
): Message[] {
  const rendered = renderHistoryForLLM(history);
  const evtList =
    candidateEvents.length === 0 ? '（无）' : candidateEvents.map(e => `- id=${e.id} title=${e.title}`).join('\n');
  const entList =
    candidateEntities.length === 0
      ? '（无）'
      : candidateEntities
          .map(
            e =>
              `- id=${e.id} kind=${e.entityKind} name=${e.name}${e.aliases?.length ? ` aka=${e.aliases.join('|')}` : ''}`,
          )
          .join('\n');
  const senderList = collectSenderList(userMsgs);
  const neighborBlock = renderSenderNeighbors(senderNeighbors);
  const system: Message = {
    role: 'system',
    content: [
      '你是一个对话关系图提取器。根据下方的群聊/会话消息窗口，提取「人物 / 事件 / 实体」三类节点和它们之间的关系，',
      '严格输出**单个 JSON 对象**（不要任何解释文字、不要 ```json 包裹），结构如下：',
      '{',
      '  "persons": [{ "platform": str, "userId": str, "displayName"?: str }],',
      '  "events": [{ "refKey": str, "existingEventId"?: str|null, "title": str(<=30字), "summary"?: str(<=80字), "category"?: "discussion"|"conflict"|"collaboration"|"incident"|"milestone"|"other", "evidence": { "messageIds": str[], "quote": str } }],',
      '  "entities": [{ "refKey": str, "existingEntityId"?: str|null, "name": str(<=20字), "aliases"?: str[], "summary"?: str(<=80字), "entityKind": "topic"|"place"|"thing"|"work", "evidence": { "messageIds": str[], "quote": str } }],',
      '  "personEventEdges": [{ "personPlatform": str, "personUserId": str, "eventRefKey": str, "role": "initiator"|"participant"|"witness"|"target"|"reporter", "sentiment"?: "positive"|"negative"|"neutral"|"mixed", "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],',
      '  "personEntityEdges": [{ "personPlatform": str, "personUserId": str, "entityRefKey": str, "role": "enthusiast"|"participant"|"owner"|"creator"|"critic"|"visitor"|"mentioned", "sentiment"?: "positive"|"negative"|"neutral"|"mixed", "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],',
      '  "personPersonEdges": [{ "fromPlatform": str, "fromUserId": str, "toPlatform": str, "toUserId": str, "relationType": str, "directed"?: bool, "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],',
      `  "eventEventEdges": [{ "fromEventRefKey": str, "toEventRefKey": str, "relationType": str(\u63a8\u8350: ${RecommendedEventEventRelationTypes.join(' / ')}), "directed"?: bool, "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],`,
      `  "eventEntityEdges": [{ "eventRefKey": str, "entityRefKey": str, "relationType": str(\u63a8\u8350: ${RecommendedEventEntityRelationTypes.join(' / ')}), "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],`,
      `  "entityEntityEdges": [{ "fromEntityRefKey": str, "toEntityRefKey": str, "relationType": str(\u63a8\u8350: ${RecommendedEntityEntityRelationTypes.join(' / ')}), "directed"?: bool, "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }]`,
      '}',
      '',
      '## 关键区别：Event vs Entity（务必正确使用）',
      '- **Event（事件）= 一次性发生的事**：必须有**明确的时间锚点**（昨晚 / 上周 / 刚才 / 某场 / 下周三…）和**可识别的动作或结果**（开黑、争吵、发布、签约、相遇、比赛…）。',
      '- **Entity（实体）= 持续存在的"东西"**：可被多人长期关联。例：游戏《三角洲》、电影《奥本海默》、北京、PS5、某个表情包、某个梗。',
      '- **当多人共享某个对象时，请把它建模为 Entity，让每个人各自通过 personEntityEdge 指向它**；不要把它写进事件标题里。',
      '',
      '## ⚠️ 事件提取须保持冷淡（重要）',
      '- 只挑**最显著、有长期价值**的事件记录：重大冲突、里程碑、首次合作、长期回响、明显改变关系的转折点。',
      '- **一般日常聊天、随口提及、无后续的玩笑、单次客套、临时调侃** —— **一律不要建 event**。宁可 events 数组返回空，也不要凑数。',
      '- 当你犹豫"这件事算不算值得记"时，**默认答案是不记**。提取器后续会做老化淘汰，但更省事的是源头别记。',
      '',
      '- **以下情况一律不要建 event**（直接走 personEntityEdge 或留空）：',
      '  · 偏好/事实声明：「我喜欢 X / 我讨厌 Y / 我有 Z / 我会 W」——只建 entity 边，不建 event。',
      '  · 元对话/元请求：「帮我记一下…」「你的关系系统测试一下」「这是我」——这些是对工具的指令，不是世界中发生的事件，**完全不要建 event**。',
      '  · 单纯转述/提及：「A 说他喜欢 X」——只建 A→X 的 entity 边，不要把"A 提及 X"包装成 event。',
      '  · 问候/客套/无信息内容：「在吗」「早」「哈哈」——什么都不建。',
      '- event.title 必须能反映"何时发生了何事"（如「2024-某周开黑《三角洲》」），**禁止**形如「X 提及 Y」「讨论 Z」「测试系统」「关于…的对话」这类把"说话/讨论"本身当事件的标题。',
      '',
      '## 正确建模示例',
      "原话：'我喜欢打三角洲，157也喜欢'（Alice 发言）",
      '✅ 正确输出：',
      '  persons: [Alice, 157]',
      '  entities: [{ refKey: "e1", name: "三角洲", entityKind: "work" }]',
      '  personEntityEdges: [',
      '    { person=Alice, entityRefKey="e1", role="enthusiast", sentiment="positive" },',
      '    { person=157,     entityRefKey="e1", role="enthusiast", sentiment="positive" },',
      '  ]',
      '❌ 错误输出（不要这样做）：',
      '  events: [{ title: "Alice 提及 157 喜欢三角洲" }]  ← 把实体塞进事件标题，丢失了"两人共同喜欢"这个图结构。',
      '',
      '## 其他规则（违反则该条目会被丢弃）',
      `- 每条 evidence.messageIds 必须从窗口里实际出现的 messageId 中选取，至少 1 个；`,
      `- 每条 evidence.quote 必须是 messageIds 中某条消息内容的原文子串（≤80 字）；`,
      '- 一个 event/entity 可被多人共同关联（输出多条 edge 指向同一 refKey）；',
      '- 一个人可同时参与多个 event/entity；',
      '- personPersonEdge 仅在能从对话明确看出"长期身份性关系"时输出（CP / 朋友 / 师徒 / 对手 / 同事 / 仰慕等），',
      '  不要把"参与同一事件"或"共享同一兴趣"误当作朋友关系；',
      `- person-person relationType 优先使用：${RecommendedPersonRelationTypes.join(' / ')}；确无合适词时可自创小写英文短词。`,
      '- **角色单选最强**：同一人对同一 event / entity 只输出**一条最强角色边**。语义包含关系：',
      '  · 人-事件：initiator > participant > target > reporter > witness（参与者已含旁观者，不要又写 participant 又写 witness）；',
      '  · 人-实体：enthusiast > creator > owner > critic > participant > visitor > mentioned。',
      '  · 例外：若同一人对同一事件存在**真正不同性质的角色**（如既是 initiator 又是 target —— 自作自受 / 被自己引发的后果反噬），允许各自输出一条；后端会按规则保留可共存的角色。',
      '- **严格自证**：要给某人写 person-event / person-entity / person-person 边，evidence.messageIds 必须包含至少一条**该人自己发的消息**；不要替别人陈述其关系（如"A 说 B 是 C 的朋友"不可写成 B→C friend）。否则该边会被丢弃。',
      '- **person-person 视为单向声明**：A→B "friend" 不代表 B 也认同；如要表达双向，必须 B 也在窗口里亲口确认，并各自输出一条 directed 边。除非明确希望强制双向，否则不要写 directed=false。',
      '- **event-entity / entity-entity 边不要求严格自证**（无 fromPerson），但仍需 evidence + quote。仅在明显能从原文看出【事件关于/使用 某实体】、【实体 part-of/contains 实体】时才输出。',
      '- **description 字段是可选注释**（≤ 40 字中文/英文），只在 role / relationType 代号不足以表达语义时与以补充（例：「绝巴 part-of 三角洲」可加 description="三角洲的高难度关卡"）。能靠 role/relationType 表达清楚的别冗余加。',
      '- **别名识别（is-alias-of）**：当窗口内同一句或紧邻句出现「A 又叫 / 也叫 / 别名 / 就是 B」「A 是 B 的小号 / 马甲」等等同表述时：',
      '  · 若 A、B 都是人物 → personPersonEdges 输出 relationType="is-alias-of"（或 "alt-account-of" 用于小号），directed=true（A 是 B 的别名/小号）。',
      '  · 若 A、B 都是实体 → entityEntityEdges 输出 relationType="is-alias-of"，directed=true。',
      '  · 不要直接合并两个 entity / person 节点，让用户决定是否合并。',
      '- **part-of 自动识别**：若新建事件标题中包含某实体名（如「开黑《三角洲》」含「三角洲」），同时输出一条 eventEntityEdges relationType="part-of"（让事件挂在实体下）。',
      '- **歧义实体必须带限定词（重要）**：后端按 (entityKind, name) 强制合并同名实体。对于跨作品/跨场景容易撞名的「通用词」——例如「月卡 / 年卡 / 会员 / 公会 / 副本 / 装备 / 皮肤 / boss / npc / 主线 / 支线」等——**name 字段必须带上限定的母实体名**，形如「洛克王国月卡」「原神月卡」「《三角洲》公会」，而不是裸的「月卡」。若上下文无法确定母实体，则宁可不建该实体（建 event 描述即可），避免错误合并到无关游戏。',
      '  · 同理：人物绰号/角色名若可能撞名（如多个作品的「林黛玉」），name 也要带作品限定。',
      '  · 真正全局唯一的专有名词（如「PS5」「北京」「奥本海默」）不需要加限定词。',
      '- existingEventId / existingEntityId：若新条目与候选清单中某项实质相同，请填该 id（让旧节点被强化而非重复创建）。',
      '- 当窗口里没有可靠信号时，对应数组返回空 [] 即可，绝对不要编造。',
      '- **绝不输出裸 `null`、裸字符串或其他非对象 JSON**；完全无可提取时请输出 `{"persons":[],"events":[],"entities":[],"personEventEdges":[],"personEntityEdges":[],"personPersonEdges":[],"eventEventEdges":[],"eventEntityEdges":[],"entityEntityEdges":[]}`。',
    ].join('\n'),
  };
  const user: Message = {
    role: 'user',
    content: [
      '== 窗口内已知参与者 ==',
      senderList,
      '',
      '== 已有候选事件（可被强化复用）==',
      evtList,
      '',
      '== 已有候选实体（可被强化复用）==',
      entList,
      '',
      '== 候选人已有 1 跳邻居子图（按权重降序；用于判断"加强已有 vs 新建"）==',
      neighborBlock,
      '',
      '== 消息窗口（按时间升序，[mid] = 平台消息 ID）==',
      rendered,
      '',
      '请直接输出 JSON 对象。',
    ].join('\n'),
  };
  return [system, user];
}

function collectSenderList(userMsgs: Message[]): string {
  const seen = new Map<string, { nickname?: string; platform?: string }>();
  for (const m of userMsgs) {
    const meta = (m.metadata as { userId?: string; nickname?: string; platform?: string } | undefined) ?? {};
    if (!meta.userId) continue;
    const key = `${meta.platform ?? ''}:${meta.userId}`;
    if (!seen.has(key)) seen.set(key, { nickname: meta.nickname, platform: meta.platform });
  }
  if (seen.size === 0) return '（窗口内未出现可识别的入站用户）';
  return [...seen.entries()]
    .map(([k, v]) => `- platform=${v.platform ?? '?'} userId=${k.split(':')[1]} nickname=${v.nickname ?? ''}`)
    .join('\n');
}

/**
 * 把每个发言人的 1 跳邻居子图渲染成紧凑文本，给 LLM 看：
 *   ## Alice (onebot:1234567)
 *     event[eid] 开黑《三角洲》  role=participant w=2.3
 *     entity[entid] 三角洲 (work)  role=enthusiast w=4.1
 *     person→157(onebot) "friend" w=1.0
 * 没邻居的发言人/新人不渲染。
 */
function renderSenderNeighbors(neighbors: SenderNeighborhood[]): string {
  if (!neighbors || neighbors.length === 0) return '（窗口内发言人均为新人，或邻居子图功能已关闭）';
  const blocks: string[] = [];
  for (const n of neighbors) {
    const lines: string[] = [];
    lines.push(`## ${n.nickname ?? '匿名'} (${n.platform}:${n.userId})`);
    for (const e of n.edges) {
      const w = (e.weight ?? 0).toFixed(1);
      if (e.kind === 'person-event') {
        const ev = n.eventById.get(e.toEventId);
        lines.push(`  event[${e.toEventId}] ${ev?.title ?? '(已删)'}  role=${e.role} w=${w}`);
      } else if (e.kind === 'person-entity') {
        const ent = n.entityById.get(e.toEntityId);
        lines.push(
          `  entity[${e.toEntityId}] ${ent?.name ?? '(已删)'}${ent ? ` (${ent.entityKind})` : ''}  role=${e.role} w=${w}`,
        );
      } else if (e.kind === 'person-person') {
        const otherId = e.fromPersonId === n.personId ? e.toPersonId : e.fromPersonId;
        const other = n.personById.get(otherId);
        const dir = e.fromPersonId === n.personId ? '→' : '←';
        lines.push(`  person${dir}${other?.displayName ?? otherId} "${e.relationType}" w=${w}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}

async function callLLM(model: LLMModel, messages: Message[], disableThinking: boolean): Promise<string> {
  const resp = await model.chat({
    messages,
    temperature: 0,
    ...(disableThinking ? { think: false } : {}),
  });
  return typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
}

export type ParseResult =
  | { kind: 'ok'; value: LLMExtraction }
  | { kind: 'empty' } // LLM 明确表达"无可提取"（null / 空对象 / 所有数组为空）
  | { kind: 'parse-error' };

/**
 * 从 LLM 文本中解析提取结果。区分三种情况：
 * - ok：成功解析出含内容的对象
 * - empty：解析成功但表达为空（LLM 主动指出没什么可提取，属于正常路径）
 * - parse-error：LLM 输出无法解析或不是对象（需 warn）
 */
export function parseExtraction(text: string): ParseResult {
  if (!text) return { kind: 'parse-error' };
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'parse-error' };
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  let parsed: unknown = tryParse(cleaned);
  if (parsed === undefined) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) parsed = tryParse(cleaned.slice(start, end + 1));
  }
  if (parsed === undefined) return { kind: 'parse-error' };

  // null / 非对象 / 数组 → empty（LLM 明确表达无可提取）
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'empty' };
  }
  const obj = parsed as LLMExtraction;
  const totalCount =
    (obj.persons?.length ?? 0) +
    (obj.events?.length ?? 0) +
    (obj.entities?.length ?? 0) +
    (obj.personEventEdges?.length ?? 0) +
    (obj.personEntityEdges?.length ?? 0) +
    (obj.personPersonEdges?.length ?? 0) +
    (obj.eventEventEdges?.length ?? 0) +
    (obj.eventEntityEdges?.length ?? 0) +
    (obj.entityEntityEdges?.length ?? 0);
  if (totalCount === 0) return { kind: 'empty' };
  return { kind: 'ok', value: obj };
}
