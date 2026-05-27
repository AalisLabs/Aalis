/**
 * 关系图注入 middleware —— 在 LLM 调用前，向 system 提示注入：
 * - 当前主发言者的子图速览（按 BFS 深度/宽度展开）
 * - 每个事件的"其他参与者"（揭示群体动态）
 * - 高频共现伙伴（基于事件桥的隐式二跳）
 *
 * 设计原则：
 * - 仅在 direct/immediate 触发下注入（避免 idle/interval 占用 token）
 * - 与 plugin-user-profile 解耦：profile 侧重"是谁/喜好"，relation 侧重"经历过什么/与谁有关系"
 * - 深度 / 宽度由配置控制；带 visited 防环
 * - 失败优雅降级：任何异常仅 debug log，绝不阻断 agent 流程
 */
import type { Context } from '@aalis/core';
import '@aalis/plugin-agent-api'; // declaration merging：注册 'agent:llm:before' HookContextMap
import type { Message } from '@aalis/plugin-message-api';
import type { RelationService } from './service.js';
import type {
  EntityNode,
  EventEventEdge,
  EventNode,
  PersonEntityEdge,
  PersonEventEdge,
  PersonNode,
  PersonPersonEdge,
} from './types.js';

interface MiddlewareConfig {
  enabled: boolean;
  /** BFS 最大深度（0=仅起点，1=直接邻居，2=同事件其他参与者 / 朋友的朋友） */
  maxDepth: number;
  /** 单节点展开邻居上限（按 weight 降序） */
  maxBreadth: number;
  /** 注入事件条数上限 */
  maxEvents: number;
  /** 注入人际关系条数上限 */
  maxRelations: number;
  /** 单事件展示的"其他参与者"上限，超出显示 +N 人 */
  maxParticipantsPerEvent: number;
  /** 共现伙伴小节展示上限；0 关闭 */
  maxCooccurrencePartners: number;
  /** 全局热点：最近被提及的事件数量，0 关闭 */
  maxGlobalHotEvents: number;
  /** 全局热点：最近被提及的实体数量，0 关闭 */
  maxGlobalHotEntities: number;
  /** 仅 sessionType === 'group' 时注入 */
  groupOnly: boolean;
  debug: boolean;
}

interface LLMBeforeData {
  messages: Message[];
  tools: unknown[];
  sessionId?: string;
  userId?: string;
  platform?: string;
  triggerType?: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive';
}

export function registerRelationMiddleware(ctx: Context, service: RelationService, cfg: MiddlewareConfig): void {
  if (!cfg.enabled) return;
  ctx.middleware('agent:llm:before', async (data: LLMBeforeData, next) => {
    try {
      const block = await buildBlock(service, data, cfg);
      if (block) {
        const idx = data.messages.findIndex(m => m.role === 'system');
        const insertAt = idx >= 0 ? idx + 1 : 0;
        data.messages.splice(insertAt, 0, {
          role: 'system',
          content: block,
          metadata: { injector: 'user-relation' },
        });
      }
    } catch (err) {
      if (cfg.debug) ctx.logger.debug(`[user-relation] middleware 异常: ${stringifyErr(err)}`);
    }
    await next();
  });
}

async function buildBlock(
  service: RelationService,
  data: LLMBeforeData,
  cfg: MiddlewareConfig,
): Promise<string | null> {
  const trigger = data.triggerType ?? 'direct';
  if (trigger !== 'direct' && trigger !== 'immediate') return null;
  if (!data.userId || !data.platform) return null;

  if (cfg.groupOnly) {
    const looksLikeGroup = data.messages.some(m => {
      const meta = (m.metadata as { groupId?: string; sessionType?: string } | undefined) ?? {};
      return !!meta.groupId || meta.sessionType === 'group';
    });
    if (!looksLikeGroup) return null;
  }

  const personId = `${data.platform}:${data.userId}`;
  const subgraph = await service.traverseSubgraph({
    startNodeIds: [personId],
    maxDepth: cfg.maxDepth,
    maxBreadth: cfg.maxBreadth,
  });

  const self = subgraph.persons.find(p => p.id === personId);
  if (!self && subgraph.events.length === 0) return null;

  const personById = new Map(subgraph.persons.map(p => [p.id, p]));
  const entityById = new Map(subgraph.entities.map(e => [e.id, e]));
  const eventById = new Map(subgraph.events.map(e => [e.id, e]));
  const personEventEdges = subgraph.edges.filter((e): e is PersonEventEdge => e.kind === 'person-event');
  const personPersonEdges = subgraph.edges.filter((e): e is PersonPersonEdge => e.kind === 'person-person');
  const personEntityEdges = subgraph.edges.filter((e): e is PersonEntityEdge => e.kind === 'person-entity');
  const eventEventEdges = subgraph.edges.filter((e): e is EventEventEdge => e.kind === 'event-event');

  // 自己参与的事件（用于"近期事件"小节）
  const selfEventEdges = personEventEdges.filter(e => e.fromPersonId === personId);
  const selfEventIds = new Set(selfEventEdges.map(e => e.toEventId));
  const selfEvents = subgraph.events.filter(e => selfEventIds.has(e.id));

  // 自己的人-人边
  const selfPpEdges = personPersonEdges.filter(e => e.fromPersonId === personId || e.toPersonId === personId);

  // 自己的人-实体边
  const selfPentEdges = personEntityEdges.filter(e => e.fromPersonId === personId);

  if (selfEvents.length === 0 && selfPpEdges.length === 0 && selfPentEdges.length === 0) return null;

  const lines: string[] = [
    '# 当前对话者的关系图速览',
    '以下是从历史对话中沉淀的关系/事件记录，仅供你判断语境。若用户当下发言与此不符，以当下为准、不要硬撑：',
    '',
  ];

  // ---- 近期事件（含其他参与者） ----
  if (selfEvents.length > 0) {
    const roleByEventId = new Map<string, PersonEventEdge>();
    for (const e of selfEventEdges) {
      const prev = roleByEventId.get(e.toEventId);
      if (!prev || e.lastReinforcedAt > prev.lastReinforcedAt) roleByEventId.set(e.toEventId, e);
    }
    const sortedEvents = [...selfEvents]
      .sort((a, b) => (b.lastMentionedAt ?? b.lastReinforcedAt) - (a.lastMentionedAt ?? a.lastReinforcedAt))
      .slice(0, cfg.maxEvents);

    lines.push('## 近期参与的事件');
    for (const ev of sortedEvents) {
      const r = roleByEventId.get(ev.id);
      const role = r?.role ?? 'participant';
      const sentiment = r?.sentiment ? ` / ${r.sentiment}` : '';
      const category = ev.category ? ` [${ev.category}]` : '';
      const summary = ev.summary ? `：${truncate(ev.summary, 60)}` : '';
      const tier = quickTier(ev.lastPageRank, ev.lastPageRankAt, ev.weight, ev.lastReinforcedAt);
      const tierTag = tierToTag(tier);
      const aliasTag = ev.aliases && ev.aliases.length > 0 ? `（别名: ${ev.aliases.slice(0, 2).join('/')}）` : '';
      lines.push(`- ${ev.title}${aliasTag}${category}${tierTag} — ${role}${sentiment}${summary}`);
      // 其他参与者
      const others = personEventEdges
        .filter(e => e.toEventId === ev.id && e.fromPersonId !== personId)
        .sort((a, b) => b.weight - a.weight);
      if (others.length > 0) {
        const visible = others.slice(0, cfg.maxParticipantsPerEvent);
        const overflow = others.length - visible.length;
        const parts = visible.map(e => {
          const p = personById.get(e.fromPersonId);
          const label = displayLabel(p, e.fromPersonId);
          const s = e.sentiment ? `${shortSentiment(e.sentiment)}` : '';
          return `${label}(${e.role}${s ? `,${s}` : ''})`;
        });
        const tail = overflow > 0 ? ` +${overflow} 人` : '';
        lines.push(`  └ 参与者: ${parts.join(', ')}${tail}`);
      }
      // Hub 事件：该事件 part-of 一个 global hub → 暴露 hub 与其他兄弟子事件
      const partOfEdges = eventEventEdges.filter(e => e.fromEventId === ev.id && e.relationType === 'part-of');
      for (const pe of partOfEdges) {
        const hub = eventById.get(pe.toEventId);
        if (!hub || hub.sessionScope !== 'global') continue;
        const siblings = eventEventEdges
          .filter(e => e.toEventId === hub.id && e.relationType === 'part-of' && e.fromEventId !== ev.id)
          .map(e => eventById.get(e.fromEventId))
          .filter((x): x is EventNode => !!x)
          .slice(0, 3);
        const siblingTxt = siblings.length > 0 ? `；兄弟会话事件: ${siblings.map(s => s.title).join('、')}` : '';
        lines.push(`  └ 所属跨会话话题: ${hub.title}${siblingTxt}`);
      }
    }
    lines.push('');
  }

  // ---- 直接人际关系 ----
  if (selfPpEdges.length > 0) {
    const sorted = [...selfPpEdges].sort((a, b) => b.weight - a.weight).slice(0, cfg.maxRelations);
    lines.push('## 与其他人的关系');
    for (const edge of sorted) {
      const otherId = edge.fromPersonId === personId ? edge.toPersonId : edge.fromPersonId;
      const other = personById.get(otherId);
      const label = displayLabel(other, otherId);
      const otherTier = other
        ? quickTier(other.lastPageRank, other.lastPageRankAt, undefined, other.lastSeenAt)
        : 'normal';
      lines.push(`- ${formatDirection(edge, personId)} ${edge.relationType} → ${label}${tierToTag(otherTier)}`);
    }
    lines.push('');
  }

  // ---- 关注/合作的事物实体 ----
  if (selfPentEdges.length > 0) {
    const sorted = [...selfPentEdges].sort((a, b) => b.weight - a.weight).slice(0, cfg.maxRelations);
    lines.push('## 关注/参与的事物');
    for (const edge of sorted) {
      const ent = entityById.get(edge.toEntityId);
      if (!ent) continue;
      const s = edge.sentiment ? ` / ${edge.sentiment}` : '';
      const tier = quickTier(ent.lastPageRank, ent.lastPageRankAt, ent.weight, ent.lastReinforcedAt);
      const aliasTag = ent.aliases && ent.aliases.length > 0 ? `（别名: ${ent.aliases.slice(0, 2).join('/')}）` : '';
      lines.push(`- ${ent.name}${aliasTag} [${ent.entityKind}]${tierToTag(tier)} — ${edge.role}${s}`);
    }
    lines.push('');
  }

  // ---- 高频共现伙伴（基于事件桥的隐式二跳） ----
  if (cfg.maxCooccurrencePartners > 0) {
    const cooccurrence = new Map<string, { count: number; lastTs: number; eventTitles: string[] }>();
    const directRelated = new Set<string>(
      selfPpEdges.map(e => (e.fromPersonId === personId ? e.toPersonId : e.fromPersonId)),
    );
    for (const ev of selfEvents) {
      const others = personEventEdges.filter(e => e.toEventId === ev.id && e.fromPersonId !== personId);
      for (const e of others) {
        if (directRelated.has(e.fromPersonId)) continue; // 直接关系已覆盖，不重复列
        const c = cooccurrence.get(e.fromPersonId) ?? { count: 0, lastTs: 0, eventTitles: [] };
        c.count++;
        c.lastTs = Math.max(c.lastTs, e.lastReinforcedAt);
        const title = eventById.get(ev.id)?.title;
        if (title && !c.eventTitles.includes(title)) c.eventTitles.push(title);
        cooccurrence.set(e.fromPersonId, c);
      }
    }
    const ranked = [...cooccurrence.entries()]
      .filter(([, v]) => v.count >= 2)
      .sort((a, b) => b[1].count - a[1].count || b[1].lastTs - a[1].lastTs)
      .slice(0, cfg.maxCooccurrencePartners);
    if (ranked.length > 0) {
      lines.push('## 高频共现伙伴（基于事件，非直接声明的关系）');
      for (const [otherId, v] of ranked) {
        const label = displayLabel(personById.get(otherId), otherId);
        const sampleTitles = v.eventTitles.slice(0, 2).join('、');
        // 共同关注的实体：自己 & 对方都 person-entity 指向的实体（除去 mentioned 仅提及）
        const selfEntIds = new Set(
          personEntityEdges.filter(e => e.fromPersonId === personId && e.role !== 'mentioned').map(e => e.toEntityId),
        );
        const sharedEntities = personEntityEdges
          .filter(e => e.fromPersonId === otherId && e.role !== 'mentioned' && selfEntIds.has(e.toEntityId))
          .map(e => entityById.get(e.toEntityId))
          .filter((x): x is EntityNode => !!x)
          .slice(0, 3);
        const sharedTxt = sharedEntities.length > 0 ? `；共同关注: ${sharedEntities.map(s => s.name).join('、')}` : '';
        lines.push(`- ${label} 共现 ${v.count} 次（如：${sampleTitles}）${sharedTxt}`);
      }
    }
  }

  // ---- 全局热点（与当前用户子图无关，按 lastMentionedAt 全局排序） ----
  if (cfg.maxGlobalHotEvents > 0 || cfg.maxGlobalHotEntities > 0) {
    const snap = await service.loadAll();
    const hotEvents =
      cfg.maxGlobalHotEvents > 0
        ? [...snap.events]
            .filter(e => typeof e.lastMentionedAt === 'number')
            .sort((a, b) => (b.lastMentionedAt ?? 0) - (a.lastMentionedAt ?? 0))
            .slice(0, cfg.maxGlobalHotEvents)
        : [];
    const hotEntities =
      cfg.maxGlobalHotEntities > 0
        ? [...snap.entities]
            .filter(e => typeof e.lastMentionedAt === 'number')
            .sort((a, b) => (b.lastMentionedAt ?? 0) - (a.lastMentionedAt ?? 0))
            .slice(0, cfg.maxGlobalHotEntities)
        : [];
    if (hotEvents.length > 0 || hotEntities.length > 0) {
      lines.push('');
      lines.push('## 最近热点（全局）');
      for (const ev of hotEvents) {
        const sum = ev.summary ? ` — ${truncate(ev.summary, 40)}` : '';
        lines.push(`- 事件: ${ev.title}${sum}`);
      }
      for (const ent of hotEntities) {
        const sum = ent.summary ? ` — ${truncate(ent.summary, 40)}` : '';
        lines.push(`- 实体: ${ent.name} [${ent.entityKind}]${sum}`);
      }
    }
  }

  return lines.join('\n').trim();
}

function formatDirection(edge: PersonPersonEdge, self: string): string {
  if (!edge.directed) return '↔';
  if (edge.fromPersonId === self) return '→';
  return '←';
}

function displayLabel(person: PersonNode | undefined, fallbackId: string): string {
  const base = person?.displayName
    ? `${person.displayName}(${person.userId})`
    : (fallbackId.split(':')[1] ?? fallbackId);
  return base;
}

/**
 * 中间件本地快速分级（不调 service.computeNodeScore 避免 O(N) 全图扫描）。
 *
 * 启发式：优先看 lastPageRank（如果 PR 计算过），否则用 weight + 最近活跃度兜底。
 * 只返 'core' / 'active'，'normal' 与 'edge' 都返 'normal'——middleware 标签只标"亮点"，避免冗杂。
 */
function quickTier(
  lastPageRank: number | undefined,
  lastPageRankAt: number | undefined,
  weight: number | undefined,
  lastActiveAt: number | undefined,
): 'core' | 'active' | 'normal' {
  const prFresh = (lastPageRankAt ?? 0) > 0;
  const pr = lastPageRank ?? 0;
  const w = weight ?? 0;
  const daysSince = lastActiveAt ? Math.max(0, (Date.now() - lastActiveAt) / 86400_000) : Number.POSITIVE_INFINITY;
  const recent = Number.isFinite(daysSince) && daysSince <= 7;
  if (prFresh && pr >= 0.05) return 'core';
  if (w >= 0.8) return 'core';
  if (prFresh && pr >= 0.02) return 'active';
  if (w >= 0.5 && recent) return 'active';
  return 'normal';
}

function tierToTag(tier: 'core' | 'active' | 'normal'): string {
  if (tier === 'core') return ' [核心]';
  if (tier === 'active') return ' [活跃]';
  return '';
}

function shortSentiment(s: string): string {
  if (s === 'positive') return '+';
  if (s === 'negative') return '-';
  if (s === 'neutral') return '~';
  return s;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { EventNode };
