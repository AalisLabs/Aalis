/**
 * Agent 工具：让 LLM 在 reasoning 中主动深挖关系图。
 *
 * 设计原则（单写者 + 与 profile 对称）：
 * - 关系图的「新建 / 强化 / 删除」由 extractor 单线程被动归纳，agent **不能** 直接写或删。
 * - agent 只暴露 3 个只读工具：expand / find_path / search_events。
 * - 想纠错？使用 `/relation cleanup` slash 命令（与 profile 的 `/profile clear` 对称）。
 * - 想让图记住某事？引导用户在对话中说出，extractor 自然会捕获。
 *
 * 这样可避免：
 *  #1 agent 与 extractor 同边并发新建竞争
 *  #2 同一事实被 agent + extractor 各计一次权重
 *  #3 cleanup 与 agent 写入相撞导致「幻象复活」
 *  #4 agent 误删用户珍贵关系且无法回滚
 *
 * 所有 depth/breadth 参数会被 hardMax 截断，防止 Agent 一次拉满爆 token。
 */
import type { Context } from '@aalis/core';
import { useToolService } from '@aalis/plugin-tools-api';
import type { RelationService } from './service.js';
import type {
  EntityNode,
  EventEventEdge,
  EventNode,
  PersonEntityEdge,
  PersonEventEdge,
  PersonNode,
  PersonPersonEdge,
  RelationEdge,
} from './types.js';

export interface ToolsConfig {
  enabled: boolean;
  /** 工具分组名（默认 'user-relation'） */
  group: string;
  /** Agent 调用时的默认 depth */
  defaultMaxDepth: number;
  /** Agent 调用时的默认 breadth */
  defaultMaxBreadth: number;
  /** 硬上限 depth；超过会被截断 */
  hardMaxDepth: number;
  /** 硬上限 breadth */
  hardMaxBreadth: number;
  /** searchEvents 默认 limit */
  searchEventsDefaultLimit: number;
  searchEventsHardMaxLimit: number;
  /** findPath 默认最大深度 */
  findPathDefaultMaxDepth: number;
  findPathHardMaxDepth: number;
  debug: boolean;
}

export function registerRelationTools(ctx: Context, service: RelationService, cfg: ToolsConfig): void {
  if (!cfg.enabled) return;
  const tools = useToolService(ctx);
  const groupName = cfg.group || 'user-relation';

  tools.registerGroup({
    name: groupName,
    label: '人物关系图',
    description:
      '查询用户关系图（扩展邻域 / 关系链 / 搜事件）+ 删错边纠正。新建与强化由后台被动 LLM 归纳，不在工具中暴露。',
  });

  // ---- expand_person ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_expand_person',
        description:
          '以某人为中心按 BFS 展开人物关系子图。返回子图中的人、事件、边。用于回答"X 跟谁有关系 / 参与了什么事件"。',
        parameters: {
          type: 'object',
          properties: {
            person_id: {
              type: 'string',
              description: '人物 ID，格式 platform:userId（如 onebot:1234567）',
            },
            max_depth: {
              type: 'number',
              description: `BFS 最大深度（0=仅此人；1=直接邻居；2=同事件其他参与者 / 朋友的朋友）。默认 ${cfg.defaultMaxDepth}，硬上限 ${cfg.hardMaxDepth}`,
            },
            max_breadth: {
              type: 'number',
              description: `单节点展开邻居上限（按 weight 降序）。默认 ${cfg.defaultMaxBreadth}，硬上限 ${cfg.hardMaxBreadth}`,
            },
          },
          required: ['person_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const personId = String(args.person_id ?? '').trim();
      if (!personId.includes(':')) return JSON.stringify({ error: 'person_id 格式应为 platform:userId' });
      const depth = clampNum(args.max_depth, cfg.defaultMaxDepth, 0, cfg.hardMaxDepth);
      const breadth = clampNum(args.max_breadth, cfg.defaultMaxBreadth, 1, cfg.hardMaxBreadth);
      const sub = await service.traverseSubgraph({
        startPersonIds: [personId],
        maxDepth: depth,
        maxBreadth: breadth,
      });
      return JSON.stringify(serializeSubgraph(sub), null, 2);
    },
  });

  // ---- find_path ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_find_path',
        description: '在两人之间寻找最短关系链（经过的边可包含事件作为桥）。找不到返回 null。',
        parameters: {
          type: 'object',
          properties: {
            from_person_id: { type: 'string', description: '起点人物 ID (platform:userId)' },
            to_person_id: { type: 'string', description: '终点人物 ID (platform:userId)' },
            max_depth: {
              type: 'number',
              description: `最大边数（路径长度上限）。默认 ${cfg.findPathDefaultMaxDepth}，硬上限 ${cfg.findPathHardMaxDepth}`,
            },
          },
          required: ['from_person_id', 'to_person_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const from = String(args.from_person_id ?? '').trim();
      const to = String(args.to_person_id ?? '').trim();
      if (!from.includes(':') || !to.includes(':')) {
        return JSON.stringify({ error: 'person_id 格式应为 platform:userId' });
      }
      const depth = clampNum(args.max_depth, cfg.findPathDefaultMaxDepth, 1, cfg.findPathHardMaxDepth);
      const path = await service.findPath(from, to, depth);
      if (!path) return JSON.stringify({ found: false });
      return JSON.stringify(
        {
          found: true,
          length: path.edges.length,
          nodes: path.nodes.map(n => serializeNode(n)),
          edges: path.edges.map(e => serializeEdge(e)),
        },
        null,
        2,
      );
    },
  });

  // ---- search_events ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_search_events',
        description: '按关键词 substring 搜索事件（匹配标题 + summary，不区分大小写）。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '关键词；留空则返回最近的事件' },
            days: { type: 'number', description: '仅返回最近 N 天内强化过的事件；0 / 不传 = 不限' },
            limit: {
              type: 'number',
              description: `结果上限。默认 ${cfg.searchEventsDefaultLimit}，硬上限 ${cfg.searchEventsHardMaxLimit}`,
            },
          },
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const keyword = typeof args.keyword === 'string' ? args.keyword : undefined;
      const days = typeof args.days === 'number' && args.days > 0 ? args.days : undefined;
      const limit = clampNum(args.limit, cfg.searchEventsDefaultLimit, 1, cfg.searchEventsHardMaxLimit);
      const events = await service.searchEvents({ keyword, days, limit });
      return JSON.stringify(
        {
          count: events.length,
          events: events.map(e => serializeEventForSearch(e)),
        },
        null,
        2,
      );
    },
  });

  // ---- 写入与删除工具均已移除 ----
  //      关系图采用 **单写者** 模型：仅 extractor 通过被动 LLM 归纳来新建/强化节点和边。
  //      理由：避免 agent 工具与 extractor 双写引发的 race + 同事实双重计权。
  //      纠错走 `/relation cleanup` slash 命令（与 profile `/profile clear` 对称）。
  //      agent 想"记住"某事？引导用户在对话中说出来，extractor 会自动捕获。

  if (cfg.debug)
    ctx.logger.debug(`[user-relation] 已注册 3 个只读工具到分组 ${groupName}（expand / find_path / search_events）`);
}

// ----- helpers -----

function clampNum(raw: unknown, fallback: number, min: number, max: number): number {
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function serializeSubgraph(sub: {
  persons: PersonNode[];
  events: EventNode[];
  entities?: EntityNode[];
  edges: RelationEdge[];
}) {
  return {
    persons: sub.persons.map(p => ({
      id: p.id,
      platform: p.platform,
      userId: p.userId,
      displayName: p.displayName,
    })),
    events: sub.events.map(e => ({
      id: e.id,
      title: e.title,
      category: e.category,
      summary: e.summary,
      lastReinforcedAt: e.lastReinforcedAt,
    })),
    entities: (sub.entities ?? []).map(serializeEntity),
    edges: sub.edges.map(e => serializeEdge(e)),
  };
}

function serializeEntity(e: EntityNode) {
  return {
    id: e.id,
    entityKind: e.entityKind,
    name: e.name,
    aliases: e.aliases,
    summary: e.summary,
    lastReinforcedAt: e.lastReinforcedAt,
  };
}

function serializeNode(n: PersonNode | EventNode | EntityNode) {
  if ('platform' in n) {
    return { kind: 'person', id: n.id, platform: n.platform, userId: n.userId, displayName: n.displayName };
  }
  if ('entityKind' in n) {
    return { kind: 'entity', id: n.id, entityKind: n.entityKind, name: n.name };
  }
  return { kind: 'event', id: n.id, title: n.title, category: n.category };
}

function serializeEdge(e: RelationEdge) {
  if (e.kind === 'person-event') {
    const pe = e as PersonEventEdge;
    return {
      kind: 'person-event',
      id: pe.id,
      from: pe.fromPersonId,
      to: pe.toEventId,
      role: pe.role,
      sentiment: pe.sentiment,
      weight: pe.weight,
    };
  }
  if (e.kind === 'person-entity') {
    const pe = e as PersonEntityEdge;
    return {
      kind: 'person-entity',
      id: pe.id,
      from: pe.fromPersonId,
      to: pe.toEntityId,
      role: pe.role,
      sentiment: pe.sentiment,
      weight: pe.weight,
    };
  }
  if (e.kind === 'event-event') {
    const ee = e as EventEventEdge;
    return {
      kind: 'event-event',
      id: ee.id,
      from: ee.fromEventId,
      to: ee.toEventId,
      relation: ee.relationType,
      directed: ee.directed,
      weight: ee.weight,
    };
  }
  const pp = e as PersonPersonEdge;
  return {
    kind: 'person-person',
    id: pp.id,
    from: pp.fromPersonId,
    to: pp.toPersonId,
    relation: pp.relationType,
    directed: pp.directed,
    weight: pp.weight,
  };
}

function serializeEventForSearch(e: EventNode) {
  return {
    id: e.id,
    title: e.title,
    category: e.category,
    summary: e.summary,
    lastReinforcedAt: e.lastReinforcedAt,
    evidenceCount: e.evidence.length,
  };
}
