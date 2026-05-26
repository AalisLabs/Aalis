/**
 * Agent 工具：让 LLM 在 reasoning 中主动深挖关系图。
 *
 * 设计原则（单写者 + 与 profile 对称）：
 * - 关系图的「新建 / 强化 / 删除」由 extractor 单线程被动归纳，agent **不能** 直接写或删。
 * - agent 暴露的工具全部 **只读**；纠错走 `/relation cleanup` slash 命令。
 *
 * 这套工具覆盖 6 类边、3 类节点的检索/分析需求：
 *   resolve_node       —— 由关键词跨类解析节点 ID
 *   expand_node        —— 以任意节点为中心 BFS 子图（可限定 session_scope）
 *   find_path          —— 任意节点 ↔ 任意节点 最短路径
 *   score              —— 双节点联系分数（Katz + AA）
 *   recommend_persons  —— 给 person 推荐 top-K “想认识”的人（一步达成，避免多次 score）
 *   gossip             —— 某会话最近的“瓜”（事件热度榜）
 *   shared             —— 两节点共同邻居（共同兴趣/事件/朋友）
 *   search_persons     —— 按 platform/关键词列人
 *   search_entities    —— 按 kind/关键词列实体
 *   search_events      —— 按关键词/天数列事件（可限定 session_scope）
 *   list_edges         —— 多条件过滤边
 *   timeline           —— 节点时间线（可限定 session_scope）
 *
 * 所有 depth/breadth/limit 参数会被 hardMax 截断，防止 Agent 一次拉满爆 token。
 */
import type { Context } from '@aalis/core';
import { useToolService } from '@aalis/plugin-tools-api';
import type { RelationService } from './service.js';
import type {
  EntityEntityEdge,
  EntityNode,
  EventEntityEdge,
  EventEventEdge,
  EventNode,
  PersonEntityEdge,
  PersonEventEdge,
  PersonNode,
  PersonPersonEdge,
  RelationEdge,
} from './types.js';

interface ToolsConfig {
  enabled: boolean;
  /** 工具分组名（默认 'user-relation'） */
  group: string;
  /** Agent 调用时的默认 depth（expand_node） */
  defaultMaxDepth: number;
  /** Agent 调用时的默认 breadth（expand_node） */
  defaultMaxBreadth: number;
  /** 硬上限 depth；超过会被截断 */
  hardMaxDepth: number;
  /** 硬上限 breadth */
  hardMaxBreadth: number;
  /** search_events / search_persons / search_entities 默认 limit */
  searchEventsDefaultLimit: number;
  searchEventsHardMaxLimit: number;
  /** find_path 默认/硬上限最大深度 */
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
    description: [
      '查询用户关系图：跨类节点解析 / BFS 子图 / 任意节点最短路径 / 多类型筛选边 / 节点时间线。只读，纠错走 /relation cleanup。',
      '',
      '🔑 节点 ID 格式（**所有 node_id / from_node_id / to_node_id 参数都按此约定**）：',
      '- person 节点 ID：必须是 `<platform>:<userId>` 完整格式，例如 `onebot:10001`，**不能只填裸 userId**。',
      '- event / entity 节点 ID：UUID 字符串（不含冒号）。',
      '- 只知道名字 / 不确定 ID 时，**先调 user_relation_resolve_node** 把关键词解析成 ID 再传给其它工具。',
      '- 工具收到不存在的 ID 会返回 `{ "error": "节点 "xxx" 不存在", "hint": ... }`；看到这种返回**就是 ID 错了**，不是系统问题，请改用 resolve_node / search_persons 重新拿 ID，不要继续猜参数。',
      '',
      '🧭 常见任务 → 推荐工具（避免选错）：',
      '- "查 A 与 B 关系紧密 / 是否认识" → 先 `user_relation_resolve_node`（拿到完整 ID）→ `user_relation_score`（**两节点之间** Katz+AA 联系分）',
      '- "A 在群里有多重要 / 谁是核心" → `user_relation_node_score`（**单节点**份量/tier/排名；与 score 不同，不要传两个 ID）',
      '- "A 主动关心谁 / 谁在追 A" → `user_relation_directional_degree`（**单节点**入出度剖面 + fan/idol 提示）',
      '- "A 和 B 有什么共同点（朋友/兴趣/事件）" → `user_relation_shared`',
      '- "A 经历过什么 / 最近发生啥" → `user_relation_timeline`（限定 session_scope）',
      '- "群里最近的瓜" → `user_relation_gossip`',
      '- "A 的关系网长什么样" → `user_relation_expand_node`（BFS 子图，注意 max_depth/max_breadth）',
      '- "给 A 推荐想认识的人" → `user_relation_recommend_persons`（一次出 top-K，**不要**手撕循环调 score）',
      '- "A 平时跟谁混 / A 在哪个圈子" → `user_relation_community_peers`（同社群活跃成员；Louvain）',
      '- "A 和 B 是不是同一拨人" → `user_relation_community_bridge`（同社群判断 + 各自社群规模）',
      '- "这群里有几个圈子 / 谁是桥梁人" → `user_relation_community_overview`（全局社群概览 + modularity Q + bridges；支持 algorithm=louvain|leiden 切换）',
      '',
      '⚠️ 方向语义（写边时必须遵守，本组工具与写边工具共用此约定）：',
      '- person-person 边一律是「主动声明」：必须从主动方写到被动方。',
      '  · admirer/follower/student：粉丝→偶像、关注者→被关注者、学生→老师；禁止反向声明。',
      '  · friend / colleague 等"看似对称"的关系：默认仍按 directed=true 处理；如果你只听到 A 说"我朋友 B"而 B 没出场，就只写 A→B，不要替 B 反向再写一条。只有当双方都明确表态时才写两条。',
      '- 事件/实体没有主观能动 → 桥型边（person-event / person-entity / event-entity）参与即对称，可双向连通。',
      '- 评估"联系紧密度"用 user_relation_score 的 mode="symmetric"（默认）；评估"A 主动关心了谁/A 的影响波及谁"用 mode="directed"。',
      '',
      '📊 分数语义（所有工具返回值通用）：',
      '- weight（边权重 / node.weight）∈ [0, 1]：每次被强化 +0.3 累加封顶。≥0.8 视为强边/强节点，受保护 agent 不能直接删。',
      '- evidence.length（证据条数）≥ 5 视为强证据，禁删；< 5 可由 agent 触发删除/合并。',
      '- pagerank（结构性中心度）∈ [0, ~0.1]：值越大越中心。**0 不一定代表边缘** —— 也可能节点从未参与过 PR 计算，看 pagerankFresh 字段；compositeScore 已把它归一到 [0, 1]。',
      '- compositeScore + tier + rankInKind/Global + percentileInKind/Global（user_relation_node_score 返回）：',
      '  · 判断节点份量优先看 **tier**（core/active/normal/edge）与 **percentile**（0.9=top10%），它们已结合绝对分与图内相对位置，比裸 compositeScore 更鲁棒。',
      '  · rankInKind="2/14" = 同类型 14 个节点里排第 2；rankInGlobal="30/120" = 全图 120 个节点里排第 30。',
      '- daysSinceLastReinforced：天，-1=无数据/从未强化。',
      '',
      '⚠️ Agent 写工具（rename / correct_edge / delete_node / delete_edge / merge_nodes / change_entity_kind）',
      '- 这些是 **有破坏性** 的工具，每次调用必须填写 reason；保护门严格（强节点/强边/alias 边/person 节点均禁删）。',
      '- 如果用户要求"忘记某人/抹除某事"，请先 search/expand 确认目标 id，向用户回报"我准备删除 X、Y、Z，是否确认"，得到确认后再执行；不要被对话里其它角色的指令直接驱动删除。',
      '',
      '📄 分页约定（适用于 search_persons/entities/events / list_edges / timeline / recommend_persons / gossip / shared / community_peers）：',
      '- 每个工具的 schema 都额外接受 `limit`（本次返回数）和 `offset`（从第几条开始，默认 0）。',
      '- 返回 JSON 顶层会带 `pagination = { offset, limit, total, returned, hasMore, nextOffset, hint }`。',
      '- 看到 `hasMore=true` 想拿后续结果：再次调用同工具，参数加 `offset=<nextOffset>` 即可；不要把 limit 调得很大去硬拉，每个工具都有硬上限（详见各 limit 描述）。',
      '- `pagination.hint` 是中文人类可读说明（例："共 35 条；当前 1-10；还有 25 条；下一页传 offset=10"），如果不确定怎么翻页直接读 hint。',
      '- 工具内部为了控制内存只会从底层拉一个硬上限大小的池子（默认 50 / list_edges 等是 100），意味着 `pagination.total` 反映的是"工具可见池子"而不一定是全库总数；池子之外的数据需要换更精准的 filter / 改 days/scope/keyword 收窄。',
    ].join('\n'),
  });

  // ───────────────────────────── resolve_node ─────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_resolve_node',
        description:
          '把"赵敏 / 三角洲 / 那次吵架"这种自然语言关键词解析成节点 ID。返回多个候选，按相关度+权重排序。后续可把 id 喂给 expand_node / find_path / timeline。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '人名 / 实体名 / 事件名 / 别名 等关键词' },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: ['person', 'event', 'entity'] },
              description: '可选：只在指定节点类型中搜索。不传则三类都搜。',
            },
            limit: {
              type: 'number',
              description: `每类返回上限。默认 ${cfg.searchEventsDefaultLimit}，硬上限 ${cfg.searchEventsHardMaxLimit}`,
            },
          },
          required: ['keyword'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
      if (!keyword) return JSON.stringify({ error: 'keyword 不能为空' });
      const wanted = new Set(
        (Array.isArray(args.kinds) ? (args.kinds as unknown[]) : []).filter((k): k is string => typeof k === 'string'),
      );
      const wantAll = wanted.size === 0;
      const limit = clampNum(args.limit, cfg.searchEventsDefaultLimit, 1, cfg.searchEventsHardMaxLimit);
      const out: Array<Record<string, unknown>> = [];
      if (wantAll || wanted.has('person')) {
        const list = await service.searchPersons({ keyword, limit });
        for (const p of list) out.push({ kind: 'person', ...serializePerson(p) });
      }
      if (wantAll || wanted.has('entity')) {
        const list = await service.searchEntities({ keyword, limit });
        for (const e of list) out.push({ kind: 'entity', ...serializeEntity(e) });
      }
      if (wantAll || wanted.has('event')) {
        const list = await service.searchEvents({ keyword, limit });
        for (const e of list) out.push({ kind: 'event', ...serializeEventForSearch(e) });
      }
      return JSON.stringify({ keyword, count: out.length, candidates: out }, null, 2);
    },
  });

  // ───────────────────────────── expand_node ──────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_expand_node',
        description:
          '以任意节点（人 / 事件 / 实体）为中心做 BFS 展开子图。比 expand_person 更通用：可以从实体出发看"谁关心《三角洲》"，或从事件出发看"这件事牵连了谁"。',
        parameters: {
          type: 'object',
          properties: {
            node_id: {
              type: 'string',
              description: '节点 ID：person 形如 platform:userId；event/entity 是 UUID。先用 resolve_node 拿到。',
            },
            max_depth: {
              type: 'number',
              description: `BFS 最大深度（0=仅此节点；1=直接邻居；2=邻居的邻居）。默认 ${cfg.defaultMaxDepth}，硬上限 ${cfg.hardMaxDepth}`,
            },
            max_breadth: {
              type: 'number',
              description: `单节点展开邻居上限（按 weight 降序）。默认 ${cfg.defaultMaxBreadth}，硬上限 ${cfg.hardMaxBreadth}`,
            },
            session_scope: {
              type: 'string',
              description:
                '仅保留属于该会话作用域的事件（例 onebot_xxx_group_yyy 或 "global"）。不传=不过滤。重要：你要讨论“某群内”的事勿忘传，否则跨群事件会被当成证据。',
            },
          },
          required: ['node_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const nodeId = String(args.node_id ?? '').trim();
      const err = await validateNodeId(service, nodeId, 'node_id');
      if (err) return err;
      const depth = clampNum(args.max_depth, cfg.defaultMaxDepth, 0, cfg.hardMaxDepth);
      const breadth = clampNum(args.max_breadth, cfg.defaultMaxBreadth, 1, cfg.hardMaxBreadth);
      const scope =
        typeof args.session_scope === 'string' && args.session_scope.trim() ? args.session_scope.trim() : undefined;
      const sub = await service.traverseSubgraph({
        startNodeIds: [nodeId],
        maxDepth: depth,
        maxBreadth: breadth,
      });
      return JSON.stringify(serializeSubgraph(filterSubgraphByScope(sub, scope)), null, 2);
    },
  });

  // ───────────────────────────── find_path ────────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_find_path',
        description:
          '在任意两个节点之间寻找最短关系链（可经过事件 / 实体作为桥）。两端节点可以是人 / 事件 / 实体的任意组合。找不到返回 found=false。🔑 person 节点 ID 必须是 `<platform>:<userId>`；不确定先用 user_relation_resolve_node。',
        parameters: {
          type: 'object',
          properties: {
            from_node_id: {
              type: 'string',
              description:
                '起点节点 ID。person 形如 `<platform>:<userId>`（如 `onebot:10001`），event/entity 是 UUID。',
            },
            to_node_id: {
              type: 'string',
              description: '终点节点 ID。格式同 from_node_id。',
            },
            max_depth: {
              type: 'number',
              description: `最大边数（路径长度上限）。默认 ${cfg.findPathDefaultMaxDepth}，硬上限 ${cfg.findPathHardMaxDepth}`,
            },
          },
          required: ['from_node_id', 'to_node_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const from = String(args.from_node_id ?? '').trim();
      const to = String(args.to_node_id ?? '').trim();
      if (!from || !to) return JSON.stringify({ error: 'from_node_id / to_node_id 不能为空' });
      const fromErr = await validateNodeId(service, from, 'from_node_id');
      if (fromErr) return fromErr;
      const toErr = await validateNodeId(service, to, 'to_node_id');
      if (toErr) return toErr;
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

  // ───────────────────────────── score ────────────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_score',
        description: [
          '**两节点之间**的联系紧密度（0~1，tanh 归一化）。**不是**单节点份量——后者请用 `user_relation_node_score`。',
          '',
          '🔑 调用前提：两端 ID 都要存在。person 节点 ID 必须是 `<platform>:<userId>`（如 `onebot:10001`），裸 userId 会被判为节点不存在并报错。如果只知道名字，先调 `user_relation_resolve_node`。',
          '',
          '算法融合 4 类信号：',
          '1) Katz 限深简单路径累加：贡献 = β^长度 × ∏(边权 × kindMultiplier)；',
          '2) 边类型权重 kindMultiplier：person-person=1.0, person-event=0.8, person-entity=0.5, event-event/event-entity=0.4, entity-entity=0.3（数值待数据反馈调整）；',
          '3) 直接连接 boost：长度=1 路径额外 ×1.5；',
          '4) Adamic-Adar 共同邻居：Σ 1/log(度+1.7)，奖励小圈子私密关联、惩罚"人人都参与的大事件"。',
          '最终 score = tanh(katzScore + 0.3 × commonNeighborsScore)。',
          '',
          '⚠️ 方向语义（关键）：',
          '- 桥型边（person-event / person-entity / event-entity）总是双向：事/物没有主观能动，参与即对称连通。',
          '- 主体边（person-person / event-event / entity-entity）严格按 edge.directed：directed=true 仅 from→to 一条弧；directed=false 双向。',
          '- mode="symmetric"（默认，「联系紧密度」）：a→b 与 b→a 各跑一次取 max。能体现"任一方向连通即算紧密"。',
          '- mode="directed"（「关注/影响传播度」）：只跑 from_node_id→to_node_id 一次。适用于"A 主动关心了谁 / A 的影响能波及谁"。',
          '  例：A admirer B（A 是粉丝，B 是偶像），mode=directed 时 score(A,B)>0 但 score(B,A)=0（B 不一定认识 A）；mode=symmetric 时两者相等且 > 0。',
          '',
          '返回 top_paths（含 direction 字段）+ common_neighbors 作为可解释证据。如果返回 `score=0` 且 `shortest_length=null`，先检查两端 ID 是否拼错（最常见原因），别误判为系统问题。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            from_node_id: {
              type: 'string',
              description:
                '起点节点 ID。person 必须是 `<platform>:<userId>` 完整格式（如 `onebot:10001`），event/entity 是 UUID。不确定先用 user_relation_resolve_node。',
            },
            to_node_id: {
              type: 'string',
              description: '终点节点 ID。格式同 from_node_id。',
            },
            mode: {
              type: 'string',
              enum: ['symmetric', 'directed'],
              description: '默认 symmetric（联系紧密度，双向取 max）。directed=只从 from 出发，体现主动关注/影响传播。',
            },
            max_depth: {
              type: 'number',
              description:
                '路径最大边数，1~6，默认 4。越大越能体现间接联系，但耗时指数增长；建议人对人=4，含事件/实体=3。',
            },
            top_paths: {
              type: 'number',
              description: '返回贡献最高的 N 条路径作为解释，默认 3，最大 20',
            },
          },
          required: ['from_node_id', 'to_node_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const from = String(args.from_node_id ?? '').trim();
      const to = String(args.to_node_id ?? '').trim();
      if (!from || !to) return JSON.stringify({ error: 'from_node_id / to_node_id 不能为空' });
      const fromErr = await validateNodeId(service, from, 'from_node_id');
      if (fromErr) return fromErr;
      const toErr = await validateNodeId(service, to, 'to_node_id');
      if (toErr) return toErr;
      const maxDepth = clampNum(args.max_depth, 4, 1, 6);
      const topPaths = clampNum(args.top_paths, 3, 1, 20);
      const rawMode = String(args.mode ?? 'symmetric').trim();
      const mode: 'symmetric' | 'directed' = rawMode === 'directed' ? 'directed' : 'symmetric';
      const r = await service.scoreBetween(from, to, { maxDepth, topPaths, mode });
      return JSON.stringify(
        {
          from_id: r.fromId,
          to_id: r.toId,
          mode: r.mode,
          score: Number(r.score.toFixed(4)),
          raw_score: Number(r.rawScore.toFixed(4)),
          katz_score: Number(r.katzScore.toFixed(4)),
          forward_katz_score: Number(r.forwardKatzScore.toFixed(4)),
          backward_katz_score: Number(r.backwardKatzScore.toFixed(4)),
          common_neighbors_score: Number(r.commonNeighborsScore.toFixed(4)),
          paths_considered: r.pathsConsidered,
          shortest_length: r.shortestLength,
          directly_connected: r.directlyConnected,
          top_paths: r.topPaths.map(p => ({
            direction: p.direction,
            length: p.length,
            weight_product: Number(p.weightProduct.toFixed(4)),
            contribution: Number(p.contribution.toFixed(4)),
            nodes: p.nodes.map(n => serializeNode(n)),
            edges: p.edges.map(e => serializeEdge(e)),
          })),
          common_neighbors: r.commonNeighbors.map(c => ({
            degree: c.degree,
            aa_contribution: Number(c.aaContribution.toFixed(4)),
            node: serializeNode(c.node),
          })),
        },
        null,
        2,
      );
    },
  });

  // ───────────────────────────── search_persons ───────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_search_persons',
        description:
          '按关键词 / 平台筛选人。匹配 displayName / userId / aliases / id（substring，不区分大小写）。返回带 pagination 元信息，需翻页传 offset；查看 pagination.hint 了解还有多少结果。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '关键词；留空则按 lastMentionedAt 倒序列出活跃的人' },
            platform: { type: 'string', description: '仅返回该平台的人，如 onebot' },
            ...paginationSchema(cfg.searchEventsDefaultLimit, cfg.searchEventsHardMaxLimit, '人'),
          },
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const keyword = typeof args.keyword === 'string' ? args.keyword : undefined;
      const platform = typeof args.platform === 'string' && args.platform.trim() ? args.platform.trim() : undefined;
      // service 层拉满池子（硬上限），handler 再分页。这样 pagination.total 反映实际池子大小。
      const pool = await service.searchPersons({ keyword, platform, limit: cfg.searchEventsHardMaxLimit });
      const { items, pagination } = paginate(
        pool,
        args.offset,
        args.limit,
        cfg.searchEventsDefaultLimit,
        cfg.searchEventsHardMaxLimit,
        '人',
      );
      return JSON.stringify({ pagination, persons: items.map(serializePerson) }, null, 2);
    },
  });

  // ───────────────────────────── search_entities ──────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_search_entities',
        description:
          '按关键词 / 类型筛选实体。匹配 name / aliases / summary / id（substring，不区分大小写）。返回带 pagination 元信息，需翻页传 offset。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '关键词；留空则按 lastReinforcedAt 倒序列出最近实体' },
            kind: {
              type: 'string',
              enum: ['topic', 'place', 'thing', 'work'],
              description: '实体类型筛选',
            },
            ...paginationSchema(cfg.searchEventsDefaultLimit, cfg.searchEventsHardMaxLimit, '实体'),
          },
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const keyword = typeof args.keyword === 'string' ? args.keyword : undefined;
      const kind = typeof args.kind === 'string' ? (args.kind as EntityNode['entityKind']) : undefined;
      const pool = await service.searchEntities({ keyword, kind, limit: cfg.searchEventsHardMaxLimit });
      const { items, pagination } = paginate(
        pool,
        args.offset,
        args.limit,
        cfg.searchEventsDefaultLimit,
        cfg.searchEventsHardMaxLimit,
        '实体',
      );
      return JSON.stringify({ pagination, entities: items.map(serializeEntity) }, null, 2);
    },
  });

  // ───────────────────────────── search_events ────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_search_events',
        description:
          '按关键词 substring 搜索事件（匹配 title + summary，不区分大小写）。返回带 pagination 元信息，需翻页传 offset。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '关键词；留空则返回最近的事件' },
            days: { type: 'number', description: '仅返回最近 N 天内强化过的事件；0 / 不传 = 不限' },
            session_scope: {
              type: 'string',
              description: '仅保留属于该会话作用域的事件；不传=不过滤。',
            },
            ...paginationSchema(cfg.searchEventsDefaultLimit, cfg.searchEventsHardMaxLimit, '事件'),
          },
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const keyword = typeof args.keyword === 'string' ? args.keyword : undefined;
      const days = typeof args.days === 'number' && args.days > 0 ? args.days : undefined;
      const scope =
        typeof args.session_scope === 'string' && args.session_scope.trim() ? args.session_scope.trim() : undefined;
      // scope 过滤前先多拉一些（×3）避免过滤后池子太小
      const poolLimit = scope ? cfg.searchEventsHardMaxLimit * 3 : cfg.searchEventsHardMaxLimit;
      const raw = await service.searchEvents({ keyword, days, limit: poolLimit });
      const pool = raw.filter(e => inScope(scope, e.sessionScope)).slice(0, cfg.searchEventsHardMaxLimit);
      const { items, pagination } = paginate(
        pool,
        args.offset,
        args.limit,
        cfg.searchEventsDefaultLimit,
        cfg.searchEventsHardMaxLimit,
        '事件',
      );
      return JSON.stringify({ pagination, events: items.map(serializeEventForSearch) }, null, 2);
    },
  });

  // ───────────────────────────── list_edges ───────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_list_edges',
        description:
          '多条件筛选边。常见用途：找"A 和 B 之间的所有边"(from_id+to_id)、"所有 CP 关系"(kinds=person-person,relation_types=cp)、"最近 7 天的发起者参与"(kinds=person-event,roles=initiator,days=7)。所有过滤器是 AND 关系。',
        parameters: {
          type: 'object',
          properties: {
            kinds: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'person-event',
                  'person-person',
                  'person-entity',
                  'event-event',
                  'event-entity',
                  'entity-entity',
                ],
              },
              description: '边大类筛选；不传 = 全部',
            },
            relation_types: {
              type: 'array',
              items: { type: 'string' },
              description:
                '关系类型筛选（仅对 person-person / event-event / event-entity / entity-entity 有效），如 ["cp","friend"]',
            },
            roles: {
              type: 'array',
              items: { type: 'string' },
              description: '角色筛选（仅对 person-event / person-entity 有效），如 ["initiator","target"]',
            },
            node_id: {
              type: 'string',
              description: '边的任一端 = 该节点（无方向）',
            },
            from_id: { type: 'string', description: '边起点 = 该节点（有方向，注意无向边的方向由 LLM 提取时给定）' },
            to_id: { type: 'string', description: '边终点 = 该节点' },
            days: { type: 'number', description: '仅返回最近 N 天内强化过的边；0 / 不传 = 不限' },
            ...paginationSchema(cfg.searchEventsDefaultLimit * 2, cfg.searchEventsHardMaxLimit * 2, '边'),
          },
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const kinds = Array.isArray(args.kinds)
        ? (args.kinds as unknown[]).filter((k): k is RelationEdge['kind'] => typeof k === 'string')
        : undefined;
      const relationTypes = Array.isArray(args.relation_types)
        ? (args.relation_types as unknown[]).filter((k): k is string => typeof k === 'string')
        : undefined;
      const roles = Array.isArray(args.roles)
        ? (args.roles as unknown[]).filter((k): k is string => typeof k === 'string')
        : undefined;
      const nodeId = typeof args.node_id === 'string' && args.node_id.trim() ? args.node_id.trim() : undefined;
      const fromId = typeof args.from_id === 'string' && args.from_id.trim() ? args.from_id.trim() : undefined;
      const toId = typeof args.to_id === 'string' && args.to_id.trim() ? args.to_id.trim() : undefined;
      const days = typeof args.days === 'number' && args.days > 0 ? args.days : undefined;
      const pool = await service.listEdges({
        kinds,
        relationTypes,
        roles,
        nodeId,
        fromId,
        toId,
        days,
        limit: cfg.searchEventsHardMaxLimit * 2,
      });
      const { items, pagination } = paginate(
        pool,
        args.offset,
        args.limit,
        cfg.searchEventsDefaultLimit * 2,
        cfg.searchEventsHardMaxLimit * 2,
        '边',
      );
      return JSON.stringify({ pagination, edges: items.map(serializeEdge) }, null, 2);
    },
  });

  // ───────────────────────────── timeline ─────────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_timeline',
        description:
          '给定任意节点，按时间倒序返回相关事件。person → 该人参与的事件；entity → 涉及该实体的事件；event → 通过 event-event 边相连的事件。每条结果附带触达它的边，便于追溯"为什么相关"。',
        parameters: {
          type: 'object',
          properties: {
            node_id: {
              type: 'string',
              description:
                '节点 ID。person 形如 `<platform>:<userId>`，event/entity 是 UUID。不确定先用 user_relation_resolve_node。',
            },
            days: { type: 'number', description: '仅返回最近 N 天内强化过的；0 / 不传 = 不限' },
            session_scope: {
              type: 'string',
              description: '仅保留属于该会话作用域的事件；不传=不过滤。',
            },
            ...paginationSchema(cfg.searchEventsDefaultLimit * 2, cfg.searchEventsHardMaxLimit * 2, '事件'),
          },
          required: ['node_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const nodeId = String(args.node_id ?? '').trim();
      const err = await validateNodeId(service, nodeId, 'node_id');
      if (err) return err;
      const days = typeof args.days === 'number' && args.days > 0 ? args.days : undefined;
      const scope =
        typeof args.session_scope === 'string' && args.session_scope.trim() ? args.session_scope.trim() : undefined;
      const poolLimit = scope ? cfg.searchEventsHardMaxLimit * 6 : cfg.searchEventsHardMaxLimit * 2;
      const itemsAll = await service.getTimeline({ nodeId, days, limit: poolLimit });
      const filtered = itemsAll
        .filter(it => inScope(scope, it.event.sessionScope))
        .slice(0, cfg.searchEventsHardMaxLimit * 2);
      const { items, pagination } = paginate(
        filtered,
        args.offset,
        args.limit,
        cfg.searchEventsDefaultLimit * 2,
        cfg.searchEventsHardMaxLimit * 2,
        '事件',
      );
      return JSON.stringify(
        {
          pagination,
          items: items.map(it => ({
            event: serializeEventForSearch(it.event),
            viaEdge: serializeEdge(it.viaEdge),
          })),
        },
        null,
        2,
      );
    },
  });

  // ───────────────────────────── recommend_persons ────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_recommend_persons',
        description: [
          '给定一个 person，一步返回 top-K 「潜在想认识 / 该多互动」的人。',
          '算法：BFS 取 1~2 跳人物候选 → 排除已直接声明 person-person 关系的 → 对每个候选跑 scoreBetween → 按 score 降序。',
          '每个候选返回 score + 共同邻居（事件/兴趣实体）+ 最强 1 条解释路径，agent 无须再多次 score 手算。',
          '典型场景："时空小沫想认识谁"、"该撮合 A 和谁多聊"、"在 X 群里给 P 推荐能聊得来的人"。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            node_id: { type: 'string', description: 'person 节点 ID（platform:userId）' },
            candidate_pool: {
              type: 'number',
              description: '候选池大小（2 跳邻居截断，决定要打分的候选数）。默认 20，硬上限 50，越大越慢',
            },
            max_depth: { type: 'number', description: 'scoreBetween 路径深度，默认 3，硬上限 5' },
            session_scope: {
              type: 'string',
              description:
                '仅在该会话作用域内做推荐：候选池只走该 scope 下的事件相连节点，且解释路径过滤掉跨会话事件。不传=全图。',
            },
            ...paginationSchema(5, 15, '推荐'),
          },
          required: ['node_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const nodeId = String(args.node_id ?? '').trim();
      if (!nodeId?.includes(':')) {
        return JSON.stringify({ error: 'node_id 必须是 person（platform:userId）' });
      }
      const poolSize = clampNum(args.candidate_pool, 20, 1, 50);
      const depth = clampNum(args.max_depth, 3, 1, 5);
      const scope =
        typeof args.session_scope === 'string' && args.session_scope.trim() ? args.session_scope.trim() : undefined;

      // 1) 拿 2 跳子图作为候选池
      const subRaw = await service.traverseSubgraph({
        startNodeIds: [nodeId],
        maxDepth: 2,
        maxBreadth: poolSize,
      });
      const sub = filterSubgraphByScope(subRaw, scope);

      // 2) 排除自身 + 已 person-person 直连
      const directLinked = new Set<string>();
      for (const e of sub.edges) {
        if (e.kind !== 'person-person') continue;
        const pp = e as PersonPersonEdge;
        if (pp.fromPersonId === nodeId) directLinked.add(pp.toPersonId);
        if (pp.toPersonId === nodeId) directLinked.add(pp.fromPersonId);
      }
      const candidates = sub.persons.filter(p => p.id !== nodeId && !directLinked.has(p.id)).slice(0, poolSize);

      // 3) 对每个候选打分
      const scored: Array<{
        person: ReturnType<typeof serializePerson>;
        score: number;
        common_neighbors_score: number;
        katz_score: number;
        top_path?: ReturnType<typeof serializeNode>[] extends never
          ? never
          : { length: number; nodes: ReturnType<typeof serializeNode>[]; edges: ReturnType<typeof serializeEdge>[] };
        common_neighbors: Array<{ degree: number; aa_contribution: number; node: ReturnType<typeof serializeNode> }>;
      }> = [];
      for (const cand of candidates) {
        try {
          const r = await service.scoreBetween(nodeId, cand.id, { maxDepth: depth, topPaths: 3, mode: 'symmetric' });
          if (r.score <= 0) continue;
          // 路径若含跨 scope 事件，从展示里剔除（不影响 score 数值）
          const visiblePaths = r.topPaths.filter(p =>
            scope
              ? p.nodes.every(
                  n =>
                    !('title' in n && !('platform' in n) && !('entityKind' in n)) ||
                    inScope(scope, (n as EventNode).sessionScope),
                )
              : true,
          );
          const top = visiblePaths[0];
          scored.push({
            person: serializePerson(cand),
            score: Number(r.score.toFixed(4)),
            common_neighbors_score: Number(r.commonNeighborsScore.toFixed(4)),
            katz_score: Number(r.katzScore.toFixed(4)),
            top_path: top
              ? {
                  length: top.length,
                  nodes: top.nodes.map(n => serializeNode(n)),
                  edges: top.edges.map(e => serializeEdge(e)),
                }
              : undefined,
            common_neighbors: r.commonNeighbors.slice(0, 3).map(c => ({
              degree: c.degree,
              aa_contribution: Number(c.aaContribution.toFixed(4)),
              node: serializeNode(c.node),
            })),
          });
        } catch {
          // 单个候选打分失败不影响整体
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const { items: top, pagination } = paginate(scored, args.offset, args.limit, 5, 15, '推荐');
      return JSON.stringify(
        {
          from_id: nodeId,
          session_scope: scope ?? null,
          pagination,
          candidates_considered: candidates.length,
          recommendations: top,
        },
        null,
        2,
      );
    },
  });

  // ───────────────────────────── gossip ────────────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_gossip',
        description: [
          '一步返回某会话/群最近的「瓜」：按热度（weight × evidenceCount × recency）排序的事件清单。',
          '典型场景："这群最近在聊啥"、"X 群最近一周有什么瓜"。',
          '比 search_events 适合"想看群里热闹"的开放式查询；search_events 适合"找某个具体话题"。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            session_scope: {
              type: 'string',
              description: '会话作用域；不传=全图。强烈建议传，否则会把所有群/私聊的事件混在一起。',
            },
            days: { type: 'number', description: '仅看最近 N 天；默认 7，0=不限' },
            ...paginationSchema(8, 30, '事件'),
          },
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const scope =
        typeof args.session_scope === 'string' && args.session_scope.trim() ? args.session_scope.trim() : undefined;
      const days = typeof args.days === 'number' && args.days >= 0 ? args.days : 7;
      const pool = await service.searchEvents({ days: days > 0 ? days : undefined, limit: 200 });
      const filtered = pool.filter(e => inScope(scope, e.sessionScope));
      const now = Date.now();
      const scored = filtered.map(e => {
        const ageDays = Math.max(0, (now - e.lastReinforcedAt) / 86400_000);
        const recency = 0.5 ** (ageDays / 14); // 14 天半衰
        const heat = (e.weight ?? 0.5) * (1 + Math.log1p(e.evidence.length)) * recency;
        return { e, heat };
      });
      scored.sort((a, b) => b.heat - a.heat);
      const { items: top, pagination } = paginate(scored, args.offset, args.limit, 8, 30, '事件');
      return JSON.stringify(
        {
          session_scope: scope ?? null,
          days,
          pagination,
          events: top.map(s => ({ ...serializeEventForSearch(s.e), heat: Number(s.heat.toFixed(3)) })),
        },
        null,
        2,
      );
    },
  });

  // ───────────────────────────── shared_neighbors ──────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_shared',
        description: [
          '一步返回两个节点的共同邻居（共同兴趣实体 / 共同参与的事件 / 共同认识的人），按 Adamic-Adar 贡献度排序。',
          '典型场景："A 和 B 有啥共同点能撮合"、"他们俩是怎么搭上的"、"找开场话题"。',
          '只是 score 工具 common_neighbors 段的便捷直达版本，省去跑全套 Katz 路径累加。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            a_id: { type: 'string', description: '节点 A id' },
            b_id: { type: 'string', description: '节点 B id' },
            kind: {
              type: 'string',
              enum: ['person', 'event', 'entity', 'any'],
              description: '仅返回该类型的共同邻居；默认 any',
            },
            ...paginationSchema(10, 30, '共同邻居'),
          },
          required: ['a_id', 'b_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const a = String(args.a_id ?? '').trim();
      const b = String(args.b_id ?? '').trim();
      if (!a || !b) return JSON.stringify({ error: 'a_id / b_id 不能为空' });
      const kind = typeof args.kind === 'string' ? args.kind : 'any';
      const r = await service.scoreBetween(a, b, { maxDepth: 2, topPaths: 1, mode: 'symmetric' });
      const filtered = r.commonNeighbors.filter(c => {
        if (kind === 'any') return true;
        if (kind === 'person') return 'platform' in c.node;
        if (kind === 'entity') return 'entityKind' in c.node;
        if (kind === 'event') return !('platform' in c.node) && !('entityKind' in c.node);
        return true;
      });
      const { items: top, pagination } = paginate(filtered, args.offset, args.limit, 10, 30, '共同邻居');
      return JSON.stringify(
        {
          a_id: a,
          b_id: b,
          pagination,
          shared: top.map(c => ({
            degree: c.degree,
            aa_contribution: Number(c.aaContribution.toFixed(4)),
            node: serializeNode(c.node),
          })),
        },
        null,
        2,
      );
    },
  });

  // ───────────────────────── community_peers ─────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_community_peers',
        description: [
          '查"某人所在小圈子里其他活跃成员是谁"。基于 Louvain 社群发现 + PageRank 排序。',
          '典型场景："X 平时跟谁混"、"X 的核心朋友圈"、"找跟 X 同圈子的 KOL"。',
          '注意：',
          '- 社群标签由 evictByQuota 周期性写入，新人/冷门人可能还没有标签，此时返回 communitySize=0、peers=[]。',
          '- communityId 是不透明字符串（c0/c1/...），**仅在同一批次内可比**，不要持久化使用。',
          '- 只返回 person 类型成员；事件/实体也有 communityId 但用户视角无意义。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            person_id: {
              type: 'string',
              description: 'person 节点 ID，必须是 `<platform>:<userId>` 完整格式，例如 `onebot:10001`。',
            },
            ...paginationSchema(5, 20, '同社群成员'),
          },
          required: ['person_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const id = String(args.person_id ?? '').trim();
      const err = await validateNodeId(service, id, 'person_id');
      if (err) return err;
      // service 拉满硬上限池子，handler 再分页
      const r = await service.getCommunityPeers(id, 20);
      const { items: peers, pagination } = paginate(r.peers ?? [], args.offset, args.limit, 5, 20, '同社群成员');
      return JSON.stringify({ ...r, pagination, peers }, null, 2);
    },
  });

  // ───────────────────────── community_bridge ─────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_community_bridge',
        description: [
          '判断两人是否同社群 + 各自社群规模。同社群 = 在 Louvain 标签上一致。',
          '典型场景："X 和 Y 是同一波人吗"、"他俩跨圈了吗"。',
          '想要具体最短路径请改用 user_relation_find_path；本工具只回答"圈层归属"。',
          '注意：未跑过 evictByQuota 的节点 communityId 为 null。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            person_a_id: { type: 'string', description: 'person A 节点 ID（完整 platform:userId）' },
            person_b_id: { type: 'string', description: 'person B 节点 ID（完整 platform:userId）' },
          },
          required: ['person_a_id', 'person_b_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const a = String(args.person_a_id ?? '').trim();
      const b = String(args.person_b_id ?? '').trim();
      const ea = await validateNodeId(service, a, 'person_a_id');
      if (ea) return ea;
      const eb = await validateNodeId(service, b, 'person_b_id');
      if (eb) return eb;
      const r = await service.getCommunityBridge(a, b);
      return JSON.stringify(r, null, 2);
    },
  });

  // ───────────────────────── community_overview ─────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_community_overview',
        description: [
          '【全局】社群发现概览：把所有人按"圈子"分组，列出每个社群的核心成员/话题/事件，并标出"桥梁人"。',
          '典型场景："这群里有几个圈子"、"哪几个人是连接不同圈子的桥梁"、"X 这个 session 里都聊什么"。',
          '参数说明：',
          '- algorithm：可选 "louvain" / "leiden" / "slpa"。不传则用插件默认（一般 louvain）。',
          '  · louvain = 经典快速、硬划分（每人恰好属于一个社群）。',
          '  · leiden = 简化版 Leiden（同硬划分，但保证社群内部连通，稍慢质量略高）；当 louvain 把两群没交集的人塞一起时换它重跑。',
          '  · slpa = Speaker-Listener Label Propagation，原生**重叠社区**算法；一个人可同时属于多个社群（如同时混在 c2 和 c4），bridges 返回的 communityMemberships 字段会展示其多归属。',
          '  · 选择建议：分析"圈子结构清晰度"用 louvain/leiden；分析"跨圈人物 / 多重身份"或 louvain 出来的 bridges 太少时换 slpa。',
          '- session_scope：可选。只统计 evidence 含该 session 的节点（events 看 sessionScope；persons 看是否参与过 scope 内 event；entities 看 evidence）。',
          '  · 注意：社群划分仍在全图上跑，scope 只是后过滤展示，避免切断跨群关系。',
          '- top_n：每个社群展示的成员/话题/事件条数。',
          '  · 不传：per-community 自适应，按各社群规模独立计算 max(3, ceil(log2(comSize+1)))，大社群展示多、小社群展示少，无硬上限。',
          '  · 传 0：不限（全部展示）。',
          '  · 传 >0 整数：一刀切覆盖所有 community / bridges。',
          '- resolution：Louvain/Leiden 分辨率 γ，默认 1.0（**SLPA 不使用该参数**）。',
          '  · γ > 1（如 1.5 / 2.0 / 3.0）：划得**更细更碎**——社群数变多、单社群更小。',
          '  · γ < 1（如 0.7 / 0.5）：划得**更粗**——社群数变少、单社群更大。',
          '  · 当前划分太松散（社群太多/碎片化）就降到 0.5~0.8；太粗（两群被合一起）就升到 1.5~2.5。建议从 0.5/1.0/1.5/2.0 几个挡位试，配合 modularity Q 看哪个最高。',
          '  · 该参数只影响本次返回；不会污染节点缓存里的 communityId（缓存恒为 γ=1.0 基准）。',
          '返回字段：modularity (Q ∈ [-0.5, 1], >0.3 圈子分明；SLPA 下为基于主社群的近似值，仅供参考)、communities[]、bridges[] (跨社群联系最广的 top-N 人；含 communityMemberships 多归属 + communityWeights 外社群权重分布)。',
          '注意：本工具实时跑算法，不依赖节点上的 communityId 缓存——即使 evictByQuota 还没跑也能用。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            algorithm: {
              type: 'string',
              enum: ['louvain', 'leiden', 'slpa'],
              description: '社群发现算法；不传走插件默认配置。louvain/leiden=硬划分；slpa=原生重叠社区（一人多社群）',
            },
            session_scope: {
              type: 'string',
              description: '只统计该 sessionId 内的节点；不传 = 全图',
            },
            top_n: {
              type: 'number',
              description: '不传 = per-community 自适应 log2(comSize+1)；0 = 不限；>0 = 一刀切覆盖。',
            },
            resolution: {
              type: 'number',
              description:
                '分辨率 γ，>1 划得更细更碎（更多小社群），<1 划得更粗（更少大社群）。范围 0.01~100；常用 0.5~3。**不传 = auto 自适应**：γ = clamp(0.6, 2.5, 0.5 + log10(n / 30))，按当前图节点数自动选择，适合大多数场景；只有想强制特定粒度时才显式传数值。',
            },
          },
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const algorithm =
        args.algorithm === 'leiden' || args.algorithm === 'louvain' || args.algorithm === 'slpa'
          ? (args.algorithm as 'louvain' | 'leiden' | 'slpa')
          : undefined;
      const sessionScope =
        typeof args.session_scope === 'string' && args.session_scope.trim().length > 0
          ? String(args.session_scope).trim()
          : undefined;
      const topN = typeof args.top_n === 'number' ? args.top_n : undefined;
      const explicitResolution =
        typeof args.resolution === 'number' && Number.isFinite(args.resolution) && args.resolution > 0
          ? args.resolution
          : undefined;
      // 不传 = 'auto'：service 内部按图规模计算 γ。
      const resolution: number | 'auto' = explicitResolution ?? 'auto';
      const r = await service.getCommunityOverview({ algorithm, sessionScope, topN, resolution });
      // service 已在返回里带 effectiveResolution / resolutionMode，原样转发即可。
      return JSON.stringify(r, null, 2);
    },
  });

  // ───────────────────────────── rename_node ─────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_rename_node',
        description: [
          '把一个 **event / entity** 节点改名（Person 禁改，会与 platform 昵称脱节）。',
          '语义：',
          '- 原 title/name 自动追加到 aliases，旧名仍可通过搜索命中；',
          '- 自动写入 nameHistory 审计条目（from/to/at/by=llm/reason）；',
          '- key/id 不变，所有引用边 0 风险。',
          '使用准则：',
          '- 只在你**确信**新名字更准确时调用（例：发现"绝航"实际是"绝密公司上巴谷"的简称、合并后想换正式名）；',
          '- 必须给出 `reason`（≤80 字）说明为什么改；',
          '- 不要为了"风格化"反复改名；不要把通用词改成更通用的词。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            node_id: { type: 'string', description: '节点 ID（仅 event / entity）' },
            new_name: { type: 'string', description: '新 name / title，≤80 字符，与原名不同' },
            reason: { type: 'string', description: '改名理由（≤80 字），写入 audit log' },
          },
          required: ['node_id', 'new_name', 'reason'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const id = String(args.node_id ?? '').trim();
      const newName = String(args.new_name ?? '').trim();
      const reason = String(args.reason ?? '').trim();
      if (!id) return JSON.stringify({ error: 'node_id 不能为空' });
      if (!newName) return JSON.stringify({ error: 'new_name 不能为空' });
      if (!reason) return JSON.stringify({ error: 'reason 必填，请给出改名理由' });
      // 仅允许 event / entity；person id 形如 'platform:userId'，含冒号直接拒绝
      if (id.includes(':')) {
        return JSON.stringify({
          error: 'Person.name = platform displayName，禁止改名。如需追加别名请走 add-alias 流程。',
        });
      }
      // 先按 event 试，再按 entity 试
      let kind: 'event' | 'entity' | null = null;
      if (await service.getEvent(id)) kind = 'event';
      else if (await service.getEntity(id)) kind = 'entity';
      if (!kind) return JSON.stringify({ error: `node_id ${id} 不存在（event/entity 均未命中）` });
      try {
        const result = await service.renameNode({ kind, id, newName, by: 'llm', reason });
        return JSON.stringify({ ok: true, kind, ...result }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ───────────────────────────── correct_edge ────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_correct_edge',
        description: [
          '修正一条关系边（weaken / strengthen / remove）。',
          '使用场景：',
          '- **weaken**: 发现某条边过强（如 LLM 之前过度提取）、对话否认了这层关系、关系明显淡化',
          '- **strengthen**: 发现某条边过弱但实际很重要（很少这样用，通常 addEdge 自然累加足够）',
          '- **remove**: 确认是幻觉边 / 关系已彻底中断 / 错误归类',
          '阶梯保护（避免误删强关系）：',
          '- weight ≥ 0.5：禁止直接 remove，必须先 weaken 到 < 0.5（建议反复 weaken 至 < 0.3 再 remove）',
          '- 0.3 ≤ weight < 0.5：可 weaken / remove',
          '- weight < 0.3：自由',
          '禁止操作 **alias 边**（relationType = is-alias-of / alt-account-of）—— 这是结构性边，错绑请走后续 splitAlias 流程，不要 weaken/remove。',
          '使用准则：必须先用 list_edges / find_path 拿到具体 edge id；必填 reason（≤80 字）说明判断依据。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            edge_id: { type: 'string', description: '边 ID（UUID）。先用 list_edges / find_path / expand_node 拿到。' },
            action: {
              type: 'string',
              enum: ['weaken', 'strengthen', 'remove'],
              description:
                'weaken=权重×multiplier(默认0.5)；strengthen=权重×multiplier(默认1.5)；remove=物理删除（受阶梯保护）',
            },
            multiplier: {
              type: 'number',
              description:
                '可选；weaken 时 ∈(0,1)，默认 0.5；strengthen 时 ∈(1,5]，默认 1.5；remove 时忽略。激进衰减用 0.3，温和用 0.7。',
            },
            reason: { type: 'string', description: '修正理由（≤80 字），写入 weightHistory[]' },
          },
          required: ['edge_id', 'action', 'reason'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const edgeId = String(args.edge_id ?? '').trim();
      const action = String(args.action ?? '').trim() as 'weaken' | 'strengthen' | 'remove';
      const reason = String(args.reason ?? '').trim();
      if (!edgeId) return JSON.stringify({ error: 'edge_id 不能为空' });
      if (action !== 'weaken' && action !== 'strengthen' && action !== 'remove') {
        return JSON.stringify({ error: 'action 必须是 weaken / strengthen / remove' });
      }
      if (!reason) return JSON.stringify({ error: 'reason 必填，请说明修正理由' });
      const multiplier =
        typeof args.multiplier === 'number' && Number.isFinite(args.multiplier) ? args.multiplier : undefined;
      try {
        const result = await service.correctEdge({ edgeId, action, multiplier, reason, by: 'llm' });
        return JSON.stringify(
          {
            ok: true,
            action: result.action,
            edge_id: result.edgeId,
            weight_from: Number(result.from.toFixed(4)),
            weight_to: Number(result.to.toFixed(4)),
            ...(result.edge ? { edge: serializeEdge(result.edge) } : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ───────────────────────────── delete_node ──────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_delete_node',
        description: [
          '物理删除一个 **event / entity** 节点（级联删除所有相连边）。**Person 节点禁用**——人是 platform 身份，只能由 user-profile 同步。',
          '保护门（任一命中则拒绝）：',
          '- weight ≥ 0.8 → 强节点保护',
          '- evidence.length ≥ 5 → 强证据保护',
          '- 节点不存在 → 报错',
          '使用准则：',
          '- 只在你**确信**该节点是幻觉 / 重复 / 已过时无用时调用。',
          '- 删除前先 expand_node / list_edges 看清影响范围，写进 reason。',
          '- 若不确定，优先使用 merge_nodes（合并到 canonical）或 correct_edge weaken（弱化）。',
          '- 全部操作 logger.warn 审计。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['event', 'entity'], description: '节点类型（person 禁用）' },
            node_id: { type: 'string', description: '节点 ID（UUID）。先用 resolve_node / search_* 拿到。' },
            reason: { type: 'string', description: '删除理由（≤120 字），写入 audit log' },
          },
          required: ['kind', 'node_id', 'reason'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const kind = String(args.kind ?? '').trim() as 'event' | 'entity';
      const id = String(args.node_id ?? '').trim();
      const reason = String(args.reason ?? '').trim();
      if (kind !== 'event' && kind !== 'entity') {
        return JSON.stringify({ error: 'kind 必须是 event / entity（person 禁删）' });
      }
      if (!id) return JSON.stringify({ error: 'node_id 不能为空' });
      if (id.includes(':')) {
        return JSON.stringify({ error: 'person 节点禁止删除（id 含冒号）' });
      }
      if (!reason) return JSON.stringify({ error: 'reason 必填，请说明删除理由' });
      try {
        const result = await service.deleteNode({ kind, id, reason, by: 'llm' });
        return JSON.stringify({ ok: true, ...result }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ───────────────────────────── delete_edge ──────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_delete_edge',
        description: [
          '物理删除一条关系边（与 correct_edge.remove 不同：本工具适用于「确信彻底无效」的场景，直接删；correct_edge 适用于「权重需要调整」的场景）。',
          '保护门（任一命中则拒绝）：',
          '- relationType = is-alias-of / alt-account-of → alias 边禁删（破坏身份合并）',
          '- weight ≥ 0.8 → 强边保护，请先 correct_edge weaken',
          '- evidence.length ≥ 5 → 强证据保护',
          '使用准则：先用 list_edges / find_path 拿到 edge_id；必填 reason（≤120 字）。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            edge_id: { type: 'string', description: '边 ID（UUID）' },
            reason: { type: 'string', description: '删除理由（≤120 字）' },
          },
          required: ['edge_id', 'reason'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const edgeId = String(args.edge_id ?? '').trim();
      const reason = String(args.reason ?? '').trim();
      if (!edgeId) return JSON.stringify({ error: 'edge_id 不能为空' });
      if (!reason) return JSON.stringify({ error: 'reason 必填' });
      try {
        const result = await service.deleteEdgeWithGuard({ edgeId, reason, by: 'llm' });
        return JSON.stringify({ ok: true, ...result }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ───────────────────────────── merge_nodes ──────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_merge_nodes',
        description: [
          '把多个 **event / entity** 节点物理合并到一个 canonical 节点（搬移所有边并物理删除 alias 节点）。',
          '语义：所有 alias 节点的边被改写指向 canonical，重复边自动 dedup；alias 节点本身被删除（无残留）。',
          'Person 节点的合并请走 /relation cleanup 命令（保留 alias 标记边，不物理删）。',
          '使用场景：',
          '- 同一事件被 LLM 分成多个 title（"那次吵架" / "群里吵架" / "上周冲突"）→ 合并到一个 canonical',
          '- 同一实体（"DLT" / "三角洲行动" / "三角洲"）→ 合并到正式名',
          '准则：',
          '- 先用 search_* / resolve_node 确认 canonical 与 aliasIds 全部存在且语义相同',
          '- 不可逆操作，务必谨慎；reason 必填（≤120 字）',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['event', 'entity'], description: '节点类型（person 走 cleanup）' },
            canonical_id: { type: 'string', description: '保留的正式节点 ID' },
            alias_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '要并入并物理删除的 alias 节点 ID 列表（去重，且不能等于 canonical_id）',
            },
            reason: { type: 'string', description: '合并理由（≤120 字）' },
          },
          required: ['kind', 'canonical_id', 'alias_ids', 'reason'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const kind = String(args.kind ?? '').trim() as 'event' | 'entity';
      const canonicalId = String(args.canonical_id ?? '').trim();
      const aliasIds = (Array.isArray(args.alias_ids) ? (args.alias_ids as unknown[]) : [])
        .filter((s): s is string => typeof s === 'string')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      const reason = String(args.reason ?? '').trim();
      if (kind !== 'event' && kind !== 'entity') {
        return JSON.stringify({ error: 'kind 必须是 event / entity' });
      }
      if (!canonicalId) return JSON.stringify({ error: 'canonical_id 不能为空' });
      if (aliasIds.length === 0) return JSON.stringify({ error: 'alias_ids 至少 1 个' });
      if (!reason) return JSON.stringify({ error: 'reason 必填' });
      try {
        const result = await service.mergeNodes({ kind, canonicalId, aliasIds, reason, by: 'llm' });
        return JSON.stringify({ ok: true, ...result }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ─────────────────────────── change_entity_kind ─────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_change_entity_kind',
        description: [
          '修改 entity 的 kind（topic / place / thing / work）。',
          '使用场景：发现某节点的 kind 提取错了（如把游戏《三角洲》误标为 topic，应改为 work）。',
          '语义：仅写 entityKind 字段，id / name / 边 全部不变。轻量操作，无破坏性，但仍需 reason。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            entity_id: { type: 'string', description: '实体 ID（UUID）' },
            new_kind: {
              type: 'string',
              enum: ['topic', 'place', 'thing', 'work'],
              description: '新 kind：topic=话题/兴趣 / place=地点 / thing=物品/商品 / work=作品/游戏/影视/书籍',
            },
            reason: { type: 'string', description: '修改理由（≤120 字）' },
          },
          required: ['entity_id', 'new_kind', 'reason'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const entityId = String(args.entity_id ?? '').trim();
      const newKind = String(args.new_kind ?? '').trim() as 'topic' | 'place' | 'thing' | 'work';
      const reason = String(args.reason ?? '').trim();
      if (!entityId) return JSON.stringify({ error: 'entity_id 不能为空' });
      if (!['topic', 'place', 'thing', 'work'].includes(newKind)) {
        return JSON.stringify({ error: 'new_kind 必须是 topic / place / thing / work' });
      }
      if (!reason) return JSON.stringify({ error: 'reason 必填' });
      try {
        const result = await service.changeEntityKind({ entityId, newKind, reason, by: 'llm' });
        return JSON.stringify({ ok: true, ...result }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ───────────────────────────── node_score ───────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_node_score',
        description: [
          '**单节点**的综合活跃度评分 + 同 kind / 全图排名 + 分级（tier）。**不是**两节点关系紧密度——后者用 `user_relation_score`。',
          '',
          '🔑 person 节点 ID 必须是 `<platform>:<userId>`（如 `onebot:10001`），裸 userId 会返回“节点不存在”错误。不确定先调 `user_relation_resolve_node`。',
          '',
          '返回字段及取值范围请参见本组顶部「📊 分数语义」段落。优先看 **tier**（core/active/normal/edge）+ **percentileInKind**（0..1，越大越中心）+ **rankInKind**（"2/14"），它们已经把绝对分与图内相对位置都考虑了，比裸 compositeScore 更直观。',
          '注意 **pagerankFresh** 字段：false 表示节点从未参与过 PageRank 计算，此时 pagerank=0 不代表"边缘"，请用 tier/percentile 判断。',
          '使用场景：判断"是否应该深挖这个节点"、"这个节点是否值得清理"、"用户提到的人在图里有多大份量"。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            node_id: {
              type: 'string',
              description:
                '节点 ID。person 形如 `<platform>:<userId>`（如 `onebot:10001`）；event/entity 为 UUID。不确定先用 user_relation_resolve_node。',
            },
          },
          required: ['node_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const id = String(args.node_id ?? '').trim();
      const err = await validateNodeId(service, id, 'node_id');
      if (err) return err;
      try {
        const score = await service.computeNodeScore(id);
        if (!score) return JSON.stringify({ error: `节点 ${id} 不存在` });
        return JSON.stringify(score, null, 2);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ───────────────────────────── directional_degree ───────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_relation_directional_degree',
        description: [
          '统计节点的「有向出/入度剖面」，刻画单向语义信号——典型用途：',
          '- 粉丝/偶像分析：fanIdolHint.verdict + inByType.admirer / outByType.admirer 的 count（"被多少人 admire" vs "admire 多少人"）',
          '- 师徒上下游：inByType.mentor（"谁的徒弟/学生指向我"）vs outByType.mentor（"我指向谁当师父"）',
          '- 因果/时序 source/sink（event 节点）：inByType."caused-by" vs outByType."caused-by"',
          '- part-of 上下游（event/entity 节点）：inByType."part-of" 即"被谁包含为部分"，outByType."part-of" 即"作为部分指向谁"',
          '⚠️ 仅统计 directed=true 的主体边（person-person / event-event / entity-entity）。',
          '桥型边（person-event/person-entity/event-entity）按设计总是双向，是"参与"不是"指代"，故不计入本剖面；',
          '若需"该人参与了几件事"等参与度信号，用 expand_node / timeline / node_score。',
          '返回 dominance：outgoing=偏主动方（粉丝/学生型），incoming=偏被指方（偶像/导师型），balanced=平衡。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            node_id: {
              type: 'string',
              description:
                '节点 ID。person 形如 `<platform>:<userId>`（如 `onebot:10001`）；event/entity 是 UUID。不确定先用 user_relation_resolve_node。',
            },
            top_per_type: {
              type: 'number',
              description: '每个 relationType 下返回的 top-K 对端节点（按 weight 降序）。默认 5，范围 1~20',
            },
          },
          required: ['node_id'],
          additionalProperties: false,
        },
      },
    },
    groups: [groupName],
    handler: async args => {
      const id = String(args.node_id ?? '').trim();
      const err = await validateNodeId(service, id, 'node_id');
      if (err) return err;
      const topPerType = clampNum(args.top_per_type, 5, 1, 20);
      try {
        const r = await service.computeDirectionalDegree(id, { topPerType });
        if (!r) return JSON.stringify({ error: `节点 ${id} 不存在` });
        return JSON.stringify(r, null, 2);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  if (cfg.debug) {
    ctx.logger.debug(
      `[user-relation] 已注册 20 个工具到分组 ${groupName}（resolve_node / expand_node / find_path / score / search_persons / search_entities / search_events / list_edges / timeline / recommend_persons / gossip / shared / rename_node / correct_edge / delete_node / delete_edge / merge_nodes / change_entity_kind / node_score / directional_degree）`,
    );
  }
}

// ─────────────────────────────── helpers ────────────────────────────────

function clampNum(raw: unknown, fallback: number, min: number, max: number): number {
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/**
 * 通用分页：把任意数组按 offset/limit 切片，并附加 pagination 元信息 + 给 LLM 的操作提示。
 *
 * 使用约定：
 * - 工具 schema 里 limit/offset 都是可选；默认 limit 由调用方传入；硬上限 hardMaxLimit 防止 LLM 一次拉满爆 token。
 * - 返回的 pagination.hint 以中文给 LLM 写明"还有几条 / 怎么翻页 / 怎么一次多拿"。
 * - 注意：分页发生在 service 计算完成之后，total 总是反映全量结果数量。
 */
interface PaginationMeta {
  offset: number;
  limit: number;
  total: number;
  returned: number;
  hasMore: boolean;
  nextOffset?: number;
  hint: string;
}
function paginate<T>(
  items: T[],
  rawOffset: unknown,
  rawLimit: unknown,
  defaultLimit: number,
  hardMaxLimit: number,
  label = '条目',
): { items: T[]; pagination: PaginationMeta } {
  const off = clampNum(rawOffset, 0, 0, Number.MAX_SAFE_INTEGER);
  const lim = clampNum(rawLimit, defaultLimit, 1, hardMaxLimit);
  const total = items.length;
  const sliced = items.slice(off, off + lim);
  const hasMore = off + sliced.length < total;
  const remaining = total - off - sliced.length;
  let hint: string;
  if (total === 0) {
    hint = `${label} 共 0 条。`;
  } else if (off >= total) {
    hint = `${label} 共 ${total} 条，offset=${off} 已越界（最大可用 offset=${Math.max(0, total - 1)}）。`;
  } else if (hasMore) {
    hint = `已返回 ${label} 第 ${off + 1}-${off + sliced.length} 条（共 ${total}）；还有 ${remaining} 条未返回。如需更多，传 offset=${off + sliced.length} 翻页，或加大 limit（硬上限 ${hardMaxLimit}）。`;
  } else {
    hint =
      off === 0
        ? `已返回 ${label} 全部 ${total} 条。`
        : `已返回 ${label} 第 ${off + 1}-${off + sliced.length} 条（共 ${total}，至此结束）。`;
  }
  const meta: PaginationMeta = {
    offset: off,
    limit: lim,
    total,
    returned: sliced.length,
    hasMore,
    ...(hasMore ? { nextOffset: off + sliced.length } : {}),
    hint,
  };
  return { items: sliced, pagination: meta };
}

/**
 * 在工具 schema 中复用的 limit / offset 字段定义生成器。返回 `{ limit, offset }` 两个 property。
 */
function paginationSchema(defaultLimit: number, hardMaxLimit: number, label = '条目'): Record<string, unknown> {
  return {
    limit: {
      type: 'number',
      description: `本次最多返回多少${label}。默认 ${defaultLimit}，硬上限 ${hardMaxLimit}。可分页：配合 offset 翻页，或一次性传更大 limit。`,
    },
    offset: {
      type: 'number',
      description: `从第几条开始返回（0-based，用于翻页）。默认 0。返回的 pagination.nextOffset 直接喂回来即可拿下一页。`,
    },
  };
}

/**
 * 校验节点 ID 是否存在；不存在则返回 friendly JSON 错误串，存在则返回 null。
 * 主要解决 LLM 把 person 裸 userId（如 "123456"）当成完整 node_id 用导致后续接口
 * 沉默返回空结果的问题——把"节点不存在"显式抛回去，并提示先调 resolve_node。
 */
async function validateNodeId(service: RelationService, id: string, paramName = 'node_id'): Promise<string | null> {
  if (!id) return JSON.stringify({ error: `${paramName} 不能为空` });
  const hit = await service.findNodeById(id);
  if (hit) return null;
  const hasColon = id.includes(':');
  const hint = hasColon
    ? '该 ID 在图中不存在。检查拼写；person 节点请用 user_relation_resolve_node 或 user_relation_search_persons 按名字/userId 查到正确 ID 再调用。'
    : '该 ID 在图中不存在。person 节点 ID 必须是 `<platform>:<userId>` 完整格式（如 `onebot:123456`），不能只填 userId。若不确定 platform 或想由名字反查，先调 user_relation_resolve_node。';
  return JSON.stringify({ error: `节点 "${id}" 不存在`, hint });
}

/** 事件 sessionScope 与调用者传入 scope 是否匹配。`scope` 未传 = 不过滤；event 无 sessionScope 视为 'global'。 */
function inScope(scope: string | undefined, evScope: string | undefined): boolean {
  if (!scope) return true;
  return (evScope ?? 'global') === scope;
}

/** 取边上所有事件节点引用 id（用于按 event 集合过滤边）。 */
function getEventIdsFromEdge(e: RelationEdge): string[] {
  if (e.kind === 'person-event') return [(e as PersonEventEdge).toEventId];
  if (e.kind === 'event-event') return [(e as EventEventEdge).fromEventId, (e as EventEventEdge).toEventId];
  if (e.kind === 'event-entity') return [(e as EventEntityEdge).fromEventId];
  return [];
}

/** 按 sessionScope 过滤子图：退出限定会话外的 events，连带过滤所有引用这些 event 的边。Person/Entity 节点保留。 */
function filterSubgraphByScope<
  T extends { persons: PersonNode[]; events: EventNode[]; entities: EntityNode[]; edges: RelationEdge[] },
>(sub: T, scope: string | undefined): T {
  if (!scope) return sub;
  const keepEvIds = new Set(sub.events.filter(e => inScope(scope, e.sessionScope)).map(e => e.id));
  return {
    ...sub,
    events: sub.events.filter(e => keepEvIds.has(e.id)),
    edges: sub.edges.filter(e => {
      const refs = getEventIdsFromEdge(e);
      return refs.every(id => keepEvIds.has(id));
    }),
  };
}

function serializeSubgraph(sub: {
  persons: PersonNode[];
  events: EventNode[];
  entities?: EntityNode[];
  edges: RelationEdge[];
}) {
  return {
    persons: sub.persons.map(serializePerson),
    events: sub.events.map(e => ({
      id: e.id,
      title: e.title,
      category: e.category,
      sessionScope: e.sessionScope ?? 'global',
      summary: e.summary,
      lastReinforcedAt: e.lastReinforcedAt,
    })),
    entities: (sub.entities ?? []).map(serializeEntity),
    edges: sub.edges.map(serializeEdge),
  };
}

function serializePerson(p: PersonNode) {
  return {
    id: p.id,
    platform: p.platform,
    userId: p.userId,
    displayName: p.displayName,
    lastSeenAt: p.lastSeenAt,
    lastMentionedAt: p.lastMentionedAt,
    mentionCount: p.mentionCount,
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
  return { kind: 'event', id: n.id, title: n.title, category: n.category, sessionScope: n.sessionScope ?? 'global' };
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
      description: pe.description,
      lastReinforcedAt: pe.lastReinforcedAt,
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
      description: pe.description,
      lastReinforcedAt: pe.lastReinforcedAt,
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
      description: ee.description,
      lastReinforcedAt: ee.lastReinforcedAt,
    };
  }
  if (e.kind === 'event-entity') {
    const ee = e as EventEntityEdge;
    return {
      kind: 'event-entity',
      id: ee.id,
      from: ee.fromEventId,
      to: ee.toEntityId,
      relation: ee.relationType,
      directed: ee.directed,
      weight: ee.weight,
      description: ee.description,
      lastReinforcedAt: ee.lastReinforcedAt,
    };
  }
  if (e.kind === 'entity-entity') {
    const ee = e as EntityEntityEdge;
    return {
      kind: 'entity-entity',
      id: ee.id,
      from: ee.fromEntityId,
      to: ee.toEntityId,
      relation: ee.relationType,
      directed: ee.directed,
      weight: ee.weight,
      description: ee.description,
      lastReinforcedAt: ee.lastReinforcedAt,
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
    description: pp.description,
    lastReinforcedAt: pp.lastReinforcedAt,
  };
}

function serializeEventForSearch(e: EventNode) {
  return {
    id: e.id,
    title: e.title,
    category: e.category,
    sessionScope: e.sessionScope ?? 'global',
    summary: e.summary,
    lastReinforcedAt: e.lastReinforcedAt,
    evidenceCount: e.evidence.length,
  };
}
