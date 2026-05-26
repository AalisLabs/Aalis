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
import type { MemoryService, RecentMessageRecord } from '@aalis/plugin-memory-api';
import type { Message } from '@aalis/plugin-message-api';
import { getPlatformNames } from '@aalis/plugin-platform-api';
import { parseLLMJsonObject } from '@aalis/util-json-repair';
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

export type ExtractorReadScope = 'same-session' | 'same-platform' | 'cross-platform';

export interface ExtractorConfig {
  triggerEveryNMessages: number;
  readWindowSize: number;
  mode: 'incremental' | 'all-new';
  allNewMaxMessages: number;
  /**
   * 提取窗口的会话范围：
   * - same-session（默认）：仅当前 sessionId（同群聊 / 同私聊）。
   * - same-platform：同 platform 下所有会话合并送 LLM（每条标注 [sid]），用于识别跨群共享事件。
   * - cross-platform：跨所有平台聚合（同上）。
   * 跨会话模式下，evidence.sessionId 按每条消息真实来源记录，event.sessionScope 仍由 LLM 输出（current=来源 session / global=显式跨会话）决定。
   */
  readScope?: ExtractorReadScope;
  /** 跨会话拉取时仅取最近 N 分钟内的消息；0=不限。仅在 readScope!=same-session 时生效。默认 60。 */
  crossSessionMaxAgeMinutes?: number;
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
  /** 人物节点总数上限；超过则按 (age/mentionCount/PR) 排序删除老旧低活跃节点。0=不限。 */
  maxPersons: number;
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
  /**
   * Weight 时间衰减半衰期（天）。effW = raw × max(0.5^(days/halfLife), floor)。
   * 用于"老高 weight 节点不再被反复强化时自动让出淘汰保护名额"。
   * 0 或负值 = 关闭衰减（行为向后兼容）。默认 180 天。
   */
  weightDecayHalfLifeDays: number;
  /** Weight 衰减下限因子，effW 不会低于 raw × floor。保留"老朋友"底色。默认 0.3 */
  weightDecayFloor: number;
  /**
   * evictByQuota 之后顺手跑的社群发现算法。默认 'louvain'。
   * - 'louvain' / 'leiden'：硬划分，每个节点恰好属于一个社群（leiden 额外保证社群内部连通）
   * - 'slpa'：Speaker-Listener Label Propagation，原生重叠社区；跨群人物能获得多个社群隶属度
   */
  communityAlgorithm: 'louvain' | 'leiden' | 'slpa';
  /**
   * 淘汰完成后自动运行一次 consolidate（去重/整理/层级推断）。
   * 仅在实际发生淘汰（deletedEvents/Entities/Edges > 0）时触发。默认 true。
   */
  consolidateAfterEviction: boolean;
  /** consolidation 使用的 LLM 模型（可选；为空则退化为纯算法模式） */
  consolidateLLMModelRef?: ModelRef;
  /** consolidation LLM 是否禁用思考模式 */
  consolidateLLMDisableThinking: boolean;
  /** consolidation 是否自动建别名/层级边（对应 consolidate({ autoLink }) 参数） */
  consolidateAutoLink: boolean;
  /** F3：宽召回阶段双方低权 entity 是否跳过 LLM 核验 */
  consolidateSkipLowScorePairs: boolean;
  /** F3：低权阈值（compositeScore < 该值视为低权） */
  consolidateLowScoreThreshold: number;
  /** debug 日志 */
  debug: boolean;
}

/**
 * `ExtractorConfig` 的单一默认值真源。
 *
 * 用途：
 * - 测试构造 extractor 时直接 spread，避免每次新增字段都要在多份 fixture 里手补默认值；
 * - `index.ts` apply() 的 `numCfg(config.x, DEFAULT)` 默认值也应优先从此处取（人工同步即可，因为 apply 路径有 string→number 解析需求）。
 *
 * **约束**：必须包含 `ExtractorConfig` 所有必填字段。`satisfies` 在编译期保证遗漏即报错——
 * 给 `ExtractorConfig` 加新必填字段时，TS 会直接拒绝编译，倒逼此处同步，根治"测试 / 运行时
 * 默认值漂移"问题。
 *
 * 可选字段（`?:`）默认留空（运行时按需启用）。
 */
export const EXTRACTOR_CONFIG_DEFAULTS = {
  triggerEveryNMessages: 20,
  readWindowSize: 30,
  mode: 'incremental',
  allNewMaxMessages: 200,
  candidateEventDays: 7,
  candidateEventLimit: 20,
  senderNeighborhoodEdgeLimit: 8,
  disableThinking: true,
  strictSelfAssertion: true,
  evictionEnabled: true,
  maxPersons: 1500,
  maxEvents: 2500,
  maxEntities: 1500,
  maxEdges: 10000,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
  pagerankEpsilon: 1e-4,
  evictHysteresisPct: 0.2,
  evictTargetPct: 0.8,
  weightDecayHalfLifeDays: 180,
  weightDecayFloor: 0.3,
  communityAlgorithm: 'louvain',
  consolidateAfterEviction: true,
  consolidateLLMDisableThinking: true,
  consolidateAutoLink: false,
  consolidateSkipLowScorePairs: true,
  consolidateLowScoreThreshold: 0.2,
  debug: false,
} as const satisfies ExtractorConfig;

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
    /** 'current' = 当前会话内事件（默认）；'global' = 显式跨会话事件 */
    scope?: string;
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
    /** 从 from 视角看 to 的层级：superior=对方更高(对方是师/上级), peer, subordinate=对方更低, unknown */
    hierarchy?: 'superior' | 'peer' | 'subordinate' | 'unknown';
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

/**
 * 占位/伪 person 守卫：用于过滤 LLM 抽出的「不真实」person id（典型如
 * `aalis:aalis` / `mia:mia` / `discord:xxx`——历史 prompt/渲染遗留下来的自指占位）。
 *
 * 设计原则（**persona-agnostic**）：
 *   - 「真实平台」 = `getPlatformNames(ctx)` 返回的、当前运行时实际注册了 adapter
 *     的平台集合。persona 改名、配置改名都不影响判定。
 *   - 通用 placeholder userId（self/me/bot/assistant）作为兜底，捕获
 *     `onebot:self` 这类「平台合法、id 是自指占位」的情形。**不再硬编码 persona
 *     专属词**（aalis / 本机器人 / 机器人 / Mia / ...）。
 *
 * 判定规则（任一命中即视为占位）：
 *   1) platform / userId 为空；
 *   2) 当 ctx 提供的 `knownPlatforms` 非空时，`platform` 小写不在白名单中；
 *      （为空时跳过该检查——保护「无 adapter 已注册」的测试 / 空环境场景，避免
 *       误删旧数据）
 *   3) `userId` 小写命中通用占位词 `{self, me, bot, assistant}`。
 *
 * 一致性：extractor.applyExtraction、`/relation cleanup fake-self` 命令、
 * `RelationService.consolidate` 都共用本函数，保证三处口径完全一致。
 */
const GENERIC_PLACEHOLDER_USERIDS = new Set(['self', 'me', 'bot', 'assistant']);

/** 取当前运行时已注册的平台名集合（小写）。无 adapter 时返回空集——调用方应
 *  在传入 isPlaceholderSelfPersonId 时把「空集」视为 permissive。 */
export function getKnownPlatformsLower(ctx: Context): Set<string> {
  try {
    return new Set(getPlatformNames(ctx).map(p => p.toLowerCase()));
  } catch {
    return new Set();
  }
}

export function isPlaceholderSelfPersonId(
  platform: string | undefined,
  userId: string | undefined,
  knownPlatforms?: Set<string>,
): boolean {
  if (!platform || !userId) return true;
  if (knownPlatforms && knownPlatforms.size > 0 && !knownPlatforms.has(platform.toLowerCase())) {
    return true;
  }
  if (GENERIC_PLACEHOLDER_USERIDS.has(userId.toLowerCase())) return true;
  return false;
}

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
  async triggerNow(
    sessionId: string,
    opts?: { readScope?: ExtractorReadScope },
  ): Promise<{ status: 'ok' | 'skipped' | 'error'; reason?: string }> {
    if (this.inFlight.has(sessionId)) return { status: 'skipped', reason: 'in-flight' };
    try {
      await this.extractSession(sessionId, opts?.readScope);
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', reason: stringifyErr(err) };
    }
  }

  private async extractSession(sessionId: string, readScopeOverride?: ExtractorReadScope): Promise<void> {
    if (this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    try {
      const memory = this.ctx.getService<MemoryService>('memory');
      if (!memory?.getHistory) {
        if (this.cfg.debug) this.ctx.logger.debug('[user-relation] memory.getHistory 不可用，跳过');
        return;
      }
      const limit = this.cfg.mode === 'all-new' ? this.cfg.allNewMaxMessages : this.cfg.readWindowSize;
      const readScope = readScopeOverride ?? this.cfg.readScope ?? 'same-session';
      // history: Message[] 数组（用于 LLM prompt 渲染 + validMessageIds 校验）；
      // messageIdToSessionId: messageId -> 来源 sessionId（跨会话模式下，evidence.sessionId 据此回写真实来源）
      // crossSession=true 时渲染层会自动给每条消息加 [sid] 前缀帮助 LLM 区分来源
      let history: Message[];
      let messageIdToSessionId: Map<string, string>;
      const crossSession = readScope !== 'same-session';
      if (!crossSession) {
        const raw = await memory.getHistory(sessionId, limit);
        history = raw;
        messageIdToSessionId = new Map();
        for (const m of raw) {
          const meta = (m.metadata as { messageId?: string } | undefined) ?? {};
          if (meta.messageId) messageIdToSessionId.set(meta.messageId, sessionId);
        }
      } else {
        if (!memory.getRecentMessagesAcrossSessions) {
          if (this.cfg.debug)
            this.ctx.logger.debug(
              `[user-relation] readScope=${readScope} 但 memory 后端不支持 getRecentMessagesAcrossSessions，降级到 same-session`,
            );
          history = await memory.getHistory(sessionId, limit);
          messageIdToSessionId = new Map();
          for (const m of history) {
            const meta = (m.metadata as { messageId?: string } | undefined) ?? {};
            if (meta.messageId) messageIdToSessionId.set(meta.messageId, sessionId);
          }
        } else {
          // 推断当前 sessionId 的 platform：从首条带 platform 的 message 推；否则不限平台
          const peek = await memory.getHistory(sessionId, 3).catch(() => [] as Message[]);
          const currentPlatform = inferPlatform(peek);
          const maxAge = Math.max(0, this.cfg.crossSessionMaxAgeMinutes ?? 60);
          const sinceTs = maxAge > 0 ? Date.now() - maxAge * 60_000 : undefined;
          const records: RecentMessageRecord[] = await memory.getRecentMessagesAcrossSessions({
            limit,
            sinceTs,
            platform: readScope === 'same-platform' ? currentPlatform : undefined,
            roles: ['user', 'assistant'],
          });
          messageIdToSessionId = new Map();
          // 把 sessionId 注入到 message.metadata.__extractorSessionId（运行时临时字段，仅用于渲染/反查）
          history = records.map(r => {
            const meta = (r.message.metadata as Record<string, unknown> | undefined) ?? {};
            if (typeof meta.messageId === 'string') messageIdToSessionId.set(meta.messageId, r.sessionId);
            return {
              ...r.message,
              metadata: { ...meta, __extractorSessionId: r.sessionId },
            };
          });
        }
      }
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
        { crossSession, currentSessionId: sessionId },
      );

      const raw = await callLLM(modelEntry.instance, promptMessages, this.cfg.disableThinking);
      let result = parseExtraction(raw);
      if (result.kind === 'parse-error') {
        // util-json-repair 已尝试剥 fence + 修裸引号 + 补括号；仍失败 → 多半是
        // 模型彻底跑题（写了纯文本/markdown 段落）。给模型一次明确反馈再来一次，
        // 避免一窗对话因为一次输出失败而完全丢失关系信号。
        this.ctx.logger.warn(
          `[user-relation] LLM 输出无法解析为 JSON（model=${modelEntry.contextId}），尝试重试一次。原文前 200 字：${raw.slice(0, 200)}`,
        );
        const retryMessages: Message[] = [
          ...promptMessages,
          { role: 'assistant', content: raw } as Message,
          {
            role: 'user',
            content:
              '你上一条输出无法被 JSON.parse（很可能是包了 markdown 代码块、夹杂解释文字、或被截断）。' +
              '请只输出**一个**合法的 JSON 对象，第一个字符必须是 `{`、最后一个字符必须是 `}`，' +
              '禁止 ```json 围栏、禁止任何解释、禁止 markdown。如果实在没有可提取的内容，' +
              '就输出 `{"persons":[],"events":[],"entities":[],"personEventEdges":[],"personEntityEdges":[],"personPersonEdges":[],"eventEventEdges":[],"eventEntityEdges":[],"entityEntityEdges":[]}`。',
          } as Message,
        ];
        const rawRetry = await callLLM(modelEntry.instance, retryMessages, this.cfg.disableThinking);
        result = parseExtraction(rawRetry);
        if (result.kind === 'parse-error') {
          this.ctx.logger.warn(
            `[user-relation] LLM 重试后仍无法解析 JSON（model=${modelEntry.contextId}），放弃本批次。重试原文前 200 字：${rawRetry.slice(0, 200)}`,
          );
          return;
        }
        this.ctx.logger.debug(`[user-relation] LLM 重试后解析成功（model=${modelEntry.contextId}）`);
      }
      if (result.kind === 'empty') {
        if (this.cfg.debug) {
          this.ctx.logger.debug(`[user-relation] ${sessionId} LLM 明确表示本批次无可提取`);
        }
        return;
      }

      await this.applyExtraction(result.value, { sessionId, platform, history, messageIdToSessionId });
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
    ctxInfo: {
      sessionId: string;
      platform: string;
      history: Message[];
      /** messageId -> 真实来源 sessionId（跨会话模式下每条 evidence 据此回写来源） */
      messageIdToSessionId?: Map<string, string>;
    },
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
    // ── 伪 person 守卫：persona-agnostic 平台白名单 + 通用占位 userId 兜底。
    //    详细规则见 `isPlaceholderSelfPersonId` 的 jsdoc。这里在每次 applyExtraction
    //    入口快照一次 `knownPlatforms`，避免内层多次 ctx.getAllServices。
    const knownPlatforms = getKnownPlatformsLower(this.ctx);
    const isPlaceholderSelfId = (platform?: string, userId?: string): boolean =>
      isPlaceholderSelfPersonId(platform, userId, knownPlatforms);
    // 聚合 dropself：LLM 一次输出常含 N 个占位 person + N 条占位边，逐条 debug 会刷屏。
    // 改为按类型计数 + 最多 2 个样本，整体一行 warn（首次提醒用户改 prompt/换模型）+ debug 列详情。
    const dropCounts: Record<string, { count: number; samples: string[] }> = {};
    const dropSelf = (label: string, pid: string): void => {
      let bucket = dropCounts[label];
      if (!bucket) {
        bucket = { count: 0, samples: [] };
        dropCounts[label] = bucket;
      }
      bucket.count++;
      if (bucket.samples.length < 2) bucket.samples.push(pid);
    };
    if (parsed.persons?.length) {
      parsed.persons = parsed.persons.filter(p => {
        if (isPlaceholderSelfId(p.platform, p.userId)) {
          dropSelf('person', `${p.platform}:${p.userId}`);
          return false;
        }
        return true;
      });
    }
    if (parsed.personEventEdges?.length) {
      parsed.personEventEdges = parsed.personEventEdges.filter(pe => {
        if (isPlaceholderSelfId(pe.personPlatform, pe.personUserId)) {
          dropSelf('person-event', `${pe.personPlatform}:${pe.personUserId}`);
          return false;
        }
        return true;
      });
    }
    if (parsed.personEntityEdges?.length) {
      parsed.personEntityEdges = parsed.personEntityEdges.filter(pe => {
        if (isPlaceholderSelfId(pe.personPlatform, pe.personUserId)) {
          dropSelf('person-entity', `${pe.personPlatform}:${pe.personUserId}`);
          return false;
        }
        return true;
      });
    }
    if (parsed.personPersonEdges?.length) {
      parsed.personPersonEdges = parsed.personPersonEdges.filter(pp => {
        if (isPlaceholderSelfId(pp.fromPlatform, pp.fromUserId) || isPlaceholderSelfId(pp.toPlatform, pp.toUserId)) {
          dropSelf('person-person', `${pp.fromPlatform}:${pp.fromUserId} ↔ ${pp.toPlatform}:${pp.toUserId}`);
          return false;
        }
        return true;
      });
    }
    const dropEntries = Object.entries(dropCounts);
    if (dropEntries.length > 0) {
      const total = dropEntries.reduce((s, [, v]) => s + v.count, 0);
      const summary = dropEntries.map(([k, v]) => `${k}×${v.count}`).join(' + ');
      this.ctx.logger.debug(
        `[user-relation] LLM 输出含 ${total} 个 self/占位字段，已丢弃 (${summary})。` +
          `典型示例: ${dropEntries
            .flatMap(([k, v]) => v.samples.map(s => `${k}=${s}`))
            .slice(0, 3)
            .join(', ')}`,
      );
    }
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
        sessionId: ctxInfo.messageIdToSessionId?.get(ids[0]) ?? ctxInfo.sessionId,
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
      // scope：'global' = LLM 主动声明跨会话；其它（缺省/未识别）→ 直接落当前会话 sessionId。
      // 不再依赖 createEvent 内部 evidence[0].sessionId fallback（mkEvidence 校验失败时会返回 null 导致回落 'global'）。
      const sessionScope: string = e.scope === 'global' ? 'global' : ctxInfo.sessionId;
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
          sessionScope,
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
          hierarchy: pp.hierarchy,
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

    // 提取完成后打一条 info 级日志。这里用「解析出的数量」作为近似，
    // 零变动时不打（避免闹日志）。
    const total =
      (parsed.persons?.length ?? 0) +
      (parsed.events?.length ?? 0) +
      (parsed.entities?.length ?? 0) +
      (parsed.personEventEdges?.length ?? 0) +
      (parsed.personEntityEdges?.length ?? 0) +
      (parsed.personPersonEdges?.length ?? 0) +
      (parsed.eventEventEdges?.length ?? 0) +
      (parsed.eventEntityEdges?.length ?? 0) +
      (parsed.entityEntityEdges?.length ?? 0);
    if (total > 0) {
      this.ctx.logger.info(
        `[user-relation] 关系图已更新 (session=${ctxInfo.sessionId}): persons=${parsed.persons?.length ?? 0}, events=${parsed.events?.length ?? 0}, entities=${parsed.entities?.length ?? 0}, edges=${(parsed.personEventEdges?.length ?? 0) + (parsed.personEntityEdges?.length ?? 0) + (parsed.personPersonEdges?.length ?? 0) + (parsed.eventEventEdges?.length ?? 0) + (parsed.eventEntityEdges?.length ?? 0) + (parsed.entityEntityEdges?.length ?? 0)}`,
      );
    } else if (this.cfg.debug) {
      this.ctx.logger.debug(`[user-relation] ${ctxInfo.sessionId} 提取完成，本批次无变动`);
    }

    // 写后顺手老化（模仿 profile 风格，不开独立调度器）。
    // 孤儿清理与配额无关——总是顺手扫一遍。注意：evictByQuota 内部已自带孤儿清理，
    // 配了配额时不要重复调用 pruneOrphans。
    const hasQuota =
      this.cfg.evictionEnabled &&
      (this.cfg.maxPersons > 0 || this.cfg.maxEvents > 0 || this.cfg.maxEntities > 0 || this.cfg.maxEdges > 0);
    if (this.cfg.evictionEnabled && !hasQuota) {
      try {
        const orphans = await this.service.pruneOrphans();
        if (
          this.cfg.debug &&
          (orphans.deletedPersons || orphans.deletedEvents || orphans.deletedEntities || orphans.deletedDanglingEdges)
        ) {
          this.ctx.logger.debug(
            `[user-relation] 自动孤儿清理: persons=${orphans.deletedPersons} events=${orphans.deletedEvents} entities=${orphans.deletedEntities} dangling_edges=${orphans.deletedDanglingEdges}`,
          );
        }
      } catch (err) {
        if (this.cfg.debug) this.ctx.logger.debug(`[user-relation] 孤儿清理失败: ${stringifyErr(err)}`);
      }
    }
    if (hasQuota) {
      try {
        const evicted = await this.service.evictByQuota({
          maxPersons: this.cfg.maxPersons,
          maxEvents: this.cfg.maxEvents,
          maxEntities: this.cfg.maxEntities,
          maxEdges: this.cfg.maxEdges,
          pagerankDamping: this.cfg.pagerankDamping,
          pagerankIterations: this.cfg.pagerankIterations,
          pagerankEpsilon: this.cfg.pagerankEpsilon,
          hysteresisPct: this.cfg.evictHysteresisPct,
          targetPct: this.cfg.evictTargetPct,
          decay: {
            halfLifeDays: this.cfg.weightDecayHalfLifeDays,
            floor: this.cfg.weightDecayFloor,
          },
          communityAlgorithm: this.cfg.communityAlgorithm,
        });
        if (
          this.cfg.debug &&
          (evicted.deletedPersons || evicted.deletedEvents || evicted.deletedEntities || evicted.deletedEdges)
        ) {
          this.ctx.logger.debug(
            `[user-relation] 自动老化: 删除 persons=${evicted.deletedPersons} events=${evicted.deletedEvents} entities=${evicted.deletedEntities} edges=${evicted.deletedEdges}`,
          );
        }
        // 淘汰后自动 consolidate（仅在实际发生淘汰时触发）
        if (
          this.cfg.consolidateAfterEviction &&
          (evicted.deletedPersons > 0 ||
            evicted.deletedEvents > 0 ||
            evicted.deletedEntities > 0 ||
            evicted.deletedEdges > 0)
        ) {
          try {
            const cr = await this.service.consolidate({
              autoLink: this.cfg.consolidateAutoLink,
              triggerSource: 'eviction',
              ctx: this.ctx,
              skipLowScorePairs: this.cfg.consolidateSkipLowScorePairs,
              lowScoreThreshold: this.cfg.consolidateLowScoreThreshold,
              ...(this.cfg.consolidateLLMModelRef
                ? {
                    llm: {
                      ctx: this.ctx,
                      modelRef: this.cfg.consolidateLLMModelRef,
                      disableThinking: this.cfg.consolidateLLMDisableThinking,
                    },
                  }
                : {}),
            });
            if (this.cfg.debug) {
              this.ctx.logger.debug(
                `[user-relation] 淘汰后 consolidate 完成: 事件边整理=${cr.eventEdgesNormalized} 层级候选=${cr.entityHierarchyCandidates} 层级边=${cr.entityHierarchyEdgesCreated}`,
              );
            }
          } catch (err) {
            this.ctx.logger.warn(`[user-relation] 淘汰后 consolidate 失败: ${(err as Error).message}`);
          }
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
function renderHistoryForLLM(history: Message[], opts?: { crossSession?: boolean }): string {
  const lines: string[] = [];
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const meta =
      (m.metadata as
        | { messageId?: string; userId?: string; nickname?: string; __extractorSessionId?: string }
        | undefined) ?? {};
    let sender: string;
    if (m.role === 'assistant') {
      sender = meta.userId ? `${meta.nickname ?? 'Aalis'}(${meta.userId})` : 'Aalis（本机器人）';
    } else {
      sender = `${meta.nickname ?? '匿名'}(${meta.userId ?? '?'})`;
    }
    const mid = meta.messageId ?? '-';
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    // 跨会话模式下，[sid] 前缀帮 LLM 区分同名事件来自哪个群/会话
    const sidPrefix = opts?.crossSession && meta.__extractorSessionId ? `[sid:${meta.__extractorSessionId}] ` : '';
    lines.push(`${sidPrefix}[${mid}] (${sender}) ${content.replace(/\n+/g, ' ').slice(0, 400)}`);
  }
  return lines.join('\n');
}

function buildExtractionPrompt(
  history: Message[],
  userMsgs: Message[],
  candidateEvents: EventNode[],
  candidateEntities: EntityNode[],
  senderNeighbors: SenderNeighborhood[],
  opts?: { crossSession?: boolean; currentSessionId?: string },
): Message[] {
  const rendered = renderHistoryForLLM(history, opts);
  const ownSid = opts?.currentSessionId;
  // candidate event 暴露 sessionScope 标签，便于 LLM 决策"reinforce 本会话 / 复用 global hub / 新建 hub"：
  // - scope=global → 显式跨会话 hub event，可被任何 session 复用强化
  // - scope=other:<sid 简写> → 其他 session 的 current 事件，**禁止**直接 reinforce（不同 sessionScope 不能合并），
  //   但可在跨会话提取模式下输出 eventEventEdge part-of 把它挂到一个新建/已有的 global hub 下
  // - scope 与当前 session 相同 → 省略标签（默认即"自家事件"）
  const scopeTag = (e: EventNode): string => {
    const s = e.sessionScope;
    if (!s || s === ownSid) return '';
    if (s === 'global') return ' scope=global';
    return ` scope=other:${s.slice(0, 12)}`;
  };
  const evtList =
    candidateEvents.length === 0
      ? '（无）'
      : candidateEvents.map(e => `- id=${e.id} title=${e.title}${scopeTag(e)}`).join('\n');
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
      '你是 Aalis 的「社会关系神经」。你的任务是把对话窗口里的事实层信号，沉淀成可被 Aalis 长期回忆、可被遍历串联的关系图。',
      '',
      '## 你与 plugin-user-profile 的分工（务必内化）',
      '- **plugin-user-profile（内在画像）**：单人的内在属性 —— 喜好 / 性格 / 技能 / 状态 / 经历 / 单点偏好声明（「我喜欢猫」「我会日语」「我讨厌排队」）。这类信息**不属于关系图**。',
      '- **plugin-user-relation（你自己 / 社会图谱）**：**多个主体之间的可观察连接** —— 谁参与了什么、谁与什么对象有结构性关联、谁与谁互称什么、哪些事件围绕同一对象展开。',
      '- 一句判断：**「这条信息能帮 Aalis 把人或事件串起来吗？」** 能 → 写图；只描述某个人 → 留给 user-profile。',
      '',
      '## ⭐ Hub-first 抽取流程（核心方法论，按顺序执行）',
      '关系图的价值在于「实体作为枢纽（hub）让多个事件、多个人围绕它形成可遍历的网络」。一个孤立的事件 + 一个没挂任何边的实体 = Aalis 失忆。请按以下顺序思考：',
      '',
      '**第 1 步：扫描所有具名对象 → 抽成 Entity**',
      '  在整个窗口里找出所有反复出现 / 多人提及 / 可被长期关联的具名对象：',
      '  · 作品类（游戏 / 影视 / 书籍 / 番剧 / 漫画 / 关卡 / mod / 副本名）→ entityKind=work',
      '  · 地点类（城市 / 店 / 场馆 / 副本场景）→ entityKind=place',
      '  · 物品类（设备 / 商品 / 道具 / 装备）→ entityKind=thing',
      '  · 话题类（社会议题 / 梗 / 概念 / 项目）→ entityKind=topic',
      '  **即便它只在事件标题里以名词出现，也必须单独抽成 entity**，不要让它"溶解"在事件标题里。',
      '  **主动填 aliases**：若窗口里同一对象出现多种叫法（中文名/英文名/简称/缩写/俗称/书名号包裹与否），把它们全部放进 aliases 数组——这是后端别名合并的关键输入。例：`name="绝航"` `aliases=["Project Juehang","JH","《绝航》"]`。',
      '',
      '**第 2 步：建 Event 时强制做 part-of 挂载**',
      '  若 event.title 中含有任何第 1 步抽出的 entity 名（或其同义词），**必须同时输出一条 eventEntityEdges relationType="part-of"** 把事件挂在 entity 下。',
      '  反面：「打《绝航》」「讨论《绝航》」两个事件如果都不挂 part-of → 绝航这个 entity 被切碎、两个事件成为孤岛、参与/讨论的人无法通过绝航相互发现 → **这是关系图最严重的失效**。',
      '  **part-of 与 about 互斥**：对同一对 (event, entity) 只输出**一条** event-entity 边。若事件围绕该对象展开（讨论/打/玩/合作），优先用 `part-of`；只有当事件只是顺带"提到"而非围绕它时才用 `about`。**不要同时输出两条**（part-of + about），后端会判为重复并合并。',
      '',
      '**第 3 步：积极建立 person-person 边（A 视角的一面之词即可，单向 directed=true）**',
      '  当两人 A、B 都指向同一 entity（如都玩绝航、都在某店打卡）→ 直接输出 A→entity 和 B→entity 两条 personEntityEdge 即可，图层会自动呈现 A↔entity↔B 的二跳连接。',
      '  在此之上，**只要发话人 A 亲口说出他与他人的关系定位，就积极抽 A→对方 的单向边**（B 是否在场 / 是否回应 / 是否同意都不影响），不要因"对方没背书"而吞掉这种 hub-grade 信号：',
      '  · 正向身份：「B 是我朋友 / 兄弟 / CP / 老婆 / 男友 / 师傅 / 同事 / 同学 / 队友」→ A→B directed=true，relationType 取对应词。',
      '  · 负向 / 紧张：「B 跟我闹翻 / B 拉黑我 / 我讨厌 B / B 是我前任」→ A→B directed=true，relationType=hostile / antagonist / rival / ex 等。',
      '  · 仰慕 / 单向情感：「我在追 B / B 是我偶像 / B 让我崇拜」→ A→B directed=true relationType=admirer 等。',
      '  · 层级（顺手填 hierarchy）：「B 是我老板 / 老师 / 师傅 / 前辈」→ hierarchy=superior；「B 是我徒弟 / 学生 / 下属」→ subordinate。',
      '  · **关键**：A 提及第三方关系（如 "我听说 B 和 C 在一起了" / "B 跟 C 同班"）——这是 A 的转述，不要直接输出 B→C 边（会因严格自证丢弃）；可输出 A→B 一条 friend/colleague 表达 A 与 B 的认识关系（如果 A 与 B 本身确有关系陈述），否则跳过该信号。',
      '  · 一句话规则：**只要发话人自己说"我和 X 是某关系"就建边，单向、不需双方确认**。',
      '  · **依然要避免的幻觉**：',
      '    - 因为"共同兴趣 / 共同参与同一事件"就脑补 friend → 错。共享兴趣只走 entity 二跳，**不要**伪造身份性 person-person 边。',
      '    - 因为聊天中互相 @ 一两次 / 简单回复就脑补 friend → 错。要走下面的 familiar 行为观察通道，**且阈值很高**。',
      '',
      '**第 3 步补：familiar 弱关系（行为观察通道，慎用，weight 会比身份关系低）**',
      '  当 A 与 B 在窗口内**有大量直接互动**——必须同时满足：',
      '  (1) 同一窗口内 A、B 直接对话 ≥ 3 轮且**两人都主动说过**话（不是一方喊一方沉默）；',
      '  (2) 互相直呼对方昵称 / @ / 引用回复对方消息至少 2 次；',
      '  (3) 不是命令式 / 工具性互动（不是「@bot 帮我查」「@admin 申请进群」这种）。',
      '  满足时可输出**一条** A→B relationType="familiar" directed=true（A 是互动主导/先发起方）。evidence 必须列举至少 2 条 A 自己发的、能体现互动的消息（严格自证仍生效）。',
      '  **familiar 的目的**：捕捉「这两人是常一起说话的熟人」这种**纯行为观察信号**，不预设关系性质。',
      '  **familiar 的反面清单**（任一命中就不要建）：',
      '  · 仅旁观式同框（都在群里但没对话） → 不建；',
      '  · 单方喊话无回应 → 不建；',
      '  · 与机器人 / Aalis 自己的互动 → 不建；',
      '  · 已经有更强的关系边（friend / cp / colleague / mentor…）→ 不再加 familiar，避免冗余。',
      '',
      '## 关于「Aalis 自己」（机器人本体）',
      '- 窗口里 assistant 消息会被渲染为 `(nickname(userId))` 同用户消息一样的格式，其中 userId 是 **Aalis 在该平台上真实的 selfId**（如 `(Aalis(10000))`）。这时你**可以**把它当成一个普通 person 抽出来（用真实 personPlatform / personUserId），让 Aalis 与人的互动也能进入关系图。',
      '- **绝不要凭空生成占位符**：当 assistant 行渲染成 `Aalis（本机器人）`（CJK 全角括号 = 元数据缺失）时，**禁止**给它任何 person 字段；也**禁止**自己编 `platform="aalis"` 或 `userId ∈ {aalis, self, me, bot, assistant, 本机器人}` 这种伪 id —— 后端会一律剔除。这一轮就当 Aalis 没出现，跳过。',
      '- **绝对禁止使用 `undefined` / `unknown` / `null` / `none` / `n/a` / 空字符串作为 platform 或 userId 的值**（无论是字符串字面量还是 JSON null）。如果你不知道某个 person 的确切 platform/userId，**就不要把这个人写进 persons 数组、也不要在任何边里引用 ta**。宁可漏抽一个人，也不要造伪 id（造了也会被后端丢弃，纯粹浪费 token）。',
      '- 这条规则比 hub-first 优先：宁可少抽，也不要造假 id。',
      '',
      '## 输出格式（严格 JSON）',
      '严格输出**单个 JSON 对象**（不要任何解释文字、不要 ```json 包裹），结构如下：',
      '{',
      '  "persons": [{ "platform": str, "userId": str, "displayName"?: str }],',
      '  "events": [{ "refKey": str, "existingEventId"?: str|null, "title": str(<=30字), "summary"?: str(<=80字), "category"?: "discussion"|"conflict"|"collaboration"|"incident"|"milestone"|"other", "scope"?: "global", "evidence": { "messageIds": str[], "quote": str } }],',
      '  "entities": [{ "refKey": str, "existingEntityId"?: str|null, "name": str(<=20字), "aliases"?: str[], "summary"?: str(<=80字), "entityKind": "topic"|"place"|"thing"|"work", "evidence": { "messageIds": str[], "quote": str } }],',
      '  "personEventEdges": [{ "personPlatform": str, "personUserId": str, "eventRefKey": str, "role": "initiator"|"participant"|"witness"|"target"|"reporter", "sentiment"?: "positive"|"negative"|"neutral"|"mixed", "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],',
      '  "personEntityEdges": [{ "personPlatform": str, "personUserId": str, "entityRefKey": str, "role": "enthusiast"|"participant"|"owner"|"creator"|"critic"|"visitor"|"mentioned", "sentiment"?: "positive"|"negative"|"neutral"|"mixed", "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],',
      '  "personPersonEdges": [{ "fromPlatform": str, "fromUserId": str, "toPlatform": str, "toUserId": str, "relationType": str, "directed"?: bool, "hierarchy"?: "superior"|"peer"|"subordinate"|"unknown", "description"?: str(<=40字), "evidence": { "messageIds": str[], "quote": str } }],',
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
      '- **事件 scope 字段**：**缺省即可**（= 当前会话内的事，如某群约局、某私聊吵架，后端自动绑定当前 sessionId）。**仅当**事件**显式跨会话/跨平台**（如双十一、世界杯、某社会热点新闻被多个群讨论）时填 `"global"`。填错 `global` 会导致两个群里其实独立的"约定下周聚餐"被错误合并；不确定就**不要写** scope 字段。',
      '- **事件锚定原则（与 hub-first 配合）**：建一个 event 时先问自己——',
      '  · 「它围绕什么具名对象？」→ 有 → 必须按第 1/2 步抽 entity 并输出 part-of 边（首选路径）。',
      '  · 「它是纯人际事件？」（如 A 与 B 吵架/告白/和好/绝交/退群/相遇，无任何具名对象）→ 允许独立 event，但**必须配合至少一条 personEventEdge 把所有相关方挂上 + 一条 personPersonEdge 表达关系性质**（如 conflict/friend/hostile/reconciled）。否则该事件会沦为孤立浮岛。',
      '  · 「围绕对象和人际关系都没有？」→ 不要建 event。',
      '',
      '## ⚠️ 反孤儿节点（强制）',
      '- 每一个你创建的 person / event / entity，**必须至少被一条边引用**（personEvent / eventEvent / eventEntity 或 personEntity / entityEntity / personPerson）。',
      '- 不要写"光杆节点"——若你不打算给它任何边，就**直接从 persons / events / entities 数组里去掉**。提取器会丢弃这种孤立节点，等于白做。',
      '- persons 数组的作用是登记"这一轮你打算与之建立关系的人"，**不是聊天窗口参与者花名册**。窗口里只是旁观的人若没有任何边引用，请不要列出。',
      '- 自检顺序：先列边 → 边中提到哪些 person id / refKey → 只把这些 person / refKey 写进 persons / events / entities。',
      '',
      '- **以下情况不要建 event**（负面清单）：',
      '  · 纯言语声明（无行为支撑）：「我喜欢 X / 我讨厌 Y / 我有 Z / 我会 W」——若 evidence 中**仅有声明性表态，没有行为事实**（参与时长 / 制作 / 购买 / 直播 / 规律互动…），则这是画像属性，由 plugin-user-profile 处理；**也不要建 event**。person-entity 边同理：单句声明不建，详见下方「person-entity 门槛」。',
      '  · 元对话/元请求：「帮我记一下…」「测试一下你的关系系统」「这是我」——对工具的指令不是世界中发生的事，**不要建 event**。',
      '  · 问候/客套/无信息内容：「在吗」「早」「哈哈」「ok」——什么都不建。',
      '- event.title 应反映**何事 / 何主题**，鼓励包含时间锚点（如「2024-某周开黑《三角洲》」）。允许「围绕《三角洲》的讨论」「关于关系系统的复盘对话」这类**对话型事件**标题；但需 evidence.messageIds ≥ 2 条作为支撑，并尽量通过 eventEntityEdges part-of 把话题实体挂上，让事件可被检索。',
      '',
      '## 正确建模示例',
      '### 示例 1a：纯偏好声明（无行为证据）→ 留给 user-profile，本插件全空',
      "原话：'我喜欢打三角洲，157也喜欢'（Alice 单句声明，窗口内无其他行为记录）",
      '✅ 正确输出：persons: [], entities: [], personEntityEdges: []  ← 仅声明性表态，无行为事实；画像属性由 user-profile 处理。',
      '❌ 不要：role="enthusiast"（无行为证据）。若想保留态度信号但已有其他边，在那条边上加 sentiment=positive 即可。',
      '',
      '### 示例 1b：行为性热情 → 建 enthusiast 边（多人共同指向同实体，揭示社会连接）',
      "原话：'Alice 三角洲玩了两年还做了个 mod；157 每天晚上直播三角洲'",
      '✅ 正确输出：',
      '  entities: [{ refKey: "e1", name: "三角洲", entityKind: "work" }]',
      '  personEntityEdges: [{ Alice→e1 role=enthusiast sentiment=positive }, { 157→e1 role=enthusiast sentiment=positive }]',
      '  — 有行为性证据（长期参与 + 创作/直播），且两人共同指向同实体，揭示潜在社会连接。',
      '❌ 不要：仅凭一句"喜欢"建 enthusiast；必须有行为事实支撑。',
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
      '### ⭐ 示例 4：Hub-first（同一实体的不同事件必须共享同一 entity refKey）',
      '场景：一段窗口里 A、B 在「打绝航」；同窗口 C、D 在「讨论绝航的剧情」。这是 Aalis 最容易失忆的地方。',
      '❌ **致命错误**（把绝航溶解在事件标题里、不抽 entity / 不挂 part-of）：',
      '  events: [{ refKey: "ev1", title: "打绝航" }, { refKey: "ev2", title: "讨论绝航" }]',
      '  entities: []  ← 错！绝航被切碎，A/B/C/D 无法通过它相互发现，Aalis 看图只能看到两个孤岛。',
      '✅ 正确：先抽 entity，再让事件挂上去：',
      '  entities: [{ refKey: "e1", name: "绝航", entityKind: "work" }]',
      '  events: [{ refKey: "ev1", title: "开黑《绝航》", category: "collaboration" }, { refKey: "ev2", title: "《绝航》剧情讨论", category: "discussion" }]',
      '  personEventEdges: [{ A→ev1 participant }, { B→ev1 participant }, { C→ev2 participant }, { D→ev2 participant }]',
      '  eventEntityEdges: [{ ev1→e1 part-of }, { ev2→e1 part-of }]  ← **关键**：两个事件共享同一 e1，A/B 和 C/D 通过绝航形成二跳社会连接。',
      '  注意：**不要**额外输出 personPersonEdges 把 A→C 串成 friend（共享兴趣 ≠ 关系，那是幻觉）。让图层自然呈现 A↔e1↔C 即可。',
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
      '- **hierarchy 维度（与 directed 正交）**：当 from 的话语**明确**透露与 to 的高低 / 平级关系时，填 hierarchy 字段（`superior` / `peer` / `subordinate` / `unknown`）。语义统一为「from 视角下 to 处于什么位置」：',
      '  · "X 是我师傅 / 老板 / 老师 / 老前辈" → from=X 的说话人，to=X，hierarchy="superior"（对方更高）；',
      '  · "X 是我徒弟 / 下属 / 小弟" → hierarchy="subordinate"（对方更低）；',
      '  · "我跟 X 是同学 / 同事 / 朋友 / 兄弟" → hierarchy="peer"；',
      '  · 不确定 / 不适用（如 cp、rival、antagonist 这类水平关系或纯情感） → 省略字段或填 "unknown"。',
      '  · **不要靠 relationType 文本去暗示层级**（不要写 "mentor-superior" 这种），把层级正交分离到 hierarchy 字段。',
      '- **person-entity 门槛**（记「结构性连接」，不记「态度声明」）：',
      '  · `participant / owner / creator / visitor / mentioned` —— 行为性角色，有 evidence 支持即可建边；可附加 sentiment 字段表达态度方向。',
      '  · `enthusiast` —— 需要**深度行为性证据**（规律参与 / 制作内容 / 购买 / 直播 / 多人共同指向同一实体揭示社会连接）；单句「我喜欢 X」**不够**，改用 participant + sentiment=positive。',
      '  · `critic` —— 需要**主动行为性批评**（写了评测 / 公开对抗 / 反复表达负面立场）；单次「我不喜欢 / 我讨厌」**不够**，改用 mentioned + sentiment=negative。',
      '  · 若不确定是行为性还是纯声明，**省略该边**，交给 plugin-user-profile。',
      '- ⭐ **角色 / 关系升级（重要：让弱关系跟随新证据成长）**：邻居子图（== 候选人已有 1 跳邻居子图 ==）里的 `role=` / 关系类型代表**当前已有的快照**。如果本轮窗口里观察到**更强的信号**，请直接输出**更强的角色/关系**——后端会按 rank 比较自动用强 role 替换旧 role（同一 person-entity / person-event 同对只保留最强一条）：',
      '  · 人-实体升级路径（按强度排序）：`mentioned → visitor → participant → critic → owner → creator → enthusiast`。例：',
      '    - 邻居里有 `entity[e1] 绝航 (work) role=mentioned w=0.1`，本轮 A 又说「我玩绝航玩了两年，还做了个 mod」 → **直接输出** `personEntityEdges: [{ A→e1 role=enthusiast sentiment=positive existingEntityId=e1 }]`（用 existingEntityId 复用同一实体），后端会把 mentioned 升级为 enthusiast。',
      '    - 邻居里有 `role=visitor`，本轮 A 说「我又去了那家店，买了三件」 → 输出 `role=owner` 或 `participant`。',
      '    - 邻居里有 `role=participant`，本轮 A 持续做开发/创作内容 → 输出 `role=creator` 或 `enthusiast`。',
      '  · 人-事件升级路径：`witness / reporter → participant → target → initiator`。例：邻居 `role=witness`，本轮证据显示 A 实际是发起者 → 输出 `role=initiator`。',
      '  · 人-人升级（仅 `familiar` 被视为占位）：邻居里 `person→B "familiar"`，本轮 A 说「B 是我老婆 / 兄弟 / 师傅 / 仇人」 → 输出对应的 friend/cp/mentor/hostile 等**真实关系边**（同时填 hierarchy）。后端会自动废除占位 familiar 边。其他 person-person 关系（friend/colleague/mentor 等）**不互相升级合并**——同一对人可同时是同事+朋友，让两条边并存。',
      '  · **判断依据**：必须有**本轮窗口内的新证据**支撑升级，不能凭空"我觉得应该更强"就升；evidence.messageIds 必须来自本轮新消息。',
      '  · **降级不允许**：本轮没有更强信号时，**不要**主动把已有的强 role 写成弱 role（如把 enthusiast 写成 mentioned）；省略该边即可，后端会照常衰减。',
      '- **event-entity / entity-entity 边不要求严格自证**（无 fromPerson），但仍需 evidence + quote。仅在明显能从原文看出【事件关于/使用 某实体】、【实体 part-of/contains 实体】时才输出。',
      '- **description 字段是可选注释**（≤ 40 字中文/英文），只在 role / relationType 代号不足以表达语义时与以补充（例：「绝巴 part-of 三角洲」可加 description="三角洲的高难度关卡"）。能靠 role/relationType 表达清楚的别冗余加。',
      '- **别名识别（is-alias-of）**：当窗口内同一句或紧邻句出现「A 又叫 / 也叫 / 别名 / 就是 B」「A 是 B 的小号 / 马甲」等等同表述时：',
      '  · 若 A、B 都是人物 → personPersonEdges 输出 relationType="is-alias-of"（或 "alt-account-of" 用于小号），directed=true（A 是 B 的别名/小号）。',
      '  · 若 A、B 都是实体 → entityEntityEdges 输出 relationType="is-alias-of"，directed=true。',
      '  · **eventEventEdges 严禁使用 `is-alias-of`**：事件天然带 sessionScope，不同会话/群里同名事件（"群A 聊三角洲" vs "群B 聊三角洲"）是**不同事件**而非别名。若想表达"同一主题在多个群发生"，请按上文"跨会话共享主题"规则建 `scope=global` hub event 并用 `part-of` 挂接。后端会拒绝跨 scope 的 event is-alias-of。',
      '  · 不要直接合并两个 entity / person 节点，让用户决定是否合并。',
      '- **part-of 强制挂载（hub-first 落地）**：若事件标题中含有任何具名对象（作品 / 游戏 / 地点 / 物品 / 话题 / 关卡 / mod / 比赛名…），**必须**：(1) 把它单独抽成 entity；(2) 同时输出一条 eventEntityEdges relationType="part-of" 把事件挂在该 entity 下。即便该 entity 在本窗口里只出现一次也要抽，因为它可能被未来的其他窗口复用，从而把"打X / 讨论X / 安利X / 吐槽X" 等围绕同一对象的事件串成一张可遍历的网。**漏挂 part-of = 制造孤岛 = Aalis 失忆的最大单一原因**。',
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
      opts?.crossSession
        ? '【跨会话模式】下方消息聚合了多个会话（群聊/私聊/平台），每行行首 `[sid:xxx]` 标注来源会话 id。请把不同 sid 之间**默认视为彼此独立的语境**，除非证据明确表明同一对象/事件被跨会话讨论才把 event.scope 标为 `global`；person / entity 节点天然全局共享，可正常跨 sid 累计证据。\n' +
          '【跨会话 hub 建模规则】当本窗口出现 ≥2 个不同 sid 都在围绕同一抽象主题（如"工会战""周末聚餐计划""某游戏开黑"）展开各自的讨论/约局/吐槽时：\n' +
          '- 为该共同主题建一个 `scope=global` 的 **hub event**（title 取主题本身，如"工会战"），并为每个 sid 各自建一个**缺省 scope**（即不写 scope 字段）的**子事件**（title 带 sid 语境，如"A群工会战集结(2025-05-20)"）。\n' +
          '- 通过 `eventEventEdges` `relationType="part-of"` 把每个子事件挂到 hub event 下，directed=true（from=子, to=hub）。\n' +
          '- candidates 中标有 `scope=global` 的事件**可直接复用为 hub**（existingEventId 填它的 id）；标有 `scope=other:xxx` 的事件**不要直接 reinforce**（不同 session 隔离），但可以输出 part-of 边把它和你新建的 hub 挂在一起。\n' +
          '- 当各 sid 只是恰好提到同一个具名对象但无共同事件主线时，**不要建 hub event**，按现有规则用 entity + personEntityEdge 关联即可。'
        : '',
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

  // 走共享 util：剥 ```json fence、配平 {}、修字符串内裸引号、补尾部 } / ] 等。
  const { parsed } = parseLLMJsonObject(trimmed);
  if (!parsed) return { kind: 'parse-error' };

  // 共享 util 已保证 parsed 是非空对象（非数组、非 null、非原始值）。
  const obj = parsed as unknown as LLMExtraction;
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
