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
  /** PageRank 阻尼系数，淘汰打分用。默认 0.85 */
  pagerankDamping: number;
  /** PageRank 最大迭代次数。默认 20（图较大时可调大） */
  pagerankIterations: number;
  /** PageRank 收敛阈值（L1 误差），达到即提前停止。默认 1e-4 */
  pagerankEpsilon: number;
  /** 淘汰滞回：count > quota·(1+pct) 才触发；用以避免每写一条都裁。默认 0.2 */
  evictHysteresisPct: number;
  /** 触发后裁到 floor(quota·pct)。默认 0.8，配合 hysteresis=0.2 → 单次清理 ~40% quota */
  evictTargetPct: number;
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

    // ── 反孤儿守卫：先扫一遍 LLM payload，收集被任意边引用的 person id / event refKey / entity refKey。
    //    未被任何边引用的"裸节点"不予落库——既节省存储，也避免 evictByQuota 周期性回收噪声。
    //    existingEventId/existingEntityId 视为已在库的强化操作，豁免（即便本轮没新增边也合理）。
    //    Person 没有 refKey 体系，按 `${platform}:${userId}` 作集合 key；person-person 边的双向端点都计入。
    const referencedPersonIds = new Set<string>();
    const referencedEventRefKeys = new Set<string>();
    const referencedEntityRefKeys = new Set<string>();
    for (const pe of parsed.personEventEdges ?? []) {
      if (pe.eventRefKey) referencedEventRefKeys.add(pe.eventRefKey);
      if (pe.personPlatform && pe.personUserId) {
        referencedPersonIds.add(`${pe.personPlatform}:${pe.personUserId}`);
      }
    }
    for (const ee of parsed.eventEventEdges ?? []) {
      if (ee.fromEventRefKey) referencedEventRefKeys.add(ee.fromEventRefKey);
      if (ee.toEventRefKey) referencedEventRefKeys.add(ee.toEventRefKey);
    }
    for (const ee of parsed.eventEntityEdges ?? []) {
      if (ee.eventRefKey) referencedEventRefKeys.add(ee.eventRefKey);
      if (ee.entityRefKey) referencedEntityRefKeys.add(ee.entityRefKey);
    }
    for (const pe of parsed.personEntityEdges ?? []) {
      if (pe.entityRefKey) referencedEntityRefKeys.add(pe.entityRefKey);
      if (pe.personPlatform && pe.personUserId) {
        referencedPersonIds.add(`${pe.personPlatform}:${pe.personUserId}`);
      }
    }
    for (const ee of parsed.entityEntityEdges ?? []) {
      if (ee.fromEntityRefKey) referencedEntityRefKeys.add(ee.fromEntityRefKey);
      if (ee.toEntityRefKey) referencedEntityRefKeys.add(ee.toEntityRefKey);
    }
    for (const pp of parsed.personPersonEdges ?? []) {
      if (pp.fromPlatform && pp.fromUserId) {
        referencedPersonIds.add(`${pp.fromPlatform}:${pp.fromUserId}`);
      }
      if (pp.toPlatform && pp.toUserId) {
        referencedPersonIds.add(`${pp.toPlatform}:${pp.toUserId}`);
      }
    }

    // 1) persons：只 observe 被边引用的；未被引用的旁观者跳过，避免孤儿人永久积累
    for (const p of parsed.persons ?? []) {
      if (!p.platform || !p.userId) continue;
      const pid = `${p.platform}:${p.userId}`;
      if (!referencedPersonIds.has(pid)) {
        if (this.cfg.debug) {
          this.ctx.logger.debug(`[user-relation] 跳过孤立人物 "${p.displayName ?? pid}"（${pid} 无任何边引用）`);
        }
        continue;
      }
      await this.service.observePerson(p.platform, p.userId, p.displayName);
    }

    // 2) events: refKey → real eventId
    const refToEventId = new Map<string, string>();
    for (const e of parsed.events ?? []) {
      if (!e.refKey || !e.title) continue;
      // 反孤儿：本轮没有任何边引用该 refKey 且不是已存在节点的强化 → 跳过
      if (!e.existingEventId && !referencedEventRefKeys.has(e.refKey)) {
        if (this.cfg.debug) {
          this.ctx.logger.debug(`[user-relation] 跳过孤立事件 "${e.title}"（refKey=${e.refKey} 无任何边引用）`);
        }
        continue;
      }
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
      // 反孤儿：本轮没有任何边引用该 refKey 且不是已存在节点的强化 → 跳过
      if (!e.existingEntityId && !referencedEntityRefKeys.has(e.refKey)) {
        if (this.cfg.debug) {
          this.ctx.logger.debug(`[user-relation] 跳过孤立实体 "${e.name}"（refKey=${e.refKey} 无任何边引用）`);
        }
        continue;
      }
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
      // person-event 不再强制自证：evidence 能从原文佐证该人参与即可，避免跟贴型参与者被误删。
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
      // person-entity 不再强制自证；偏好类关系已在提示词中引导交给 user-profile。
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
          pagerankDamping: this.cfg.pagerankDamping,
          pagerankIterations: this.cfg.pagerankIterations,
          pagerankEpsilon: this.cfg.pagerankEpsilon,
          hysteresisPct: this.cfg.evictHysteresisPct,
          targetPct: this.cfg.evictTargetPct,
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
      `  "eventEventEdges": [{ "fromEventRefKey": str, "toEventRefKey": str, "relationType": str(推荐: ${RecommendedEventEventRelationTypes.join(' / ')}), "directed"?: bool, "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],`,
      `  "eventEntityEdges": [{ "eventRefKey": str, "entityRefKey": str, "relationType": str(推荐: ${RecommendedEventEntityRelationTypes.join(' / ')}), "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],`,
      `  "entityEntityEdges": [{ "fromEntityRefKey": str, "toEntityRefKey": str, "relationType": str(推荐: ${RecommendedEntityEntityRelationTypes.join(' / ')}), "directed"?: bool, "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }]`,
      '}',
      '',
      '## 关键区别：Event vs Entity（务必正确使用）',
      '- **Event（事件）= 一次性发生的事**：必须有**明确的时间锚点**（昨晚 / 上周 / 刚才 / 某场 / 下周三…）和**可识别的动作或结果**（开黑、争吵、发布、签约、相遇、比赛…）。',
      '- **Entity（实体）= 持续存在的"东西"**：可被多人长期关联。例：游戏《三角洲》、电影《奥本海默》、北京、PS5、某个表情包、某个梗。',
      '- **当多人共享某个对象时，请把它建模为 Entity，让每个人各自通过 personEntityEdge 指向它**；不要把它写进事件标题里。',
      '',
      '## 事件提取（要积极但有据）',
      '- 优先记录：有**可识别动作**（开黑/争吵/比赛/发布/相遇/讨论某话题…）且**多人参与或多条消息支撑**的事。',
      '- 「X 和 Y 讨论 Z」「群里围绕 Z 聊了一阵」这类**多人对话事件**值得记 —— 只要 evidence.messageIds ≥ 2 条且至少 2 人发言，可以建。后端会按 weight 老化，不必过度自我审查。',
      '- 完全单条、零回应的随口提及不建；问候/客套/单字回应不建（见下方负面清单）。',
      '',
      '## ⚠️ 反孤儿节点（强制）',
      '- 每一个你创建的 person / event / entity，**必须至少被一条边引用**（personEvent / eventEvent / eventEntity 或 personEntity / entityEntity / personPerson）。',
      '- 不要写"光杆节点"——若你不打算给它任何边，就**直接从 persons / events / entities 数组里去掉**。提取器会丢弃这种孤立节点，等于白做。',
      '- persons 数组的作用是登记"这一轮你打算与之建立关系的人"，**不是聊天窗口参与者花名册**。窗口里只是旁观的人若没有任何边引用，请不要列出。',
      '- 自检顺序：先列边 → 边中提到哪些 person id / refKey → 只把这些 person / refKey 写进 persons / events / entities。',
      '',
      '- **以下情况不要建 event**（负面清单）：',
      '  · 偏好/事实声明：「我喜欢 X / 我讨厌 Y / 我有 Z / 我会 W」——这类**个人画像**由 plugin-user-profile 负责；user-relation 不应再为此建 person-entity "enthusiast"/"critic" 边，**也不要建 event**。',
      '  · 元对话/元请求：「帮我记一下…」「测试一下你的关系系统」「这是我」——对工具的指令不是世界中发生的事，**不要建 event**。',
      '  · 问候/客套/无信息内容：「在吗」「早」「哈哈」「ok」——什么都不建。',
      '- event.title 应反映**何事 / 何主题**，鼓励包含时间锚点（如「2024-某周开黑《三角洲》」）。允许「围绕《三角洲》的讨论」「关于关系系统的复盘对话」这类**对话型事件**标题；但需 evidence.messageIds ≥ 2 条作为支撑，并尽量通过 eventEntityEdges part-of 把话题实体挂上，让事件可被检索。',
      '',
      '## 正确建模示例',
      '### 示例 1：偏好声明 → 留给 user-profile，不在本插件建边',
      "原话：'我喜欢打三角洲，157也喜欢'（Alice 发言）",
      '✅ 正确输出：persons: [], entities: [], personEntityEdges: []  ← 喜欢/讨厌 由 user-profile 处理；本插件全空即可。',
      '❌ 不要：personEntityEdges role="enthusiast"（与 user-profile 重复，且会污染关系图）。',
      '',
      '### 示例 2：多人共同行为/讨论 → 建 event + part-of entity',
      "原话（多人多轮）：A: '今晚一起打三角洲？' B: '行' A: '我开车' B: '157 你来不？' 157: '来'",
      '✅ 正确输出：',
      '  entities: [{ refKey: "e1", name: "三角洲", entityKind: "work" }]',
      '  events: [{ refKey: "ev1", title: "约局开黑《三角洲》", category: "collaboration" }]',
      '  personEventEdges: [{ A→ev1 role=initiator }, { B→ev1 role=participant }, { 157→ev1 role=participant }]',
      '  eventEntityEdges: [{ ev1→e1 relationType="part-of" }]',
      '',
      '### 示例 3：单向 person-person 声明（允许不对等）',
      "原话：A: '157 是我兄弟' （A 自己说；窗口里 157 没回应或没否认）",
      '✅ 正确输出：personPersonEdges: [{ A→157 relationType="friend" directed=true }]  ← 仅 A 的单向声明；不写 157→A。',
      '✅ 同理：A: "我跟 157 闹翻了" → personPersonEdges: [{ A→157 relationType="hostile" directed=true }]，允许负向且不对等。',
      '',
      '## 其他规则（违反则该条目会被丢弃）',
      `- 每条 evidence.messageIds 必须从窗口里实际出现的 messageId 中选取，至少 1 个；`,
      `- 每条 evidence.quote 必须是 messageIds 中某条消息内容的原文子串（≤80 字）；`,
      '- 一个 event/entity 可被多人共同关联（输出多条 edge 指向同一 refKey）；',
      '- 一个人可同时参与多个 event/entity；',
      '- personPersonEdge **是单向声明**：只要发话人 A 自己亲口表达了对 B 的关系定位（朋友 / 敌人 / 师傅 / 暗恋 / 讨厌 / CP / 同事…），就可以输出 A→B 一条 directed=true 边，**无需 B 回应或背书**。负面关系（讨厌 / 拉黑 / 仇人）同样适用。',
      '  不要把"参与同一事件"或"共享同一兴趣"误当作朋友关系——必须有明确的身份性陈述（"是我朋友""跟我闹翻了""我老婆"…）；',
      `- person-person relationType 优先使用：${RecommendedPersonRelationTypes.join(' / ')}；确无合适词时可自创小写英文短词。`,
      '- **角色单选最强**：同一人对同一 event / entity 只输出**一条最强角色边**。语义包含关系：',
      '  · 人-事件：initiator > participant > target > reporter > witness（参与者已含旁观者，不要又写 participant 又写 witness）；',
      '  · 人-实体：enthusiast > creator > owner > critic > participant > visitor > mentioned。',
      '  · 例外：若同一人对同一事件存在**真正不同性质的角色**（如既是 initiator 又是 target —— 自作自受 / 被自己引发的后果反噬），允许各自输出一条；后端会按规则保留可共存的角色。',
      '- **严格自证（仅 person-person）**：要写 personPersonEdge A→B 时，evidence.messageIds 必须包含至少一条 **A 自己发的消息**（表达对 B 的关系定位）。"A 说 B 是 C 的朋友" 不能写成 B→C friend（B 没自己说过）；但可写 A→B/A→C 的相关边。person-event / person-entity 边不再强制自证，evidence 只需能从原文佐证该人参与即可。',
      '- **person-person 视为单向声明**：A→B 总是 directed=true，B 不背书也无妨；如要表达双向关系（互为朋友/互为敌人），必须 B 也在窗口里有相应陈述，各自输出一条 directed=true 边，不要用 directed=false。',
      '- **person-entity 收紧**：本插件只在**行为性**关系（participant / owner / creator / visitor / mentioned）才建 person-entity 边。「喜欢 / 讨厌 / 是粉丝 / 收藏 / 关注 / 一般偏好」一律**不建** —— 这些是个人画像，由 plugin-user-profile 在另一条管道维护。若你不确定是行为性关系还是偏好声明，**省略该边**。',
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
