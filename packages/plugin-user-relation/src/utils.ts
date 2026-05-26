/**
 * utils.ts —— RelationService 用到的纯函数 / 常量。
 *
 * 拆出动机：service.ts 原 3000+ 行，把不依赖 `this` 的模块级 helper（去重键、PageRank、
 * 边邻接、名称归一化、别名合并启发式等）抽出来，让 service.ts 更聚焦于"类暴露的应用层 API"。
 *
 * 行为零变化：本文件函数全部来自 service.ts 的原模块级声明，原样搬运。
 */
import type {
  CommunityMembership,
  EntityEntityEdge,
  EntityNode,
  EventEntityEdge,
  EventEventEdge,
  EventNode,
  EvidenceRef,
  PersonEntityEdge,
  PersonEventEdge,
  PersonPersonEdge,
  RelationEdge,
  RelationGraphSnapshot,
} from './types.js';

const MAX_EVIDENCE_PER_ENTITY = 10; // 单实体保留的 evidence 上限，更早的会被裁掉

/**
 * 人-事件角色优先级。同一 (person, event) 只保留最强角色的一条边：
 * 发起者 > 参与者 > 被指向 > 转述者 > 旁观者。语义上强角色含盖弱角色。
 */
export const PERSON_EVENT_ROLE_RANK: Record<PersonEventEdge['role'], number> = {
  initiator: 5,
  participant: 4,
  target: 3,
  reporter: 2,
  witness: 1,
};

/**
 * 人-实体角色优先级。同一 (person, entity) 只保留最强角色。
 * 热爱 > 创作者 > 拥有者 > 批评者 > 参与者 > 访问者 > 仅提及。
 */
export const PERSON_ENTITY_ROLE_RANK: Record<PersonEntityEdge['role'], number> = {
  enthusiast: 6,
  creator: 5,
  owner: 4,
  critic: 3,
  participant: 2,
  visitor: 1,
  mentioned: 0,
};

/**
 * 各类边的"按 role / relationType 区分"的首次建边默认权重表（保守档）。
 *
 * 设计意图：
 *  - 边语义有强弱（initiator 比 witness 重，enthusiast 比 mentioned 重，
 *    is-alias-of 是强声明），第一条 evidence 进来时就该体现差异，
 *    不要全部 0.5 一刀切。
 *  - 数值整体偏保守，给后续 `reinforceWeight(prev, 0.1)` 累积留出空间，
 *    避免高初始权 + 频繁 reinforce 把上限榨干（误差被反复放大）。
 *  - **仅作用于"首次建边"**。`reinforce` / agent `correctEdge` 路径不变。
 *  - LLM / agent 仍可显式传 `input.weight` 覆盖默认值；表只在 `?? fallback` 处生效。
 *
 * 未列举的自创 relationType（LLM 可能造词）走 `default`。
 *
 * 当前仅作为 `roleDefaultWeight()` 的内部查表，不对外 export；
 * 若将来需要让 agent 查"系统默认权是多少"，再考虑改 export。
 *
 * ─────────────────────────────────────────────────────────────
 * ⚠️ weight 字段的**双重语义**（**有意妥协**，非 bug）：
 *
 *   最终 weight = 初始 role 默认权（语义强弱 / 亲密度档位）
 *              ⊕ reinforceWeight 累积（频次：被反复提及的次数）
 *
 *   这意味着：一条初始 `mentioned`(0.1) 的边被频繁提及后，
 *   weight 可能累积到 0.95，超过一条初始 `friend`(0.5) 但只被提一次的边。
 *   此时按 weight 排序 ≠ 按"亲密度"排序，而是 ≈ "亲密度 × 关注度" 的混合。
 *
 *   为什么不拆？淘汰评分、强节点保护、相似度评分都需要的是这个混合量
 *   （"既亲又频"的关系才该保护，"虽亲但久不提"和"虽频但浅"都该降权），
 *   单独的 baseStrength 字段没有独立消费方，YAGNI。
 *
 *   消费方注意：**weight ≠ 纯亲密度**。如果要"按关系亲密度"分类，
 *   应该按 role/relationType（如 friend/cp/mentor）筛，**不要**按 weight 阈值切。
 * ─────────────────────────────────────────────────────────────
 */
const ROLE_DEFAULT_WEIGHT = {
  /** person-event：发起 > 参与 ≈ 被指向 > 转述 > 旁观 */
  personEvent: {
    initiator: 0.5,
    participant: 0.4,
    target: 0.4,
    reporter: 0.25,
    witness: 0.15,
  } as Record<PersonEventEdge['role'], number>,
  /** person-entity：热爱 > 创作 > 拥有 > 批评 > 参与 > 访问 > 仅提及 */
  personEntity: {
    enthusiast: 0.55,
    creator: 0.5,
    owner: 0.45,
    critic: 0.4,
    participant: 0.3,
    visitor: 0.2,
    mentioned: 0.1,
  } as Record<PersonEntityEdge['role'], number>,
  /** person-person：is-alias-of/alt-account-of 是强声明；friend/cp/mentor 是稳态关系 */
  personPerson: {
    'is-alias-of': 0.7,
    'alt-account-of': 0.7,
    friend: 0.5,
    cp: 0.5,
    mentor: 0.5,
    colleague: 0.4,
    rival: 0.4,
    familiar: 0.35,
    admirer: 0.35,
    antagonist: 0.35,
    default: 0.4,
  } as Record<string, number>,
  /** event-event：part-of 是结构性，caused-by 是因果，其他弱 */
  eventEvent: {
    'part-of': 0.5,
    'caused-by': 0.45,
    default: 0.3,
  } as Record<string, number>,
  /** event-entity：part-of 强 > about > related */
  eventEntity: {
    'part-of': 0.5,
    about: 0.35,
    related: 0.25,
    default: 0.3,
  } as Record<string, number>,
  /** entity-entity：is-alias-of 强声明 > part-of 结构 > 其他 */
  entityEntity: {
    'is-alias-of': 0.6,
    'part-of': 0.45,
    default: 0.3,
  } as Record<string, number>,
} as const;

/**
 * 给定边类型 + role/relationType，返回首次建边的默认权重。
 * 未命中 → 走该 kind 的 `default`；person-event/person-entity 没有 default，
 * 因为 role 是闭合枚举（按 RANK 已穷举），未命中说明上游类型错误，安全兜底 0.3。
 */
export function roleDefaultWeight(kind: 'person-event', role: PersonEventEdge['role']): number;
export function roleDefaultWeight(kind: 'person-entity', role: PersonEntityEdge['role']): number;
export function roleDefaultWeight(
  kind: 'person-person' | 'event-event' | 'event-entity' | 'entity-entity',
  relationType: string,
): number;
export function roleDefaultWeight(kind: string, key: string): number {
  switch (kind) {
    case 'person-event': {
      const v = ROLE_DEFAULT_WEIGHT.personEvent[key as PersonEventEdge['role']];
      return typeof v === 'number' ? v : 0.3;
    }
    case 'person-entity': {
      const v = ROLE_DEFAULT_WEIGHT.personEntity[key as PersonEntityEdge['role']];
      return typeof v === 'number' ? v : 0.3;
    }
    case 'person-person': {
      const t = ROLE_DEFAULT_WEIGHT.personPerson;
      return t[key] ?? t.default;
    }
    case 'event-event': {
      const t = ROLE_DEFAULT_WEIGHT.eventEvent;
      return t[key] ?? t.default;
    }
    case 'event-entity': {
      const t = ROLE_DEFAULT_WEIGHT.eventEntity;
      return t[key] ?? t.default;
    }
    case 'entity-entity': {
      const t = ROLE_DEFAULT_WEIGHT.entityEntity;
      return t[key] ?? t.default;
    }
    default:
      return 0.3;
  }
}

/** 边邻接索引：供 BFS 复用，避免每次扫全表 */
export function buildAdjacency(edges: RelationEdge[]) {
  const peByPerson = new Map<string, PersonEventEdge[]>();
  const ppByPerson = new Map<string, PersonPersonEdge[]>();
  const peByEvent = new Map<string, PersonEventEdge[]>();
  const pentByPerson = new Map<string, PersonEntityEdge[]>();
  const pentByEntity = new Map<string, PersonEntityEdge[]>();
  const eeByEvent = new Map<string, EventEventEdge[]>();
  // event-entity 双向索引（事件节点 / 实体节点都可能作为 BFS 起点）
  const eentByEvent = new Map<string, EventEntityEdge[]>();
  const eentByEntity = new Map<string, EventEntityEdge[]>();
  // entity-entity 索引：无向边两端均插入
  const ententByEntity = new Map<string, EntityEntityEdge[]>();
  const push = <K, V>(map: Map<K, V[]>, k: K, v: V) => {
    const arr = map.get(k);
    if (arr) arr.push(v);
    else map.set(k, [v]);
  };
  for (const e of edges) {
    if (e.kind === 'person-event') {
      push(peByPerson, e.fromPersonId, e);
      push(peByEvent, e.toEventId, e);
    } else if (e.kind === 'person-entity') {
      push(pentByPerson, e.fromPersonId, e);
      push(pentByEntity, e.toEntityId, e);
    } else if (e.kind === 'event-event') {
      push(eeByEvent, e.fromEventId, e);
      if (!e.directed) push(eeByEvent, e.toEventId, e);
    } else if (e.kind === 'event-entity') {
      push(eentByEvent, e.fromEventId, e);
      push(eentByEntity, e.toEntityId, e);
    } else if (e.kind === 'entity-entity') {
      push(ententByEntity, e.fromEntityId, e);
      if (!e.directed) push(ententByEntity, e.toEntityId, e);
    } else {
      push(ppByPerson, e.fromPersonId, e);
      if (!e.directed) push(ppByPerson, e.toPersonId, e);
    }
  }
  return {
    peByPerson,
    ppByPerson,
    peByEvent,
    pentByPerson,
    pentByEntity,
    eeByEvent,
    eentByEvent,
    eentByEntity,
    ententByEntity,
  };
}

// ----- 辅助函数 -----

/** 节点名称归一化：用于按名去重和别名匹配。
 *  零风险规则（确定无歧义、不会错合）：
 *    - NFKC 归一化：全角→半角、合字拆分（避免「ＡＢＣ」与「ABC」不等）
 *    - trim + 压缩中间空白
 *    - 小写化（英文）
 *    - 去除外层装饰符号：中英文书名号《》「」『』【】〈〉、引号""''""''、括号（）()[]、空格
 *      （这些只是"装饰"，不改变指代——「《绝航》」与「绝航」是同一对象）
 *  注意：不做后缀剥离（如「OL/手游/PC版」），那种语义合并交给 LLM verifyAliasPair。
 */
export function normalizeName(name: string): string {
  return (
    name
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[《》「」『』【】〈〉()()[\]"'""''""''`]/g, '')
      // 连接符 / 下划线 / 中点 视为「装饰」去除：
      //   「三角洲-行动」/「三角洲_行动」/「三角洲·行动」 ≡ 「三角洲行动」
      .replace(/[-_·]/g, '')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

/** 计算两字符串的最长公共前缀（按 UTF-16 code unit，对中文足够稳定）。 */
export function commonPrefix(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** weight 累积：增量按 (1 - weight) * delta 收敛，避免无限增长 */
export function reinforceWeight(prev: number, delta: number): number {
  return prev + (1 - prev) * delta;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * 时间衰减配置：用于把"原始 weight"换算成"当前有效 weight"。
 *
 * 设计动机：reinforceWeight 让 weight 单调累积（0.5→0.65→...→1.0），
 * 多轮老化后图里会沉淀一批"高 weight 老节点 / 强边"占满配额、永不淘汰。
 * 加上时间衰减让 weight 自然回退，反复被提及的关系靠新的强化撑起来，
 * 而不再被提及的关系会逐渐退出 top-N / 淘汰受保护范围。
 *
 * Eager 模式（当前选择）：每次 `evictByQuota` 入口先调用
 * `RelationService.rewriteWeights`，把所有 event/entity/edge 的 raw `weight`
 * 物理改写为 `effectiveWeight`、并把 `lastReinforcedAt` 推到 now（作为新的衰减基准）。
 * 优点：
 *   - DB 字段始终反映"当下真实强度"，便于调试 / 观察 / WebUI 展示
 *   - reinforceWeight 从已衰减的 raw 出发渐进恢复（0.3 → 0.37 → 0.43…），
 *     不像 lazy 模式 raw 卡死在 1.0 时 reinforceWeight(1.0, δ)=1.0、effW 离散跳跃
 *   - "淘汰排序"与 lazy 等价（都按 effectiveWeight），无策略回退
 *
 * Lazy 备选（已弃）：DB 存 raw 累积值，effectiveWeight 仅查询时算。
 *   缺点：raw 卡死高位时 reinforce 无渐进感、跨时间快照难比较实际强度。
 *
 * `effectiveWeight()` 仍是核心函数：rewriteWeights 调用它做回写、
 * scoring / sorting / eviction 在两次 rewrite 之间也照常调用它做"实时校正"。
 *
 * - `halfLifeDays <= 0`：不衰减（向后兼容；rewriteWeights 也会 short-circuit）
 * - `halfLifeDays > 0`：half-life 后 effW = raw × 0.5，half-life × log2(1/floor) 后达到 floor 不再衰减
 * - `floor`：衰减下限因子（默认 0.3），保护"老朋友"——再久不联系也保留 30% 强度
 */
export interface WeightDecayCfg {
  halfLifeDays: number;
  floor: number;
}

/**
 * 计算"当前有效 weight"：raw × max(0.5^(days/halfLife), floor)。
 *
 * - halfLifeDays<=0：直接返回 raw（向后兼容）
 * - 使用 max(factor, floor)：衰减不会无限趋近 0，保留长期关系底色
 */
export function effectiveWeight(
  raw: number | undefined,
  lastReinforcedAt: number,
  now: number,
  cfg: WeightDecayCfg,
): number {
  const w = raw ?? 0;
  if (cfg.halfLifeDays <= 0) return w;
  const days = Math.max(0, (now - lastReinforcedAt) / 86400000);
  const factor = Math.max(cfg.floor, 0.5 ** (days / cfg.halfLifeDays));
  return clamp01(w * factor);
}

/** 单实体保留最近 N 条 evidence（按 extractedAt DESC 截断 + 同 key 去重）
 *  去重双键：
 *    1) `sessionId|sorted(messageIds).join(',')` — 精确判同：同会话同批 messageIds 视为重复。
 *    2) 内容合并：同 sessionId + 同 quote 且 messageIds **存在交集** → 合并为一条
 *       （messageIds 取并集，extractedAt 取较新者）。这覆盖「滑动窗口对同句重复抽取」场景，
 *       但不会把完全不相交的同句条目（可能是不同时段不同人重复说）错误合并。
 */
export function trimEvidence(list: EvidenceRef[]): EvidenceRef[] {
  // 1) 按 sessionId|quote 分桶，桶内按 messageIds 是否相交进行合并
  const buckets = new Map<string, EvidenceRef[]>(); // key = sessionId|q:quote
  const passthrough: EvidenceRef[] = []; // 无 quote → 不参与内容合并，仅走 evidenceKey 兜底
  for (const e of list) {
    const qk = quoteKey(e);
    if (!qk) {
      passthrough.push(e);
      continue;
    }
    const arr = buckets.get(qk);
    if (!arr) {
      buckets.set(qk, [{ ...e, messageIds: [...new Set(e.messageIds)] }]);
      continue;
    }
    // 在桶内寻找 messageIds 有交集的现存条目并合并；否则新增一条
    const incomingIds = new Set(e.messageIds);
    let mergedInto: EvidenceRef | undefined;
    for (let i = 0; i < arr.length; i++) {
      const cur = arr[i];
      if (cur.messageIds.some(id => incomingIds.has(id))) {
        const unionIds = [...new Set([...cur.messageIds, ...e.messageIds])];
        arr[i] = {
          ...cur,
          messageIds: unionIds,
          extractedAt: Math.max(cur.extractedAt, e.extractedAt),
          quote: cur.quote ?? e.quote,
        };
        mergedInto = arr[i];
        break;
      }
    }
    if (!mergedInto) arr.push({ ...e, messageIds: [...new Set(e.messageIds)] });
  }
  // 2) 合并后做 messageIds-key 兜底去重 + 按 extractedAt DESC 截断
  const merged: EvidenceRef[] = [...passthrough];
  for (const arr of buckets.values()) merged.push(...arr);
  const sorted = merged.sort((a, b) => b.extractedAt - a.extractedAt);
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const e of sorted) {
    const k = evidenceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= MAX_EVIDENCE_PER_ENTITY) break;
  }
  return out;
}

/** 两条 evidence 是否识别为「同一条」（来自同会话 + 同批 messageIds）。 */
function evidenceKey(e: EvidenceRef): string {
  return `${e.sessionId}|${[...e.messageIds].sort().join(',')}`;
}

/** quote 归一化去重键：仅当 quote 存在且非空时返回 `${sessionId}|q:${stripped}`；否则返回 undefined。 */
function quoteKey(e: EvidenceRef): string | undefined {
  const raw = e.quote?.trim();
  if (!raw) return undefined;
  const normalized = raw.replace(/\s+/g, '').toLowerCase();
  if (!normalized) return undefined;
  return `${e.sessionId}|q:${normalized}`;
}

/** incoming 是否被 existing 完全覆盖（同一批消息已记过）。
 *  成立时调用方可跳过 reinforce，避免同事实被重复计权。
 *  双键判定：
 *   - 精确：incoming.evidenceKey ∈ existing.evidenceKey
 *   - 内容：存在同 sessionId+quote 的 existing 条目，且 messageIds 有交集
 *  incoming 为空时返回 false（保留原有「无 evidence 仍允许动作」语义）。
 */
export function isEvidenceFullyCovered(incoming: EvidenceRef[], existing: EvidenceRef[]): boolean {
  if (incoming.length === 0) return false;
  const evKeys = new Set(existing.map(evidenceKey));
  const byQuote = new Map<string, EvidenceRef[]>();
  for (const e of existing) {
    const qk = quoteKey(e);
    if (!qk) continue;
    const arr = byQuote.get(qk);
    if (arr) arr.push(e);
    else byQuote.set(qk, [e]);
  }
  return incoming.every(e => {
    if (evKeys.has(evidenceKey(e))) return true;
    const qk = quoteKey(e);
    if (!qk) return false;
    const peers = byQuote.get(qk);
    if (!peers) return false;
    const ids = new Set(e.messageIds);
    return peers.some(p => p.messageIds.some(id => ids.has(id)));
  });
}

/**
 * 归一化关系类型：把同义词收敛到推荐词表里的标准形式。
 * 未匹配的自创词保持原样（允许 LLM 自由扩展，但应用层尝试合并显然同义的）。
 */
const RELATION_SYNONYMS: Record<string, string> = {
  best_friend: 'friend',
  buddy: 'friend',
  bestie: 'friend',
  lovers: 'cp',
  couple: 'cp',
  partner: 'cp',
  enemy: 'antagonist',
  hater: 'antagonist',
  opponent: 'rival',
  competitor: 'rival',
  coworker: 'colleague',
  teammate: 'colleague',
  teacher: 'mentor',
  master: 'mentor',
  student: 'admirer', // 单向：student → mentor 反过来就是 admirer 也行；UI 上可视化区分由 directed 控制
  fan: 'admirer',
  acquaintance: 'familiar',
};

export function normalizeRelationType(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\s+/g, '_');
  return RELATION_SYNONYMS[trimmed] ?? trimmed;
}

/** 对称关系：双向无方向区别 */
const SYMMETRIC_RELATIONS = new Set<string>(['friend', 'cp', 'rival', 'colleague', 'familiar', 'antagonist']);

export function isSymmetricRelation(relationType: string): boolean {
  return SYMMETRIC_RELATIONS.has(relationType);
}

/** event-event 边的方向性默认：有向的常见关系 */
const DIRECTED_EVENT_EVENT_RELATIONS = new Set<string>(['caused-by', 'follows', 'part-of']);
export function isDirectedEventEventRelation(relationType: string): boolean {
  return DIRECTED_EVENT_EVENT_RELATIONS.has(relationType);
}

/** entity-entity 边的方向性默认：「part-of / contains / variant-of / is-alias-of」有向；「related / opposite」无向 */
const DIRECTED_ENTITY_ENTITY_RELATIONS = new Set<string>(['part-of', 'contains', 'variant-of', 'is-alias-of']);
export function isDirectedEntityEntityRelation(relationType: string): boolean {
  return DIRECTED_ENTITY_ENTITY_RELATIONS.has(relationType);
}

/** description 裁剪：去首尾空白、限长 40 字，空串返回 undefined */
export function trimDescription(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const t = d.trim();
  if (!t) return undefined;
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

// ============================================================
//  Alias merge helpers
// ============================================================

const ALIAS_MARKER_RELATIONS = new Set<string>(['is-alias-of', 'alt-account-of']);

export function isAliasMarkerEdge(e: RelationEdge): boolean {
  if (e.kind === 'entity-entity' || e.kind === 'person-person' || e.kind === 'event-event') {
    return ALIAS_MARKER_RELATIONS.has(e.relationType);
  }
  return false;
}

/** 判断边是否在任意字段引用了某 id（覆盖 6 种 edge kind） */
export function edgeReferences(e: RelationEdge, id: string): boolean {
  switch (e.kind) {
    case 'person-event':
      return e.fromPersonId === id || e.toEventId === id;
    case 'person-person':
      return e.fromPersonId === id || e.toPersonId === id;
    case 'person-entity':
      return e.fromPersonId === id || e.toEntityId === id;
    case 'event-event':
      return e.fromEventId === id || e.toEventId === id;
    case 'event-entity':
      return e.fromEventId === id || e.toEntityId === id;
    case 'entity-entity':
      return e.fromEntityId === id || e.toEntityId === id;
  }
}

export function edgeInvolvesBoth(e: RelationEdge, a: string, b: string): boolean {
  return edgeReferences(e, a) && edgeReferences(e, b);
}

export function isAliasEdgeDirectionCorrect(e: RelationEdge, aliasId: string, canonicalId: string): boolean {
  if (e.kind === 'entity-entity') return e.fromEntityId === aliasId && e.toEntityId === canonicalId;
  if (e.kind === 'person-person') return e.fromPersonId === aliasId && e.toPersonId === canonicalId;
  if (e.kind === 'event-event') return e.fromEventId === aliasId && e.toEventId === canonicalId;
  return true;
}

export function flipDirectedEdge(e: RelationEdge, aliasId: string, canonicalId: string): RelationEdge | null {
  if (e.kind === 'entity-entity') return { ...e, fromEntityId: aliasId, toEntityId: canonicalId };
  if (e.kind === 'person-person') return { ...e, fromPersonId: aliasId, toPersonId: canonicalId };
  if (e.kind === 'event-event') return { ...e, fromEventId: aliasId, toEventId: canonicalId };
  return null;
}

/** 把边中任一等于 aliasId 的字段替换为 canonicalId，返回浅拷贝 */
export function rewriteEdgeIds(e: RelationEdge, aliasId: string, canonicalId: string): RelationEdge {
  const swap = (v: string) => (v === aliasId ? canonicalId : v);
  switch (e.kind) {
    case 'person-event':
      return { ...e, fromPersonId: swap(e.fromPersonId), toEventId: swap(e.toEventId) };
    case 'person-person':
      return { ...e, fromPersonId: swap(e.fromPersonId), toPersonId: swap(e.toPersonId) };
    case 'person-entity':
      return { ...e, fromPersonId: swap(e.fromPersonId), toEntityId: swap(e.toEntityId) };
    case 'event-event':
      return { ...e, fromEventId: swap(e.fromEventId), toEventId: swap(e.toEventId) };
    case 'event-entity':
      return { ...e, fromEventId: swap(e.fromEventId), toEntityId: swap(e.toEntityId) };
    case 'entity-entity':
      return { ...e, fromEntityId: swap(e.fromEntityId), toEntityId: swap(e.toEntityId) };
  }
}

export function isEdgeSelfLoop(e: RelationEdge): boolean {
  switch (e.kind) {
    case 'person-event':
      return false; // 跨类型，不可能自环
    case 'person-person':
      return e.fromPersonId === e.toPersonId;
    case 'person-entity':
      return false;
    case 'event-event':
      return e.fromEventId === e.toEventId;
    case 'event-entity':
      return false;
    case 'entity-entity':
      return e.fromEntityId === e.toEntityId;
  }
}

/** 边的去重键（用于合并冲突检测）。无向边按字典序规范化端点。 */
export function edgeDedupKey(e: RelationEdge): string {
  switch (e.kind) {
    case 'person-event':
      return `pe|${e.fromPersonId}|${e.toEventId}|${e.role}`;
    case 'person-person': {
      const [a, b] = e.directed ? [e.fromPersonId, e.toPersonId] : [e.fromPersonId, e.toPersonId].sort();
      return `pp|${a}|${b}|${e.relationType}|${e.directed ? 'd' : 'u'}`;
    }
    case 'person-entity':
      return `pent|${e.fromPersonId}|${e.toEntityId}|${e.role}`;
    case 'event-event': {
      const [a, b] = e.directed ? [e.fromEventId, e.toEventId] : [e.fromEventId, e.toEventId].sort();
      return `ee|${a}|${b}|${e.relationType}|${e.directed ? 'd' : 'u'}`;
    }
    case 'event-entity':
      return `eent|${e.fromEventId}|${e.toEntityId}|${e.relationType}`;
    case 'entity-entity': {
      const [a, b] = e.directed ? [e.fromEntityId, e.toEntityId] : [e.fromEntityId, e.toEntityId].sort();
      return `entent|${a}|${b}|${e.relationType}|${e.directed ? 'd' : 'u'}`;
    }
  }
}

/** 合并两条同 dedupKey 的边：保留 keeper.id，合并 evidence、weight 取强化、时间取较新 */
export function mergeTwoEdges<T extends RelationEdge>(keeper: T, incoming: T): T {
  const allEvidence = trimEvidence([...keeper.evidence, ...incoming.evidence]);
  const weight = clamp01(reinforceWeight(keeper.weight ?? 0, incoming.weight ?? 0));
  const lastReinforcedAt = Math.max(keeper.lastReinforcedAt, incoming.lastReinforcedAt);
  const firstSeenAt = Math.min(keeper.firstSeenAt, incoming.firstSeenAt);
  const description = keeper.description ?? incoming.description;
  return { ...keeper, weight, lastReinforcedAt, firstSeenAt, description, evidence: allEvidence } as T;
}

/** 启发式：决定真正的 (alias, canonical) 方向。返回 null 表示无需翻转。 */
export function chooseCanonicalDirection(
  snapshot: RelationGraphSnapshot,
  aId: string,
  bId: string,
  kind: 'person' | 'entity' | 'event',
): { alias: string; canonical: string } | null {
  const score = (id: string): { name: number; aliases: number; evidence: number } => {
    let name = 0;
    let aliases = 0;
    let evidence = 0;
    if (kind === 'entity') {
      const node = snapshot.entities.find(n => n.id === id);
      name = node?.name.length ?? 0;
      aliases = node?.aliases?.length ?? 0;
    } else if (kind === 'event') {
      const node = snapshot.events.find(n => n.id === id);
      name = node?.title.length ?? 0;
    } else {
      const node = snapshot.persons.find(n => n.id === id);
      name = node?.displayName?.length ?? 0;
    }
    for (const e of snapshot.edges) {
      if (edgeReferences(e, id)) evidence += e.evidence.length;
    }
    return { name, aliases, evidence };
  };
  const sa = score(aId);
  const sb = score(bId);
  // a 得分越高 → a 更应是 canonical
  const cmp = sa.aliases - sb.aliases || sa.name - sb.name || sa.evidence - sb.evidence;
  // 当前调用方传入 alias=aId, canonical=bId；若 a 评分更高 → 翻转
  if (cmp > 0) return { alias: bId, canonical: aId };
  return null;
}

/**
 * 标准 PageRank（带个性化向量），用于淘汰打分。
 *
 * - 把所有节点（人/事件/实体）放进同一张图；边权重取 `edge.weight`（最低 0.05）。
 * - 无向边（is-alias-of 之外的 person-person/entity-entity directed=false）双向传播；
 *   directed=true 边只按 from→to 传播。
 * - 个性化向量按 kind 分配种子权重（默认 人=3 / 物=2 / 事=1），从而"重要性 人>物>事"
 *   不需要硬编码到打分，而是体现在 PR 的偏置上：人物附近的事件/实体 PR 更高。
 * - 迭代到 L1 误差 < epsilon 或达到 maxIter 终止。
 */
export function computePageRank(
  snap: RelationGraphSnapshot,
  opts: {
    damping: number;
    maxIter: number;
    epsilon: number;
    personSeed: number;
    entitySeed: number;
    eventSeed: number;
    /**
     * person→event / person→entity 单向边反向虚拟边的权重系数。
     * 0 = 不加反向边（无 person-person 边的人 PR 退化到 seed 常数）。
     * 默认 0.5：让“参与重要事件 / 关注热门实体”的人 PR 拉开差距，
     * 同时避免事件 hub 过度反哺导致 PR 被少数几个红人垄断。
     */
    reverseEdgeFactor?: number;
    /**
     * 是否启用 component-size 缩放（Component-weighted Personalized PageRank）：
     * PR_final[i] = PR_raw[i] * sqrt(componentSize[i] / n)，再重新归一化。
     * 默认 true。
     *
     * 动机：反向虚拟边 + 闭环让"1 人 1 物 1 事"这类孤立小子图（如三角）
     * 在 PR 上被相对高估——三个节点 mass 内循环、外面没有大节点稀释。
     * 在淘汰打分 / profile 注入排序场景里，这种小圈子不应被高估为重要节点。
     *
     * 缩放只改变 component 之间的相对权重，component 内部的 PR 比例完全保留。
     * 关闭则退化为标准 Personalized PageRank。
     */
    componentScale?: boolean;
  },
): Map<string, number> {
  const allIds: string[] = [];
  const kindOf = new Map<string, 'person' | 'event' | 'entity'>();
  for (const p of snap.persons) {
    allIds.push(p.id);
    kindOf.set(p.id, 'person');
  }
  for (const e of snap.events) {
    allIds.push(e.id);
    kindOf.set(e.id, 'event');
  }
  for (const en of snap.entities) {
    allIds.push(en.id);
    kindOf.set(en.id, 'entity');
  }
  const n = allIds.length;
  if (n === 0) return new Map();

  // 出向加权邻接 + 节点出度权和
  const outAdj = new Map<string, Array<{ to: string; w: number }>>();
  const outWeightSum = new Map<string, number>();
  const addOut = (from: string, to: string, w: number) => {
    if (!kindOf.has(from) || !kindOf.has(to) || from === to) return;
    if (!outAdj.has(from)) outAdj.set(from, []);
    outAdj.get(from)!.push({ to, w });
    outWeightSum.set(from, (outWeightSum.get(from) ?? 0) + w);
  };
  for (const e of snap.edges) {
    const w = Math.max(e.weight ?? 0.5, 0.05);
    let from = '';
    let to = '';
    let directed = true;
    switch (e.kind) {
      case 'person-event':
        from = e.fromPersonId;
        to = e.toEventId;
        directed = true;
        break;
      case 'person-entity':
        from = e.fromPersonId;
        to = e.toEntityId;
        directed = true;
        break;
      case 'person-person':
        from = e.fromPersonId;
        to = e.toPersonId;
        directed = e.directed;
        break;
      case 'event-event':
        from = e.fromEventId;
        to = e.toEventId;
        directed = e.directed;
        break;
      case 'event-entity':
        from = e.fromEventId;
        to = e.toEntityId;
        directed = e.directed;
        break;
      case 'entity-entity':
        from = e.fromEntityId;
        to = e.toEntityId;
        directed = e.directed;
        break;
    }
    addOut(from, to, w);
    if (!directed) {
      addOut(to, from, w);
    } else if (e.kind === 'person-event' || e.kind === 'person-entity') {
      // 反向虚拟边：让事件/实体的 PR 反哺参与者，避免人节点 PR 退化为种子常数。
      // reverseEdgeFactor=0 则不加反向边。
      const ref = opts.reverseEdgeFactor ?? 0.5;
      if (ref > 0) addOut(to, from, w * ref);
    }
  }

  // 个性化向量（归一化）
  const seedRaw = new Map<string, number>();
  let seedTotal = 0;
  for (const id of allIds) {
    const k = kindOf.get(id);
    const s = k === 'person' ? opts.personSeed : k === 'entity' ? opts.entitySeed : opts.eventSeed;
    seedRaw.set(id, s);
    seedTotal += s;
  }
  const seed = new Map<string, number>();
  for (const [id, v] of seedRaw) seed.set(id, v / Math.max(seedTotal, 1));

  // 初始化 PR = 个性化向量
  let pr = new Map<string, number>(seed);
  const d = opts.damping;
  for (let iter = 0; iter < opts.maxIter; iter++) {
    const next = new Map<string, number>();
    let danglingMass = 0;
    for (const id of allIds) {
      const w = outWeightSum.get(id);
      if (!w || w === 0) danglingMass += pr.get(id) ?? 0;
    }
    for (const id of allIds) {
      // teleport + dangling 均匀按 seed 分布
      next.set(id, (1 - d) * (seed.get(id) ?? 0) + d * danglingMass * (seed.get(id) ?? 0));
    }
    for (const [from, neighbors] of outAdj) {
      const ws = outWeightSum.get(from) ?? 1;
      const share = ((pr.get(from) ?? 0) * d) / ws;
      for (const { to, w } of neighbors) {
        next.set(to, (next.get(to) ?? 0) + share * w);
      }
    }
    // L1 收敛判断
    let delta = 0;
    for (const id of allIds) delta += Math.abs((next.get(id) ?? 0) - (pr.get(id) ?? 0));
    pr = next;
    if (delta < opts.epsilon) break;
  }

  // Component-weighted Personalized PageRank 后处理。
  // 在无向连通分量内 BFS 求 size，每个节点 PR *= sqrt(componentSize / n)，再归一化 sum=1。
  // 关闭则跳过（用于希望保留纯 PR 语义的场景或单元测试）。
  if ((opts.componentScale ?? true) !== false) {
    const undirAdj = buildUndirectedAdj(snap);
    const compSize = new Map<string, number>();
    const visited = new Set<string>();
    for (const start of allIds) {
      if (visited.has(start)) continue;
      const queue: string[] = [start];
      visited.add(start);
      const members: string[] = [];
      while (queue.length > 0) {
        const u = queue.shift() as string;
        members.push(u);
        const nbrs = undirAdj.get(u);
        if (!nbrs) continue;
        for (const v of nbrs.keys()) {
          if (!visited.has(v)) {
            visited.add(v);
            queue.push(v);
          }
        }
      }
      const size = members.length;
      for (const m of members) compSize.set(m, size);
    }
    let scaledSum = 0;
    const scaled = new Map<string, number>();
    for (const id of allIds) {
      const s = compSize.get(id) ?? 1;
      const v = (pr.get(id) ?? 0) * Math.sqrt(s / n);
      scaled.set(id, v);
      scaledSum += v;
    }
    if (scaledSum > 0) {
      for (const id of allIds) scaled.set(id, (scaled.get(id) ?? 0) / scaledSum);
      pr = scaled;
    }
  }

  return pr;
}

/**
 * Louvain 社群发现（无向加权图，单次 coarsening）。
 *
 * 适用场景：在 PageRank 算完后顺手把节点聚类成"小圈子"——
 * - 群里有几个核心团体
 * - 某人最常一起出现的是谁
 *
 * 实现要点：
 * - 把全图视为无向加权图：所有边权重双向叠加；有向边只在 from→to 方向加权一次，无向边两端各加一次。
 * - 阶段 1：局部移动——每个节点尝试加入邻居社群，按 modularity 增益 ΔQ 贪心选最大；扫一轮无改进即收敛。
 * - 阶段 2：coarsening——把社群当超节点，社群间边权聚合，再跑一轮局部移动（标准 Louvain 多轮，
 *   实测两轮已经稳定；我们的图 < 1000 节点，再多收益边际递减）。
 * - 返回 `nodeId → communityId` 映射，communityId 是字符串（c0/c1/...）。
 *
 * 复杂度：O(E · iter)，iter ≤ 10。对 360 节点几乎 instant。
 *
 * 不做：
 * - 不返回 modularity 值（调用方暂不需要）
 * - 不暴露 resolution 参数（默认 1.0 已足够；社群过多/过少时再加）
 */
/**
 * 把 RelationGraphSnapshot 收成无向加权邻接表（self-loop 跳过）。
 * Louvain / Leiden / modularity 共用此函数；directed 边只加一次但仍然双向贡献社群分配。
 */
type LouvainAdj = Map<string, Map<string, number>>;
function buildUndirectedAdj(snap: RelationGraphSnapshot): LouvainAdj {
  const adj: LouvainAdj = new Map();
  const ensure = (id: string) => {
    if (!adj.has(id)) adj.set(id, new Map());
  };
  for (const p of snap.persons) ensure(p.id);
  for (const e of snap.events) ensure(e.id);
  for (const en of snap.entities) ensure(en.id);
  const addUndirected = (a: string, b: string, w: number) => {
    if (a === b || !adj.has(a) || !adj.has(b)) return;
    const ma = adj.get(a)!;
    ma.set(b, (ma.get(b) ?? 0) + w);
    const mb = adj.get(b)!;
    mb.set(a, (mb.get(a) ?? 0) + w);
  };
  for (const e of snap.edges) {
    const w = Math.max(e.weight ?? 0.5, 0.05);
    let from = '';
    let to = '';
    switch (e.kind) {
      case 'person-event':
        from = e.fromPersonId;
        to = e.toEventId;
        break;
      case 'person-entity':
        from = e.fromPersonId;
        to = e.toEntityId;
        break;
      case 'person-person':
        from = e.fromPersonId;
        to = e.toPersonId;
        break;
      case 'event-event':
        from = e.fromEventId;
        to = e.toEventId;
        break;
      case 'event-entity':
        from = e.fromEventId;
        to = e.toEntityId;
        break;
      case 'entity-entity':
        from = e.fromEntityId;
        to = e.toEntityId;
        break;
    }
    addUndirected(from, to, w);
  }
  return adj;
}

/**
 * 计算 modularity Q ∈ [-0.5, 1)。Q > 0.3 通常认为社群结构清晰；Q < 0.1 几乎是随机划分。
 *
 * 公式：Q = (1/2m) Σ_ij [A_ij - k_i k_j / 2m] · δ(c_i, c_j)
 * 实现：按社群内边权和 Σ_in 和社群总度 Σ_tot 聚合，等价为
 *   Q = Σ_c [ Σ_in(c) / 2m  -  (Σ_tot(c) / 2m)^2 ]
 */
export function computeModularity(snap: RelationGraphSnapshot, communityMap: Map<string, string>): number {
  const adj = buildUndirectedAdj(snap);
  let twoM = 0;
  const ki = new Map<string, number>();
  for (const [id, nbrs] of adj) {
    let s = 0;
    for (const w of nbrs.values()) s += w;
    ki.set(id, s);
    twoM += s;
  }
  if (twoM === 0) return 0;
  const sigmaIn = new Map<string, number>();
  const sigmaTot = new Map<string, number>();
  for (const [u, nbrs] of adj) {
    const cu = communityMap.get(u);
    if (cu === undefined) continue;
    sigmaTot.set(cu, (sigmaTot.get(cu) ?? 0) + (ki.get(u) ?? 0));
    for (const [v, w] of nbrs) {
      if (communityMap.get(v) === cu) {
        // 内部边权重计入两次（u→v + v→u），公式系数已含 1/2m，无需修正
        sigmaIn.set(cu, (sigmaIn.get(cu) ?? 0) + w);
      }
    }
  }
  let q = 0;
  for (const c of sigmaTot.keys()) {
    const sin = sigmaIn.get(c) ?? 0;
    const stot = sigmaTot.get(c) ?? 0;
    q += sin / twoM - (stot / twoM) ** 2;
  }
  return q;
}

/**
 * 按图规模自适应推导 Louvain/Leiden 的分辨率 γ。
 *
 * 公式：γ = clamp(0.6, 2.5, 0.5 + log10(n / 30))，其中 n = snap.persons.length。
 * - n ≤ 30 → 0.6（地板，小图保持粗粒度，避免每人一个社群）
 * - n = 100 → ≈1.02（接近标准 Louvain）
 * - n = 150 → ≈1.20（解决我们当前 36 人巨型社群被过度合并的问题）
 * - n = 500 → ≈1.72
 * - n ≥ 750 → 2.5（天花板，避免极细碎导致 c0~c100 难以消费）
 *
 * 背景：标准 Louvain（γ=1）存在 "resolution limit"（Fortunato & Barthélemy 2007）——
 * 节点数越多越倾向于把小社群合并成超级社群。让 γ 随 n 单调微增是文献推荐做法。
 *
 * 不依赖边数 / 平均度：实现简单、可解释，对当前 < 1000 节点的图足够；如果后续图规模或密度
 * 差异显著（比如某 scope 节点很少但边很密），再升级到 sqrt(2m/(n·d_target)) 的密度感知公式。
 *
 * persons 为空 → 返回 1.0（标准默认，安全兜底）。
 */
export function computeAdaptiveResolution(snap: RelationGraphSnapshot): number {
  const n = snap.persons?.length ?? 0;
  if (n <= 0) return 1.0;
  const raw = 0.5 + Math.log10(n / 30);
  return Math.max(0.6, Math.min(2.5, raw));
}

/**
 * Louvain 社群发现（无向加权图，单次 coarsening）。
 *
 * 适用场景：在 PageRank 算完后顺手把节点聚类成"小圈子"——
 * - 群里有几个核心团体
 * - 某人最常一起出现的是谁
 *
 * 实现要点：
 * - 把全图视为无向加权图：所有边权重双向叠加；有向边只在 from→to 方向加权一次，无向边两端各加一次。
 * - 阶段 1：局部移动——每个节点尝试加入邻居社群，按 modularity 增益 ΔQ 贪心选最大；扫一轮无改进即收敛。
 * - 阶段 2：coarsening——把社群当超节点，社群间边权聚合，再跑一轮局部移动（标准 Louvain 多轮，
 *   实测两轮已经稳定；我们的图 < 1000 节点，再多收益边际递减）。
 * - 返回 `nodeId → communityId` 映射，communityId 是字符串（c0/c1/...）。
 *
 * 复杂度：O(E · iter)，iter ≤ 10。对 360 节点几乎 instant。
 *
 * 不做：
 * - 不返回 modularity 值（请用独立的 computeModularity）
 * - resolution（γ）参数：默认 1.0（标准 Louvain）；> 1 → 划得更细更多社群；< 1 → 划得更粗更少社群。
 *   实现：把 ΔQ 公式里的 `kii * sigmaTot(C) / 2m` 项乘以 γ（标准做法，对应 RB 多分辨率模块度）。
 *   常用范围：0.5 ~ 3.0。极端值（< 0.1 / > 10）会导致全图一个社群 / 每节点自成社群。
 */
export function computeLouvain(
  snap: RelationGraphSnapshot,
  opts?: { maxIterPerPass?: number; minImprovement?: number; resolution?: number },
): Map<string, string> {
  const maxIter = opts?.maxIterPerPass ?? 10;
  const minImp = opts?.minImprovement ?? 1e-6;
  // resolution：clamp 到合理范围避免数值溢出 / 全图坍缩；超出仍允许但提示
  const gamma = (() => {
    const raw = opts?.resolution ?? 1.0;
    if (!Number.isFinite(raw) || raw <= 0) return 1.0;
    return Math.max(0.01, Math.min(raw, 100));
  })();

  const adj = buildUndirectedAdj(snap);
  type AdjList = LouvainAdj;

  const allIds = Array.from(adj.keys());
  if (allIds.length === 0) return new Map();

  /** 对当前图（adj + 节点 ki = 邻居权之和）跑一轮局部移动，返回 nodeId→communityIdx */
  const runLocalMove = (graph: AdjList): Map<string, number> => {
    const ids = Array.from(graph.keys());
    if (ids.length === 0) return new Map();
    const ki = new Map<string, number>();
    let twoM = 0;
    for (const id of ids) {
      let s = 0;
      for (const w of graph.get(id)!.values()) s += w;
      ki.set(id, s);
      twoM += s;
    }
    if (twoM === 0) {
      // 所有节点都孤立，每个自成一社群
      const m = new Map<string, number>();
      for (let i = 0; i < ids.length; i++) m.set(ids[i], i);
      return m;
    }
    // 初始：每个节点自成一社群
    const node2com = new Map<string, number>();
    const comTotalK = new Map<number, number>(); // 社群总度数 Σ_tot
    for (let i = 0; i < ids.length; i++) {
      node2com.set(ids[i], i);
      comTotalK.set(i, ki.get(ids[i]) ?? 0);
    }

    for (let iter = 0; iter < maxIter; iter++) {
      let improved = 0;
      // 随机顺序更鲁棒，但为可复现先按字典序
      for (const i of ids) {
        const ci = node2com.get(i)!;
        const kii = ki.get(i) ?? 0;
        // 邻居社群权 Σ_in
        const neighborWeightToCom = new Map<number, number>();
        for (const [j, w] of graph.get(i)!) {
          const cj = node2com.get(j)!;
          neighborWeightToCom.set(cj, (neighborWeightToCom.get(cj) ?? 0) + w);
        }
        // 把 i 移出 ci
        const wToCi = neighborWeightToCom.get(ci) ?? 0;
        comTotalK.set(ci, (comTotalK.get(ci) ?? 0) - kii);
        // 计算移入每个候选社群的 ΔQ：2*(wToC - γ * ki * sigma_tot(C) / 2m)
        // 等价比较：argmax_c { wToC - γ * ki * sigma_tot(C) / 2m }
        // γ > 1：放大对 sigma_tot 大社群的惩罚 → 倾向多个小社群
        // γ < 1：缩小惩罚 → 倾向少数大社群
        let bestCom = ci;
        let bestGain = wToCi - (gamma * (kii * (comTotalK.get(ci) ?? 0))) / twoM;
        for (const [c, wToC] of neighborWeightToCom) {
          if (c === ci) continue;
          const gain = wToC - (gamma * (kii * (comTotalK.get(c) ?? 0))) / twoM;
          if (gain > bestGain + minImp) {
            bestGain = gain;
            bestCom = c;
          }
        }
        // 把 i 加入 bestCom
        comTotalK.set(bestCom, (comTotalK.get(bestCom) ?? 0) + kii);
        if (bestCom !== ci) {
          node2com.set(i, bestCom);
          improved++;
        }
      }
      if (improved === 0) break;
    }
    return node2com;
  };

  // 阶段 1：原图局部移动
  const firstPass = runLocalMove(adj);

  // 阶段 2：用 firstPass 的社群作为超节点，构造新图再跑一轮
  const superAdj: AdjList = new Map();
  for (const id of allIds) {
    const c = firstPass.get(id)!;
    const key = `c${c}`;
    if (!superAdj.has(key)) superAdj.set(key, new Map());
  }
  for (const [u, neighbors] of adj) {
    const cu = `c${firstPass.get(u)!}`;
    for (const [v, w] of neighbors) {
      const cv = `c${firstPass.get(v)!}`;
      if (cu === cv) continue; // 社群内部边在 modularity 公式里已通过 ki 反映，不必显式加（其实标准实现要保留，但我们只用 superAdj 做第二轮聚类，self-loop 无影响）
      const m = superAdj.get(cu)!;
      m.set(cv, (m.get(cv) ?? 0) + w);
    }
  }
  const secondPass = runLocalMove(superAdj);

  // 合成最终 nodeId → 最终社群字符串
  const result = new Map<string, string>();
  // 把 secondPass 的 community idx 规范化为连续 c0..cN（避免暴露原始 idx）
  const finalRemap = new Map<number, string>();
  let counter = 0;
  for (const id of allIds) {
    const inter = `c${firstPass.get(id)!}`;
    const finalIdx = secondPass.get(inter);
    if (finalIdx === undefined) {
      // 不应发生：兜底自成一社群
      result.set(id, `c${counter++}`);
      continue;
    }
    if (!finalRemap.has(finalIdx)) finalRemap.set(finalIdx, `c${counter++}`);
    result.set(id, finalRemap.get(finalIdx)!);
  }
  return result;
}

/**
 * Leiden 社群发现（实用简化版：Louvain local-move + connectivity-based refinement）。
 *
 * ⚠️ **不是论文版完整 Leiden**：论文版 Leiden（Traag et al. 2019）含三阶段——
 *   1. local move（同 Louvain）
 *   2. refinement：在每个社群内部跑 modularity-weighted singleton subset move（随机走子集）
 *   3. aggregation 时只压缩 refinement 后的子集
 * 论文版能保证「γ-separation」+「γ-connection」严格性质，但实现 ~300 行。
 *
 * **本实现简化为**：
 *   1. local move（同 Louvain）
 *   2. refinement：对每个 Louvain 社群做 BFS 连通分量检测，把内部不连通的社群拆成多个子社群
 *   3. （省略 aggregation 第二轮，直接返回 refined 结果）
 *
 * **解决了 Louvain 最大的诟病**——社群内部可能不连通（"badly connected communities"）。
 * 在我们这种密度较高、规模 < 1000 的关系图上，质量提升足够明显，又不需要论文版的复杂度。
 *
 * Agent 视角：当怀疑 Louvain 把两群明显没交集的人分到同一社群时，换 leiden 跑一次能看到更细的划分。
 */
export function computeLeiden(
  snap: RelationGraphSnapshot,
  opts?: { maxIterPerPass?: number; minImprovement?: number; resolution?: number },
): Map<string, string> {
  // Step 1: 先跑 Louvain
  const louvain = computeLouvain(snap, opts);
  if (louvain.size === 0) return louvain;

  // Step 2: 按 Louvain 社群分组，组内做 BFS 连通分量
  const adj = buildUndirectedAdj(snap);
  const groups = new Map<string, string[]>();
  for (const [id, c] of louvain) {
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(id);
  }

  const result = new Map<string, string>();
  let nextIdx = 0;
  for (const [, members] of groups) {
    const inGroup = new Set(members);
    const visited = new Set<string>();
    // 对该社群内的节点做多次 BFS，每次拿到一个连通分量
    for (const seed of members) {
      if (visited.has(seed)) continue;
      const stack = [seed];
      visited.add(seed);
      const componentId = `c${nextIdx++}`;
      while (stack.length > 0) {
        const u = stack.pop()!;
        result.set(u, componentId);
        const nbrs = adj.get(u);
        if (!nbrs) continue;
        for (const v of nbrs.keys()) {
          // 只在同一 Louvain 社群内部走
          if (!inGroup.has(v) || visited.has(v)) continue;
          visited.add(v);
          stack.push(v);
        }
      }
    }
  }
  return result;
}

/**
 * SLPA — Speaker-Listener Label Propagation Algorithm（原生重叠社区发现）。
 *
 * 论文：Xie, Szymanski, Liu (2011) "SLPA: Uncovering Overlapping Communities in
 * Social Networks via a Speaker-Listener Interaction Dynamic Process"。
 *
 * **与 Louvain/Leiden 的关键差别**：Louvain 是硬划分（每个节点恰好属于一个社群），
 * SLPA 是软划分（节点可同时属于多个社群，按隶属度排序）。适合社交图里"残龙在全性基地+Aalis 周边
 * 都活跃"这种跨群人物——硬划分会丢失次社群信息，SLPA 直接给出 `{c2: 0.62, c4: 0.31, c1: 0.07}`。
 *
 * 算法骨架（论文原版，未做加权扩展时）：
 *   1. 每个节点初始化一个 label memory：`{自身id: 1}`
 *   2. 共 T 轮迭代；每轮按节点顺序：
 *        a. 选当前节点为 listener
 *        b. 它的每个邻居都作为 speaker，按 speaker 自己 memory 中的频率分布**随机抽**一个 label 吐出
 *        c. listener 收齐所有邻居吐的 label，按"票数最高"挑一个加进自己 memory（计数 +1）
 *   3. 后处理：每个节点 memory 中频率 ≥ r·(T+1) 的 label 才保留为它的社群隶属；
 *      然后按"出现次数"归一化为权重 ∈ (0, 1]，按 weight 降序排列。
 *
 * **本实现的加权扩展**（默认开启，`weightedSpeaker=true`）：
 * - speaker 抽样时：按邻居边权 `w` 对其 memory 频率加权（边越重的邻居"声音越大"）
 * - listener 计票时：每张票按边权计数（不是 +1 而是 +w），同样让重边邻居有更高影响力
 * - 这与本仓库带权图（edge.weight ∈ [0.05, 1.0]）天然契合；纯无权图退化为论文原版
 *
 * **复杂度**：O(N · avgDeg · T)。对 400 节点 + T=20 几乎 instant；< 1000 节点都可放心用。
 *
 * **确定性**：内置 mulberry32 伪随机种子（由 node id 串字典序导出），跨进程同一 snapshot 输出
 * 完全可复现；避免 Math.random 让 evictByQuota 每次结果都漂移。
 *
 * **不做**：
 * - 不做社群间合并 / 拆分（论文里的 post-merge 步骤）；阈值 r 已能调粒度
 * - 不返回 modularity（重叠社区的 modularity 没有标准定义；想看质量看 `bridges` 跨社群占比）
 *
 * @returns nodeId → CommunityMembership[]（按 weight 降序）；空图返回空 Map
 */
export function computeSlpa(
  snap: RelationGraphSnapshot,
  opts?: {
    /** 迭代轮数 T，默认 20。论文实测 20 已对 < 1000 节点稳定收敛；增大无明显收益。 */
    iterations?: number;
    /** 频率阈值 r ∈ [0, 0.5]，默认 0.1。频率 < r·(T+1) 的 label 会被剔除（噪声过滤）；r 越大社群越纯，重叠越少。 */
    threshold?: number;
    /** 是否启用加权 speaker 抽样 + 加权 listener 计票，默认 true。带权图建议开。 */
    weightedSpeaker?: boolean;
  },
): Map<string, CommunityMembership[]> {
  const T = Math.max(5, Math.floor(opts?.iterations ?? 20));
  const r = Math.max(0, Math.min(opts?.threshold ?? 0.1, 0.5));
  const weighted = opts?.weightedSpeaker ?? true;

  const adj = buildUndirectedAdj(snap);
  const ids = Array.from(adj.keys());
  if (ids.length === 0) return new Map();

  // label memory：每个节点 → (labelId → 累计出现次数)
  const memory = new Map<string, Map<string, number>>();
  for (const id of ids) memory.set(id, new Map([[id, 1]]));

  // 确定性 PRNG：mulberry32，种子由所有 node id 串聚合而成，保证同一 snapshot 输出一致
  let seed = 0x9e3779b9;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) seed = (Math.imul(seed, 31) + id.charCodeAt(i)) >>> 0;
  }
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** speaker 按 memory 频率分布抽一个 label；weight 是 listener 到 speaker 的边权（用于加权扩展） */
  const speakerSample = (mem: Map<string, number>, _w: number): string => {
    // 频率分布抽样：边权不影响抽样概率（speaker 的"个人意志"），只影响 listener 计票
    let total = 0;
    for (const c of mem.values()) total += c;
    if (total <= 0) {
      // 兜底：返回第一个 key
      const it = mem.keys().next();
      return it.done ? '' : it.value;
    }
    let pick = rand() * total;
    for (const [label, c] of mem) {
      pick -= c;
      if (pick <= 0) return label;
    }
    // 浮点误差兜底：返回最后一个 key
    let last = '';
    for (const k of mem.keys()) last = k;
    return last;
  };

  // T 轮 listener-speaker 交互
  for (let iter = 0; iter < T; iter++) {
    for (const listener of ids) {
      const neighbors = adj.get(listener)!;
      if (neighbors.size === 0) continue;
      const votes = new Map<string, number>();
      for (const [speaker, w] of neighbors) {
        const speakerMem = memory.get(speaker)!;
        const label = speakerSample(speakerMem, w);
        if (label === '') continue;
        // 加权计票：边重的邻居票更重
        votes.set(label, (votes.get(label) ?? 0) + (weighted ? w : 1));
      }
      // 选票数最高的 label，加进 listener.memory（票数并列时取字典序最小的 label，稳定可复现）
      let bestLabel = '';
      let bestVote = -1;
      for (const [label, v] of votes) {
        if (v > bestVote || (v === bestVote && label < bestLabel)) {
          bestVote = v;
          bestLabel = label;
        }
      }
      if (bestLabel !== '') {
        const mem = memory.get(listener)!;
        mem.set(bestLabel, (mem.get(bestLabel) ?? 0) + 1);
      }
    }
  }

  // 后处理：阈值过滤 + 归一化 + raw label → c0/c1/... 重命名
  // raw label 是 node id，对外暴露会泄漏 id 细节且不像社群名；统一映射为 c{idx}
  const minCount = r * (T + 1);
  const pending = new Map<string, Array<{ rawLabel: string; freq: number }>>();
  for (const id of ids) {
    const mem = memory.get(id)!;
    const keep: Array<{ rawLabel: string; freq: number }> = [];
    for (const [label, c] of mem) {
      if (c >= minCount) keep.push({ rawLabel: label, freq: c });
    }
    // 兜底：阈值过严导致全部被剔除时，至少保留频率最高的一个 label
    if (keep.length === 0) {
      let bestLabel = id;
      let bestC = 0;
      for (const [label, c] of mem) {
        if (c > bestC) {
          bestC = c;
          bestLabel = label;
        }
      }
      keep.push({ rawLabel: bestLabel, freq: Math.max(bestC, 1) });
    }
    // 归一化到 weight ∈ (0, 1] 且 Σweight = 1
    let sum = 0;
    for (const k of keep) sum += k.freq;
    if (sum > 0) for (const k of keep) k.freq = k.freq / sum;
    keep.sort((a, b) => b.freq - a.freq || a.rawLabel.localeCompare(b.rawLabel));
    pending.set(id, keep);
  }

  // raw label → c{idx} 命名：按 node id 字典序首次出现顺序分配，保证稳定
  const labelRemap = new Map<string, string>();
  let counter = 0;
  const sortedIds = [...ids].sort();
  for (const id of sortedIds) {
    for (const m of pending.get(id)!) {
      if (!labelRemap.has(m.rawLabel)) labelRemap.set(m.rawLabel, `c${counter++}`);
    }
  }

  const result = new Map<string, CommunityMembership[]>();
  for (const id of ids) {
    result.set(
      id,
      pending.get(id)!.map(m => ({ id: labelRemap.get(m.rawLabel)!, weight: m.freq })),
    );
  }
  return result;
}

// ─── 别名簇并查集 + canonical 挑选（consolidate 宽召回 P1 范式） ───

/**
 * 把若干个"语义同一对象"的 pair 按并查集合并成簇。
 *
 * 输入：LLM 已判 yes 的 pair 列表（{aId, bId}）。
 * 输出：`Map<rootId, Set<memberId>>`；同一 root 下所有 id 在同一簇。
 *
 * 自然解决传递闭包：A↔B yes & B↔C yes ⇒ {A,B,C} 一簇。
 * size<2 的簇（孤立 id）也会出现（如果某 id 只出现在自身），调用方按需过滤。
 *
 * 实现：路径压缩 + 按 rank 启发式合并，O(α(n)) 近似常数。
 */
export function clusterEntitiesByPairs(
  yesPairs: ReadonlyArray<{ aId: string; bId: string }>,
): Map<string, Set<string>> {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  const find = (x: string): string => {
    let cur = x;
    while ((parent.get(cur) ?? cur) !== cur) cur = parent.get(cur)!;
    // 路径压缩
    let p = x;
    while ((parent.get(p) ?? p) !== cur) {
      const next = parent.get(p) ?? p;
      parent.set(p, cur);
      p = next;
    }
    return cur;
  };
  const union = (x: string, y: string) => {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    const ra = rank.get(rx) ?? 0;
    const rb = rank.get(ry) ?? 0;
    if (ra < rb) parent.set(rx, ry);
    else if (ra > rb) parent.set(ry, rx);
    else {
      parent.set(ry, rx);
      rank.set(rx, ra + 1);
    }
  };
  for (const p of yesPairs) {
    if (!parent.has(p.aId)) parent.set(p.aId, p.aId);
    if (!parent.has(p.bId)) parent.set(p.bId, p.bId);
    union(p.aId, p.bId);
  }
  const clusters = new Map<string, Set<string>>();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!clusters.has(r)) clusters.set(r, new Set());
    clusters.get(r)!.add(id);
  }
  return clusters;
}

/**
 * 在一个簇内挑选 canonical（合并后保留的代表）。
 *
 * 打分公式（"合并专用"，**不复用 compositeScore**，因为后者含 recency 偏向新节点）：
 *   `mergeScore = 0.5·weightSum + 0.3·edgeCount + 0.2·evidenceCount`，
 *   三项各自按"簇内 max"归一化到 [0,1]。
 *
 * 语义：信息越丰富（关系密、权值高、evidence 多）越当代表。
 * 平局规则：分数并列时取 id 字典序最小者（稳定可复现）。
 *
 * @param members 簇内成员 id 集合
 * @param entityById 实体 id → EntityNode 映射（用于查 evidence 数量）
 * @param edgeStats 实体 id → {weightSum, edgeCount}（由调用方一次扫边表得到）
 * @returns canonical 的 id；簇为空时返回 ''（调用方应过滤 size<2 簇，不应触发）
 */
export function pickCanonicalByMergeScore(
  members: ReadonlySet<string>,
  entityById: ReadonlyMap<string, EntityNode>,
  edgeStats: ReadonlyMap<string, { weightSum: number; edgeCount: number }>,
): string {
  if (members.size === 0) return '';
  // 簇内 max 归一化基准
  let maxW = 0;
  let maxE = 0;
  let maxEv = 0;
  for (const id of members) {
    const stat = edgeStats.get(id) ?? { weightSum: 0, edgeCount: 0 };
    const node = entityById.get(id);
    const evCount = node?.evidence?.length ?? 0;
    if (stat.weightSum > maxW) maxW = stat.weightSum;
    if (stat.edgeCount > maxE) maxE = stat.edgeCount;
    if (evCount > maxEv) maxEv = evCount;
  }
  let canonicalId = '';
  let bestScore = -Infinity;
  for (const id of members) {
    const stat = edgeStats.get(id) ?? { weightSum: 0, edgeCount: 0 };
    const node = entityById.get(id);
    const evCount = node?.evidence?.length ?? 0;
    const wN = maxW > 0 ? stat.weightSum / maxW : 0;
    const eN = maxE > 0 ? stat.edgeCount / maxE : 0;
    const vN = maxEv > 0 ? evCount / maxEv : 0;
    const score = wN * 0.5 + eN * 0.3 + vN * 0.2;
    if (score > bestScore || (score === bestScore && (canonicalId === '' || id < canonicalId))) {
      bestScore = score;
      canonicalId = id;
    }
  }
  return canonicalId;
}

/**
 * 一次扫边表，为每个 entity 节点聚合 weightSum + edgeCount，供 pickCanonicalByMergeScore 使用。
 *
 * 统计范围：所有涉及 entity 的边（entity-entity 两端均计入；person-entity / event-entity 的 entity 端计入）。
 * Person/event 节点不需要聚合（不会作为合并 canonical 候选）。
 */
export function computeEntityEdgeStats(
  edges: ReadonlyArray<RelationEdge>,
): Map<string, { weightSum: number; edgeCount: number }> {
  const stats = new Map<string, { weightSum: number; edgeCount: number }>();
  const bump = (id: string, w: number) => {
    const cur = stats.get(id) ?? { weightSum: 0, edgeCount: 0 };
    cur.weightSum += w;
    cur.edgeCount += 1;
    stats.set(id, cur);
  };
  for (const e of edges) {
    const w = typeof e.weight === 'number' ? e.weight : 0;
    if (e.kind === 'entity-entity') {
      bump(e.fromEntityId, w);
      bump(e.toEntityId, w);
    } else if (e.kind === 'person-entity') {
      bump(e.toEntityId, w);
    } else if (e.kind === 'event-entity') {
      bump(e.toEntityId, w);
    }
  }
  return stats;
}

/**
 * 余弦相似度。两个向量长度必须一致，返回 [-1, 1]；任一为 0 向量返回 0。
 * consolidate event 阶段用于 embedding-based 文本相似度。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 字符级 Jaccard：以 Unicode 字符（非字节）建集合，返回 |A∩B| / |A∪B|。
 * 用于无 embedding 服务时的 fallback 文本相似度（对中文友好，比 token 化更稳）。
 * 自动 normalizeName（去空白/小写/全半角合并），空串返回 0。
 */
export function jaccardChars(a: string, b: string): number {
  const sa = normalizeName(a || '');
  const sb = normalizeName(b || '');
  if (!sa || !sb) return 0;
  const setA = new Set(Array.from(sa));
  const setB = new Set(Array.from(sb));
  let inter = 0;
  for (const c of setA) if (setB.has(c)) inter++;
  const uni = setA.size + setB.size - inter;
  if (uni === 0) return 0;
  return inter / uni;
}

/**
 * 计算 EventNode embedding 的指纹（title + summary 的 sha1 前 16 hex）。
 * 当节点的 title/summary 发生变化时，hash 自动变 → consolidate 阶段触发重新 embed。
 * 使用 fnv1a + djb2 组合的 64bit 简化版（避免在浏览器/node 都依赖 crypto）。
 */
export function computeEventEmbeddingHash(title: string, summary?: string): string {
  const input = `${(title || '').trim()}\n${(summary || '').trim()}`;
  // fnv1a-64
  let h1 = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    h1 ^= BigInt(input.charCodeAt(i));
    h1 = (h1 * prime) & 0xffffffffffffffffn;
  }
  // djb2-mix as second half for collision robustness
  let h2 = 5381n;
  for (let i = 0; i < input.length; i++) {
    h2 = ((h2 << 5n) + h2 + BigInt(input.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0');
}

/**
 * 计算 EntityNode embedding 的指纹（entityKind + name + summary 的 fnv1a+djb2 32 hex）。
 * 当 entityKind / name / summary 任一变化时，hash 自动变 → consolidate 阶段触发重新 embed。
 * entityKind 加入 hash 是有意为之：同名跨 kind 视为不同实体，各自独立 embed。
 */
export function computeEntityEmbeddingHash(name: string, summary?: string, entityKind?: string): string {
  const input = `${entityKind ?? ''}\n${(name || '').trim()}\n${(summary || '').trim()}`;
  let h1 = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    h1 ^= BigInt(input.charCodeAt(i));
    h1 = (h1 * prime) & 0xffffffffffffffffn;
  }
  let h2 = 5381n;
  for (let i = 0; i < input.length; i++) {
    h2 = ((h2 << 5n) + h2 + BigInt(input.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0');
}

/**
 * 一次扫边表，为每个 event 节点聚合 weightSum + edgeCount，供 pickCanonicalForEvents 使用。
 * 统计范围：所有涉及 event 的边（event-event 两端均计入；person-event / event-entity 的 event 端计入）。
 */
export function computeEventEdgeStats(
  edges: ReadonlyArray<RelationEdge>,
): Map<string, { weightSum: number; edgeCount: number }> {
  const stats = new Map<string, { weightSum: number; edgeCount: number }>();
  const bump = (id: string, w: number) => {
    const cur = stats.get(id) ?? { weightSum: 0, edgeCount: 0 };
    cur.weightSum += w;
    cur.edgeCount += 1;
    stats.set(id, cur);
  };
  for (const e of edges) {
    const w = typeof e.weight === 'number' ? e.weight : 0;
    if (e.kind === 'event-event') {
      bump(e.fromEventId, w);
      bump(e.toEventId, w);
    } else if (e.kind === 'person-event') {
      bump(e.toEventId, w);
    } else if (e.kind === 'event-entity') {
      bump(e.fromEventId, w);
    }
  }
  return stats;
}

/**
 * 在一个 event 簇内挑选 canonical（合并后保留的代表）。
 * 算法与 pickCanonicalByMergeScore 一致：mergeScore = 0.5·weightSum + 0.3·edgeCount + 0.2·evidenceCount。
 * 平局取 id 字典序最小者。
 */
export function pickCanonicalForEvents(
  members: ReadonlySet<string>,
  eventById: ReadonlyMap<string, EventNode>,
  edgeStats: ReadonlyMap<string, { weightSum: number; edgeCount: number }>,
): string {
  if (members.size === 0) return '';
  let maxW = 0;
  let maxE = 0;
  let maxEv = 0;
  for (const id of members) {
    const stat = edgeStats.get(id) ?? { weightSum: 0, edgeCount: 0 };
    const node = eventById.get(id);
    const evCount = node?.evidence?.length ?? 0;
    if (stat.weightSum > maxW) maxW = stat.weightSum;
    if (stat.edgeCount > maxE) maxE = stat.edgeCount;
    if (evCount > maxEv) maxEv = evCount;
  }
  let canonicalId = '';
  let bestScore = -Infinity;
  for (const id of members) {
    const stat = edgeStats.get(id) ?? { weightSum: 0, edgeCount: 0 };
    const node = eventById.get(id);
    const evCount = node?.evidence?.length ?? 0;
    const wN = maxW > 0 ? stat.weightSum / maxW : 0;
    const eN = maxE > 0 ? stat.edgeCount / maxE : 0;
    const vN = maxEv > 0 ? evCount / maxEv : 0;
    const score = wN * 0.5 + eN * 0.3 + vN * 0.2;
    if (score > bestScore || (score === bestScore && (canonicalId === '' || id < canonicalId))) {
      bestScore = score;
      canonicalId = id;
    }
  }
  return canonicalId;
}
