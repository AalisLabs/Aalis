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
  Sentiment,
} from './types.js';
import { RecommendedEventEventRelationTypes, RecommendedPersonRelationTypes } from './types.js';

export interface ExtractorConfig {
  triggerEveryNMessages: number;
  readWindowSize: number;
  mode: 'incremental' | 'all-new';
  allNewMaxMessages: number;
  /** 提取时把"最近 N 天的活跃事件"作为候选清单交给 LLM 复用 */
  candidateEventDays: number;
  candidateEventLimit: number;
  /** LLM model 引用；为空走默认 'llm' service */
  extractionModel?: ModelRef;
  /** 是否禁用思考模式（思考型模型上）。提取是结构化输出任务，默认禁用以避免 budget 被 reasoning 吃掉 */
  disableThinking: boolean;
  /** 严格自证：每条 person-* 边必须有 evidence 且 evidence.messageId.sender == fromPersonId */
  strictSelfAssertion: boolean;
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
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  personEntityEdges?: Array<{
    personPlatform: string;
    personUserId: string;
    entityRefKey: string;
    role: string;
    sentiment?: string;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  personPersonEdges?: Array<{
    fromPlatform: string;
    fromUserId: string;
    toPlatform: string;
    toUserId: string;
    relationType: string;
    directed?: boolean;
    evidence?: { messageIds?: string[]; quote?: string };
  }>;
  eventEventEdges?: Array<{
    fromEventRefKey: string;
    toEventRefKey: string;
    relationType: string;
    directed?: boolean;
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
      const promptMessages = buildExtractionPrompt(history, userMsgs, candidateEvents, candidateEntities);

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
      // 优先尊重 LLM 指明的 existingEntityId；否则按 name 自动去重
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
        const dup = await this.service.findEntityByName(e.name);
        if (dup) {
          const reinforced = await this.service.reinforceEntity(dup.id, {
            aliases: e.aliases,
            summary: e.summary,
            entityKind,
            evidence: ev ? [ev] : [],
          });
          if (reinforced) entityId = reinforced.id;
        }
      }
      if (!entityId) {
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
        evidence: ev ? [ev] : [],
      });
    }

    if (this.cfg.debug) {
      this.ctx.logger.debug(
        `[user-relation] ${ctxInfo.sessionId} 提取完成: persons=${parsed.persons?.length ?? 0}, events=${parsed.events?.length ?? 0}, entities=${parsed.entities?.length ?? 0}, pe=${parsed.personEventEdges?.length ?? 0}, pent=${parsed.personEntityEdges?.length ?? 0}, pp=${parsed.personPersonEdges?.length ?? 0}, ee=${parsed.eventEventEdges?.length ?? 0}`,
      );
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
  const system: Message = {
    role: 'system',
    content: [
      '你是一个对话关系图提取器。根据下方的群聊/会话消息窗口，提取「人物 / 事件 / 实体」三类节点和它们之间的关系，',
      '严格输出**单个 JSON 对象**（不要任何解释文字、不要 ```json 包裹），结构如下：',
      '{',
      '  "persons": [{ "platform": str, "userId": str, "displayName"?: str }],',
      '  "events": [{ "refKey": str, "existingEventId"?: str|null, "title": str(<=30字), "summary"?: str(<=80字), "category"?: "discussion"|"conflict"|"collaboration"|"incident"|"milestone"|"other", "evidence": { "messageIds": str[], "quote": str } }],',
      '  "entities": [{ "refKey": str, "existingEntityId"?: str|null, "name": str(<=20字), "aliases"?: str[], "summary"?: str(<=80字), "entityKind": "topic"|"place"|"thing"|"work", "evidence": { "messageIds": str[], "quote": str } }],',
      '  "personEventEdges": [{ "personPlatform": str, "personUserId": str, "eventRefKey": str, "role": "initiator"|"participant"|"witness"|"target"|"reporter", "sentiment"?: "positive"|"negative"|"neutral"|"mixed", "evidence": { "messageIds": str[], "quote": str } }],',
      '  "personEntityEdges": [{ "personPlatform": str, "personUserId": str, "entityRefKey": str, "role": "enthusiast"|"participant"|"owner"|"creator"|"critic"|"visitor"|"mentioned", "sentiment"?: "positive"|"negative"|"neutral"|"mixed", "evidence": { "messageIds": str[], "quote": str } }],',
      '  "personPersonEdges": [{ "fromPlatform": str, "fromUserId": str, "toPlatform": str, "toUserId": str, "relationType": str, "directed"?: bool, "evidence": { "messageIds": str[], "quote": str } }],',
      `  "eventEventEdges": [{ "fromEventRefKey": str, "toEventRefKey": str, "relationType": str(\u63a8\u8350: ${RecommendedEventEventRelationTypes.join(' / ')}), "directed"?: bool, "evidence": { "messageIds": str[], "quote": str } }]`,
      '}',
      '',
      '## 关键区别：Event vs Entity（务必正确使用）',
      '- **Event（事件）= 一次性发生的事**：有时间感、有动作、可结束。例：上周的争吵、昨晚的开黑、某场比赛、一次发布、一次合作。',
      '- **Entity（实体）= 持续存在的"东西"**：可被多人长期关联。例：游戏《三角洲》、电影《奥本海默》、北京、PS5、某个表情包、某个梗。',
      '- **当多人共享某个对象时，请把它建模为 Entity，让每个人各自通过 personEntityEdge 指向它**；不要把它写进事件标题里。',
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
      '- **严格自证**：要给某人写 person-event / person-entity / person-person 边，evidence.messageIds 必须包含至少一条**该人自己发的消息**；不要替别人陈述其关系（如"A 说 B 是 C 的朋友"不可写成 B→C friend）。否则该边会被丢弃。',
      '- **person-person 视为单向声明**：A→B "friend" 不代表 B 也认同；如要表达双向，必须 B 也在窗口里亲口确认，并各自输出一条 directed 边。除非明确希望强制双向，否则不要写 directed=false。',
      '- existingEventId / existingEntityId：若新条目与候选清单中某项实质相同，请填该 id（让旧节点被强化而非重复创建）。',
      '- 当窗口里没有可靠信号时，对应数组返回空 [] 即可，绝对不要编造。',
      '- **绝不输出裸 `null`、裸字符串或其他非对象 JSON**；完全无可提取时请输出 `{"persons":[],"events":[],"entities":[],"personEventEdges":[],"personEntityEdges":[],"personPersonEdges":[],"eventEventEdges":[]}`。',
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
    (obj.eventEventEdges?.length ?? 0);
  if (totalCount === 0) return { kind: 'empty' };
  return { kind: 'ok', value: obj };
}
