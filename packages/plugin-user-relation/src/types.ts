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
}

/** 事件类别（粗分类，仅供 UI 上色与过滤） */
export type EventCategory =
  | 'discussion' // 群内讨论某话题 / 作品 / 观点
  | 'conflict' // 冲突 / 争执 / 对线
  | 'collaboration' // 合作 / 共同行动
  | 'incident' // 突发事件 / 事故
  | 'milestone' // 里程碑 / 成就
  | 'other';

/** 事件节点 */
export interface EventNode {
  /** UUID */
  id: string;
  /** 事件简称（LLM 提取生成，限长，便于图上显示） */
  title: string;
  /** 一两句话的事件摘要 */
  summary?: string;
  category?: EventCategory;
  firstSeenAt: number;
  lastReinforcedAt: number;
  /** 提取该事件的证据列表 */
  evidence: EvidenceRef[];
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
  /** 强度 0~1，时间衰减 + 反复强化累积 */
  weight: number;
  firstSeenAt: number;
  lastReinforcedAt: number;
  evidence: EvidenceRef[];
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
] as const;

export type RecommendedPersonRelationType = (typeof RecommendedPersonRelationTypes)[number];

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
  weight: number;
  firstSeenAt: number;
  lastReinforcedAt: number;
  evidence: EvidenceRef[];
}

export type RelationEdge = PersonEventEdge | PersonPersonEdge;

/** 完整关系图快照（供 webui 渲染） */
export interface RelationGraphSnapshot {
  persons: PersonNode[];
  events: EventNode[];
  edges: RelationEdge[];
}
