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
import type { EventNode, PersonEntityEdge, PersonEventEdge, PersonNode, PersonPersonEdge } from './types.js';

export interface MiddlewareConfig {
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
          metadata: { source: 'user-relation' },
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
  const personEventEdges = subgraph.edges.filter((e): e is PersonEventEdge => e.kind === 'person-event');
  const personPersonEdges = subgraph.edges.filter((e): e is PersonPersonEdge => e.kind === 'person-person');
  const personEntityEdges = subgraph.edges.filter((e): e is PersonEntityEdge => e.kind === 'person-entity');

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
      lines.push(`- ${ev.title}${category} — ${role}${sentiment}${summary}`);
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
      lines.push(`- ${formatDirection(edge, personId)} ${edge.relationType} → ${label}`);
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
      lines.push(`- ${ent.name} [${ent.entityKind}] — ${edge.role}${s}`);
    }
    lines.push('');
  }

  // ---- 高频共现伙伴（基于事件桥的隐式二跳） ----
  if (cfg.maxCooccurrencePartners > 0) {
    const cooccurrence = new Map<string, { count: number; lastTs: number; eventTitles: string[] }>();
    const eventById = new Map(subgraph.events.map(e => [e.id, e]));
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
        lines.push(`- ${label} 共现 ${v.count} 次（如：${sampleTitles}）`);
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
  if (person?.displayName) return `${person.displayName}(${person.userId})`;
  return fallbackId.split(':')[1] ?? fallbackId;
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
