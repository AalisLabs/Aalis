/**
 * 人物关系图数据模型 —— 事件图 (Event-centric) 形态。
 *
 * 设计要点：
 * - 单层 global 视图（跨平台 / 跨群聚合）；按"来源"在 evidence 里记录细粒度溯源，
 *   不再做 group/platform 物理隔离，避免 UI 切层与多份冗余更新带来的混淆。
 * - Person 复用 plugin-user-profile 的 `platform:userId` 作为稳定身份。
 * - Event 是一阶节点：群里被讨论的事件、作品、行为、事故、合作等都作为节点，
 *   人通过 person-event 边参与其中。person-person 直连边只承载长期身份性关系
 *   （CP / 友 / 对手 / 师徒等），不承载临时事件参与。
 * - 所有边都带 evidence[]：sourceQuote + messageIds，用于 webui 溯源与未来审计。
 */

/** 通用：可溯源的证据条目 */
export interface EvidenceRef {
  /** 来源会话 ID */
  sessionId: string;
  /** 来源群组 ID（私聊为空） */
  sourceGroupId?: string;
  /** 引用的原平台消息 ID 列表 */
  messageIds: string[];
  /** 关键原文片段（截断后保存，便于无需回查原会话即可解释） */
  quote?: string;
  /** 提取时间戳（毫秒） */
  extractedAt: number;
}

/** 人物节点 —— 与 plugin-user-profile 的身份体系对齐 */
export interface PersonNode {
  /** 复合 ID：`${platform}:${userId}` */
  id: string;
  platform: string;
  userId: string;
  /** 显示名（昵称），可由 user-profile 同步更新 */
  displayName?: string;
  /** 节点首次出现时间 */
  firstSeenAt: number;
  /** 最近一次被强化（提到 / 参与事件）时间 */
  lastSeenAt: number;
  /** 最近一次在对话中被提及的时间（含本人发言）。用于「最近发烫」排序 */
  lastMentionedAt?: number;
  /** 总共被提及次数（每次 extractor 命中该节点 +1） */
  mentionCount?: number;
  /**
   * 最近一次 evictByQuota 计算出的全图 PageRank 分数。
   * 个性化向量按 kind 偏置（人>物>事），反映该节点在关系网中的结构性重要性。
   * 由 `evictByQuota` 写入，供 WebUI 展示"图重要性"。**未跑过淘汰的实例可能为 undefined**。
   */
  lastPageRank?: number;
  /** lastPageRank 的写入时间戳 */
  lastPageRankAt?: number;
}

/** 事件类别（粗分类，仅供 UI 上色与过滤） */
export type EventCategory =
  | 'discussion' // 群内讨论某话题 / 作品 / 观点
  | 'conflict' // 冲突 / 争执 / 对线
  | 'collaboration' // 合作 / 共同行动
  | 'incident' // 突发事件 / 事故
  | 'milestone' // 里程碑 / 成就
  | 'other';

/** 事件节点（时间性事件：发生过一次的事） */
export interface EventNode {
  /** UUID */
  id: string;
  /** 事件简称（LLM 提取生成，限长，便于图上显示） */
  title: string;
  /** 别名 / 历史 title，rename 时原 title 自动落到此处供检索 */
  aliases?: string[];
  /** 一两句话的事件摘要 */
  summary?: string;
  category?: EventCategory;
  firstSeenAt: number;
  lastReinforcedAt: number;
  /** 提取该事件的证据列表 */
  evidence: EvidenceRef[];
  /**
   * 多次发生 / 重复提及时累计的发生时间戳列表（首次创建时为 [firstSeenAt]）。
   * 严格按 title 去重后，每次合并会追加一个时间戳，保留时间维度。
   */
  occurrences?: number[];
  /**
   * 节点合并强度 0~1。每次按 title 合并时 += 0.3（clamp 到 1.0），用于淘汰排序。
   * 老节点未设置则视为 0.5。**语义 = 被强化次数累计，不是"重要性"**；
   * 真正的结构性重要性看 `lastPageRank`。
   */
  weight?: number;
  /** 最近一次在对话窗口中被提及的时间 */
  lastMentionedAt?: number;
  /** 总共被提及次数 */
  mentionCount?: number;
  /** rename 审计：每次改名追加一条 */
  nameHistory?: NodeNameAudit[];
  /** 最近一次 evictByQuota 计算出的 PageRank 分数（结构性重要性）。 */
  lastPageRank?: number;
  lastPageRankAt?: number;
}

/**
 * 实体节点（持续存在的"东西"：作品 / 游戏 / 兴趣 / 地点 / 物品 / 话题）。
 *
 * **与 EventNode 的区别**：
 * - EventNode 表示"发生过的一次事件"（有起止时间感）；
 * - EntityNode 表示"持续存在的对象"，多个人可以分别与同一个 entity 建立关系（如"喜欢/玩/拥有/创作/讨厌"）。
 *
 * 经典场景：群里有两人都喜欢游戏《三角洲》 → 应建模为一个 EntityNode (entityKind='work', name='三角洲')
 * 两人通过 person-entity 边（role='enthusiast'）共同指向它；而不是塞进一个事件标题。
 */
export type EntityKind =
  | 'topic' // 话题 / 兴趣 / 概念
  | 'place' // 地点 / 场所
  | 'thing' // 物品 / 商品
  | 'work'; // 作品 / 游戏 / 影视 / 书籍

export interface EntityNode {
  /** UUID */
  id: string;
  entityKind: EntityKind;
  /** 实体名（图上显示，<=20字） */
  name: string;
  /** 别名 / 同义词，用于去重匹配 */
  aliases?: string[];
  /** 一两句话的描述 */
  summary?: string;
  firstSeenAt: number;
  lastReinforcedAt: number;
  evidence: EvidenceRef[];
  /**
   * 节点合并强度 0~1。每次按 (kind, name) 合并时 += 0.3（clamp 到 1.0），用于淘汰排序。
   * **语义 = 被强化次数累计，不是"重要性"**；真正的结构性重要性看 `lastPageRank`。
   */
  weight?: number;
  /** 最近一次 evictByQuota 计算出的 PageRank 分数（结构性重要性）。 */
  lastPageRank?: number;
  lastPageRankAt?: number;
  /** 最近一次在对话窗口中被提及的时间 */
  lastMentionedAt?: number;
  /** 总共被提及次数 */
  mentionCount?: number;
  /** rename 审计：每次改名追加一条 */
  nameHistory?: NodeNameAudit[];
}

/**
 * 节点改名审计记录（仅 Event/Entity 可改名；Person.name 与 platform displayName 绑定，禁改）。
 *
 * 每次 `renameNode()` 调用追加一条；老 name 同步追加到 `aliases`，所以即便回滚成本也很低。
 */
export interface NodeNameAudit {
  /** 改名前的 name / title */
  from: string;
  /** 改名后的 name / title */
  to: string;
  /** 时间戳 ms */
  at: number;
  /** 触发来源标识：'llm' / 'manual' / 'consolidate' / 系统其它 */
  by?: string;
  /** 改名理由（≤80 字，由 LLM 或调用方提供） */
  reason?: string;
}

/**
 * 边权 audit：correctEdge 修改 weight 时写入 edge.weightHistory[]。
 * 物理删除的边随边一起销毁，不留 audit（避免脏数据堆积）。
 */
export interface EdgeWeightAudit {
  from: number;
  to: number;
  action: 'weaken' | 'strengthen';
  at: number;
  by?: string;
  reason?: string;
}

/** 人 → 事件 的参与角色 */
export type PersonEventRole =
  | 'initiator' // 发起者 / 提起话题者
  | 'participant' // 主要参与者
  | 'witness' // 旁观者 / 围观
  | 'target' // 被指向 / 被评价 / 被吐槽对象
  | 'reporter'; // 转述 / 报告者（自己未亲历）

export type Sentiment = 'positive' | 'negative' | 'neutral' | 'mixed';

/** 人 → 事件 边 */
export interface PersonEventEdge {
  /** UUID */
  id: string;
  kind: 'person-event';
  fromPersonId: string;
  toEventId: string;
  role: PersonEventRole;
  /** 该人对该事件的态度倾向（如有可识别） */
  sentiment?: Sentiment;
  /** 强度 0~1，反复强化累积：`reinforceWeight(prev, delta) = prev + (1-prev)·delta`，不做时间衰减 */
  weight: number;
  /** 可选人可读注释（LLM 提取时输出，<=40 字）。例：「发起讨论后被反驳」 */
  description?: string;
  firstSeenAt: number;
  lastReinforcedAt: number;
  evidence: EvidenceRef[];
  /** weight 调整审计（correctEdge 写入） */
  weightHistory?: EdgeWeightAudit[];
}

/**
 * 人 → 人 关系类型 —— **半开放词表**。
 *
 * LLM 提取时会被推荐优先使用下列高频词，必要时可自创新词；
 * 应用层 normalize 阶段会把同义词归一（best_friend → friend）。
 */
export const RecommendedPersonRelationTypes = [
  'friend',
  'cp',
  'rival',
  'mentor',
  'colleague',
  'familiar',
  'antagonist',
  'admirer',
  'is-alias-of', // 「A 是 B 的别名 / 小号」（有向）
  'alt-account-of', // 「A 是 B 的小号」（有向）
] as const;

export type RecommendedPersonRelationType = (typeof RecommendedPersonRelationTypes)[number];

/**
 * 人际层级维度 —— 与 `directed` 正交。
 *
 * `directed` 描述"A 声明与 B 的关系"（reporter 语义）；`hierarchy` 单独描述
 * 角色高低，避免把"上下/平级"塞进 relationType 文本里污染语义。
 *
 * - `superior`：from 视角下 from > to（如 from 是老板、师父、长辈）
 * - `subordinate`：from < to
 * - `peer`：明确平级（同学、同事、朋友）
 * - `unknown`：未知或不适用（默认）
 */
export const PersonHierarchyValues = ['superior', 'peer', 'subordinate', 'unknown'] as const;
export type PersonHierarchy = (typeof PersonHierarchyValues)[number];

/** 人 → 人 边 */
export interface PersonPersonEdge {
  /** UUID */
  id: string;
  kind: 'person-person';
  fromPersonId: string;
  toPersonId: string;
  /** 关系类型；推荐使用 RecommendedPersonRelationTypes 之一，但允许自创 */
  relationType: string;
  /** 是否有向：'admirer' / 'mentor' 单向，'cp' / 'friend' / 'rival' 双向 */
  directed: boolean;
  /**
   * 人际层级（与 directed 正交）。未填视为 'unknown'。
   *
   * 注意：取值是 **from 视角**。例如 from 是徒、to 是师 → `subordinate`；
   * 反过来 from 是师 → `superior`。
   */
  hierarchy?: PersonHierarchy;
  weight: number;
  /** 可选人可读注释（<=40 字） */
  description?: string;
  firstSeenAt: number;
  lastReinforcedAt: number;
  evidence: EvidenceRef[];
  /** weight 调整审计（correctEdge 写入） */
  weightHistory?: EdgeWeightAudit[];
}

export type RelationEdge =
  | PersonEventEdge
  | PersonPersonEdge
  | PersonEntityEdge
  | EventEventEdge
  | EventEntityEdge
  | EntityEntityEdge;

/**
 * 人 → 实体 的关系角色。
 *
 * 关系图记录「结构性连接」——帮助发现「多人通过共同对象形成的社会连接」。
 * 判断原则：有行为性证据才建边；纯态度/声明交给 plugin-user-profile。
 *
 * - `enthusiast`：**深度行为性卷入**（规律参与、制作内容、购买、直播等），
 *   多人共同 enthusiast 同一实体可揭示隐性社会连接。
 *   ⚠️ 不是"单句喜欢声明"，那是 user-profile 的画像属性。
 * - `participant`：参与/使用（"玩三角洲"、"用了这个工具"）
 * - `owner`：拥有（"有 PS5"、"买了这张专辑"）
 * - `creator`：创作者（"画了那个表情包"、"做了 mod"）
 * - `critic`：**主动行为性批评**（写评测、公开对抗、反复表达负面互动），
 *   不是单次"我不喜欢 X"的吐槽声明。
 * - `visitor`：去过 / 到访（适用于 place）
 * - `mentioned`：仅被提及，态度不明；可搭配 sentiment 字段
 *
 * 纯态度信号（好感/反感/兴趣）请用 `sentiment` 字段附加在任意角色边上，
 * 不要为此单独选择 enthusiast/critic 角色。
 */
export type PersonEntityRole = 'enthusiast' | 'participant' | 'owner' | 'creator' | 'critic' | 'visitor' | 'mentioned';

export const RecommendedPersonEntityRoles = [
  'enthusiast',
  'participant',
  'owner',
  'creator',
  'critic',
  'visitor',
  'mentioned',
] as const;

/** 人 → 实体 边 */
export interface PersonEntityEdge {
  id: string;
  kind: 'person-entity';
  fromPersonId: string;
  toEntityId: string;
  role: PersonEntityRole;
  sentiment?: Sentiment;
  weight: number;
  /** 可选人可读注释（<=40 字）。例：「主机玩家，每晚直播」 */
  description?: string;
  firstSeenAt: number;
  lastReinforcedAt: number;
  evidence: EvidenceRef[];
  /** weight 调整审计（correctEdge 写入） */
  weightHistory?: EdgeWeightAudit[];
}

/**
 * 事件 → 事件 的关联类型（推荐词表，允许自创小写英文短词）。
 *
 * - `caused-by`：A 由 B 引起（有方向）
 * - `follows`：A 紧随 B 发生（有方向）
 * - `related`：相关联（无方向）
 * - `contradicts`：互相矛盾 / 抵消（无方向）
 * - `part-of`：A 是 B 的一部分（有方向）
 */
export const RecommendedEventEventRelationTypes = [
  'caused-by',
  'follows',
  'related',
  'contradicts',
  'part-of',
] as const;

export interface EventEventEdge {
  id: string;
  kind: 'event-event';
  fromEventId: string;
  toEventId: string;
  relationType: string;
  directed: boolean;
  weight: number;
  /** 可选人可读注释（<=40 字） */
  description?: string;
  firstSeenAt: number;
  lastReinforcedAt: number;
  evidence: EvidenceRef[];
  /** weight 调整审计（correctEdge 写入） */
  weightHistory?: EdgeWeightAudit[];
}

/**
 * 事件 → 实体 的关联类型（推荐词表，允许自创小写英文短词）。
 *
 * - `about`：事件讨论/关于该实体（如「讨论三角洲新赛季」 about 《三角洲》）
 * - `uses`：事件使用该实体（如「直播」 uses 《三角洲》）
 * - `located-at`：事件发生在某地点 / 场所
 * - `produced`：事件产生了该实体（作品 / 产品）
 */
export const RecommendedEventEntityRelationTypes = ['about', 'uses', 'located-at', 'produced', 'part-of'] as const;

export interface EventEntityEdge {
  id: string;
  kind: 'event-entity';
  fromEventId: string;
  toEntityId: string;
  relationType: string;
  /** 事件→实体 始终有向（directed=true），保留字段以便与其他边签名一致 */
  directed: boolean;
  weight: number;
  /** 可选人可读注释（<=40 字） */
  description?: string;
  firstSeenAt: number;
  lastReinforcedAt: number;
  evidence: EvidenceRef[];
  /** weight 调整审计（correctEdge 写入） */
  weightHistory?: EdgeWeightAudit[];
}

/**
 * 实体 → 实体 的关联类型（推荐词表，允许自创）。常用于表达实体间的属于 / 包含 / 变体 / 对立 关系。
 *
 * - `part-of`：A 是 B 的一部分（有向），如「绝巴 part-of 三角洲」
 * - `contains`：A 包含 B（有向，与 part-of 互为逆）
 * - `variant-of`：A 是 B 的变体 / 资料片（有向）
 * - `related`：相关（无向）
 * - `opposite`：对立 / 互斥（无向）
 */
export const RecommendedEntityEntityRelationTypes = [
  'part-of',
  'contains',
  'variant-of',
  'related',
  'opposite',
  'is-alias-of', // 「《绝巴》 is-alias-of 《绝密公司上巴谷》」（有向）
] as const;

export interface EntityEntityEdge {
  id: string;
  kind: 'entity-entity';
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  directed: boolean;
  weight: number;
  /** 可选人可读注释（<=40 字）。例：「绝巴是三角洲的高难度关卡」 */
  description?: string;
  firstSeenAt: number;
  lastReinforcedAt: number;
  evidence: EvidenceRef[];
  /** weight 调整审计（correctEdge 写入） */
  weightHistory?: EdgeWeightAudit[];
}

/**
 * scoreBetween 模式：
 * - `'symmetric'`（默认）= **联系紧密度**。a→b、b→a 两个方向各算一次取 max。
 *   "这两个节点之间存在任意方向的关系连通"。人际单方面声明（A 把 B 当朋友、B 不知）会从一侧贡献。
 * - `'directed'` = **关注/影响传播度**。只跑 from→to。
 *   "从 A 出发能通过主动声明触达 B 的强度"。
 *
 * 方向约束（两种模式共同遵守）：
 * - 桥型边（person-event / person-entity / event-entity）：事件/实体是中介无主观能动 → 邻接表里总是双向
 * - 主体间边（person-person / event-event / entity-entity）：按 edge.directed 决定单/双向遍历
 *   - person-person 默认 directed=true（人有主观能动，不可单方面假设双向）
 */
export type ScoreMode = 'symmetric' | 'directed';

/** 完整关系图快照（供 webui 渲染） */
export interface RelationGraphSnapshot {
  persons: PersonNode[];
  events: EventNode[];
  entities: EntityNode[];
  edges: RelationEdge[];
}
