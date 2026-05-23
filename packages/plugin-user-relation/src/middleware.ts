/**
 * 关系图注入 middleware —— 在 LLM 调用前，向 system 提示注入：
 * - 当前主发言者的近邻事件 / 人际关系摘要
 *
 * 设计原则：
 * - 仅在 direct/immediate 触发下注入（避免 idle/interval 占用 token）
 * - 与 plugin-user-profile 解耦：profile 侧重"是谁/喜好"，relation 侧重"经历过什么/与谁有关系"
 * - 控制注入体积：硬上限 maxEvents/maxRelations，避免 token 超支
 * - 失败优雅降级：任何异常仅 debug log，绝不阻断 agent 流程
 */
import type { Context } from '@aalis/core';
import '@aalis/plugin-agent-api'; // declaration merging：注册 'agent:llm:before' HookContextMap
import type { Message } from '@aalis/plugin-message-api';
import type { RelationService } from './service.js';
import type { EventNode, PersonEventEdge, PersonPersonEdge } from './types.js';

export interface MiddlewareConfig {
  enabled: boolean;
  maxEvents: number;
  maxRelations: number;
  /** 仅 sessionType === 'group' 时注入；其他情况按需也注入 */
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
  const nb = await service.getNeighborhood(personId);
  const events = nb.events;
  const personEventEdges = nb.edges.filter((e): e is PersonEventEdge => e.kind === 'person-event');
  const personPersonEdges = nb.edges.filter((e): e is PersonPersonEdge => e.kind === 'person-person');
  if (events.length === 0 && personPersonEdges.length === 0) return null;

  const lines: string[] = [
    '# 当前对话者的关系图速览',
    '以下是从历史对话中沉淀的关系/事件记录，仅供你判断语境。若用户当下发言与此不符，以当下为准、不要硬撑：',
    '',
  ];

  if (events.length > 0) {
    const roleByEventId = new Map<string, PersonEventEdge>();
    for (const e of personEventEdges) {
      const prev = roleByEventId.get(e.toEventId);
      if (!prev || e.lastReinforcedAt > prev.lastReinforcedAt) roleByEventId.set(e.toEventId, e);
    }
    const sorted = [...events].sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt).slice(0, cfg.maxEvents);
    lines.push('## 近期参与的事件');
    for (const ev of sorted) {
      const r = roleByEventId.get(ev.id);
      const role = r?.role ?? 'participant';
      const sentiment = r?.sentiment ? ` / ${r.sentiment}` : '';
      lines.push(`- [${role}${sentiment}] ${ev.title}${ev.summary ? `：${truncate(ev.summary, 50)}` : ''}`);
    }
    lines.push('');
  }

  if (personPersonEdges.length > 0) {
    const sorted = [...personPersonEdges].sort((a, b) => b.weight - a.weight).slice(0, cfg.maxRelations);
    lines.push('## 与其他人的关系');
    for (const edge of sorted) {
      const other = edge.fromPersonId === personId ? edge.toPersonId : edge.fromPersonId;
      const otherLabel = other.split(':')[1] ?? other;
      lines.push(`- ${formatDirection(edge, personId)} ${edge.relationType} → ${otherLabel}`);
    }
  }

  return lines.join('\n').trim();
}

function formatDirection(edge: PersonPersonEdge, self: string): string {
  if (!edge.directed) return '↔';
  if (edge.fromPersonId === self) return '→';
  return '←';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { EventNode };
