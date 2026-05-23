/**
 * Agent 工具：让 LLM 在 reasoning 中主动深挖关系图。
 *
 * 提供 3 个工具（注册到 'user-relation' 分组）：
 * - `user_relation_expand_person`：以某人为中心 BFS 抽取子图
 * - `user_relation_find_path`：在两人之间找最短关系链
 * - `user_relation_search_events`：按关键词 substring 搜事件
 *
 * 所有 depth/breadth 参数会被 hardMax 截断，防止 Agent 一次拉满爆 token。
 */
import type { Context } from '@aalis/core';
import { useToolService } from '@aalis/plugin-tools-api';
import type { RelationService } from './service.js';
import type {
  EntityKind,
  EntityNode,
  EventEventEdge,
  EventNode,
  PersonEntityEdge,
  PersonEntityRole,
  PersonEventEdge,
  PersonEventRole,
  PersonNode,
  PersonPersonEdge,
  RelationEdge,
  Sentiment,
} from './types.js';
import { RecommendedEventEventRelationTypes, RecommendedPersonEntityRoles } from './types.js';

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
  /** 严格自证：link 创建 person-* 边时，from_id 必须 == 当前发言者 */
  strictSelfAssertion: boolean;
  debug: boolean;
}

export function registerRelationTools(ctx: Context, service: RelationService, cfg: ToolsConfig): void {
  if (!cfg.enabled) return;
  const tools = useToolService(ctx);
  const groupName = cfg.group || 'user-relation';

  tools.registerGroup({
    name: groupName,
    label: '人物关系图',
    description: '查询用户关系图：扩展邻域、寻找两人关系链、按关键词搜事件',
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

  // ---- upsert_person (mutator) ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_upsert_person',
        description: '创建或更新人物（同 platform+userId 已存在时更新 displayName）。',
        parameters: {
          type: 'object',
          properties: {
            platform: { type: 'string', description: '平台标识，例 onebot / discord / webui' },
            user_id: { type: 'string', description: '平台内的 userId' },
            display_name: { type: 'string', description: '显示名（可选）' },
          },
          required: ['platform', 'user_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const platform = String(args.platform ?? '').trim();
      const userId = String(args.user_id ?? '').trim();
      if (!platform || !userId) return JSON.stringify({ error: 'platform / user_id 必填' });
      const displayName = typeof args.display_name === 'string' ? args.display_name : undefined;
      const p = await service.observePerson(platform, userId, displayName);
      return JSON.stringify({
        ok: true,
        person: { id: p.id, platform: p.platform, userId: p.userId, displayName: p.displayName },
      });
    },
  });

  // ---- upsert_entity (mutator) ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_upsert_entity',
        description: '创建或强化「实体」节点（话题/地点/物品/作品等持续存在的对象）。同名实体自动复用。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '实体名称（用于去重 key）' },
            entity_kind: { type: 'string', enum: ['topic', 'place', 'thing', 'work'], description: '实体类型' },
            aliases: { type: 'array', items: { type: 'string' }, description: '别名（可选）' },
            summary: { type: 'string', description: '简短描述（可选）' },
          },
          required: ['name', 'entity_kind'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const name = String(args.name ?? '').trim();
      if (!name) return JSON.stringify({ error: 'name 必填' });
      const entityKind = String(args.entity_kind ?? 'topic') as EntityKind;
      const aliases = Array.isArray(args.aliases)
        ? args.aliases.filter((x: unknown): x is string => typeof x === 'string')
        : undefined;
      const summary = typeof args.summary === 'string' ? args.summary : undefined;
      const dup = await service.findEntityByName(name);
      if (dup) {
        const reinforced = await service.reinforceEntity(dup.id, { aliases, summary, entityKind });
        return JSON.stringify({ ok: true, reused: true, entity: reinforced ? serializeEntity(reinforced) : null });
      }
      const created = await service.createEntity({ name, entityKind, aliases, summary, evidence: [] });
      return JSON.stringify({ ok: true, reused: false, entity: serializeEntity(created) });
    },
  });

  // ---- upsert_event (mutator) ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_upsert_event',
        description: '创建或强化「事件」节点（一次性发生过的事）。需要已有 event_id 时进行强化，否则新建。',
        parameters: {
          type: 'object',
          properties: {
            event_id: { type: 'string', description: '已存在事件 ID；提供则强化，留空则新建' },
            title: { type: 'string', description: '事件标题（<=30 字）' },
            summary: { type: 'string', description: '简短描述（可选）' },
            category: {
              type: 'string',
              enum: ['discussion', 'conflict', 'collaboration', 'incident', 'milestone', 'other'],
              description: '事件类别（可选）',
            },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const title = String(args.title ?? '').trim();
      if (!title) return JSON.stringify({ error: 'title 必填' });
      const summary = typeof args.summary === 'string' ? args.summary : undefined;
      const category = typeof args.category === 'string' ? (args.category as EventNode['category']) : undefined;
      const eventId = typeof args.event_id === 'string' && args.event_id ? args.event_id : undefined;
      if (eventId) {
        const r = await service.reinforceEvent(eventId, { title, summary, category });
        if (!r) return JSON.stringify({ error: `event_id ${eventId} 不存在` });
        return JSON.stringify({
          ok: true,
          event: { id: r.id, title: r.title, summary: r.summary, category: r.category },
        });
      }
      const created = await service.createEvent({ title, summary, category, evidence: [] });
      return JSON.stringify({
        ok: true,
        event: { id: created.id, title: created.title, summary: created.summary, category: created.category },
      });
    },
  });

  // ---- link (mutator) ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_link',
        description:
          '创建或强化一条边。kind 决定来源/目标类型：person-event / person-entity / person-person / event-event。',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['person-event', 'person-entity', 'person-person', 'event-event'],
              description: '边类型',
            },
            from_id: {
              type: 'string',
              description: 'source 节点 ID（person:`platform:userId`，event/entity 为 UUID）',
            },
            to_id: { type: 'string', description: 'target 节点 ID' },
            role: {
              type: 'string',
              description: `person-event: ${['initiator', 'participant', 'witness', 'target', 'reporter'].join(' / ')}；person-entity: ${RecommendedPersonEntityRoles.join(' / ')}`,
            },
            relation_type: {
              type: 'string',
              description: `person-person: friend/cp/mentor/rival 等；event-event 推荐：${RecommendedEventEventRelationTypes.join(' / ')}`,
            },
            sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral', 'mixed'] },
            directed: {
              type: 'boolean',
              description: '仅 person-person / event-event 生效；默认按 relation_type 推断',
            },
          },
          required: ['kind', 'from_id', 'to_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async (args, callCtx) => {
      const kind = String(args.kind ?? '');
      const from = String(args.from_id ?? '').trim();
      const to = String(args.to_id ?? '').trim();
      if (!from || !to) return JSON.stringify({ error: 'from_id / to_id 必填' });
      // 严格自证：person-* 边的 from 必须是当前调用者本人
      if (
        cfg.strictSelfAssertion &&
        (kind === 'person-event' || kind === 'person-entity' || kind === 'person-person')
      ) {
        const sender = callCtx.platform && callCtx.userId ? `${callCtx.platform}:${callCtx.userId}` : undefined;
        if (!sender || from !== sender) {
          return JSON.stringify({
            error: `严格自证模式：from_id 必须等于当前发言者 ${sender ?? '(未知)'}，不能代别人写关系`,
          });
        }
      }
      const sentiment = typeof args.sentiment === 'string' ? (args.sentiment as Sentiment) : undefined;
      try {
        if (kind === 'person-event') {
          const role = (typeof args.role === 'string' ? args.role : 'participant') as PersonEventRole;
          const e = await service.addPersonEventEdge({
            fromPersonId: from,
            toEventId: to,
            role,
            sentiment,
            evidence: [],
          });
          return JSON.stringify({ ok: true, edge: serializeEdge(e) });
        }
        if (kind === 'person-entity') {
          const role = (typeof args.role === 'string' ? args.role : 'mentioned') as PersonEntityRole;
          const e = await service.addPersonEntityEdge({
            fromPersonId: from,
            toEntityId: to,
            role,
            sentiment,
            evidence: [],
          });
          return JSON.stringify({ ok: true, edge: serializeEdge(e) });
        }
        if (kind === 'person-person') {
          const relationType = String(args.relation_type ?? '').trim();
          if (!relationType) return JSON.stringify({ error: 'person-person 需要 relation_type' });
          const directed = typeof args.directed === 'boolean' ? args.directed : undefined;
          const e = await service.addPersonPersonEdge({
            fromPersonId: from,
            toPersonId: to,
            relationType,
            directed,
            evidence: [],
          });
          return JSON.stringify({ ok: true, edge: serializeEdge(e) });
        }
        if (kind === 'event-event') {
          const relationType = String(args.relation_type ?? '').trim();
          if (!relationType) return JSON.stringify({ error: 'event-event 需要 relation_type' });
          const directed = typeof args.directed === 'boolean' ? args.directed : undefined;
          const e = await service.addEventEventEdge({
            fromEventId: from,
            toEventId: to,
            relationType,
            directed,
            evidence: [],
          });
          return JSON.stringify({ ok: true, edge: serializeEdge(e) });
        }
        return JSON.stringify({ error: `未知 kind: ${kind}` });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ---- unlink (mutator) ----
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_unlink',
        description: '按 edge_id 删除一条边。可通过 expand_person / find_path 先拿到 edge id。',
        parameters: {
          type: 'object',
          properties: {
            edge_id: { type: 'string', description: '边 ID（UUID）' },
          },
          required: ['edge_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const edgeId = String(args.edge_id ?? '').trim();
      if (!edgeId) return JSON.stringify({ error: 'edge_id 必填' });
      await service.deleteEdge(edgeId);
      return JSON.stringify({ ok: true });
    },
  });

  if (cfg.debug) ctx.logger.debug(`[user-relation] 已注册 8 个工具到分组 ${groupName}`);
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
