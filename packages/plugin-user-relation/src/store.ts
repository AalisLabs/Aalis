/**
 * RelationStore —— 基于 MemoryService.saveMetadata 抽象的关系图存储层。
 *
 * **复用现有存储抽象的理由**：
 * - MemoryService 已统一不同后端（sqlite/mongodb/inmemory）的 KV metadata API；
 * - 用户配置 mongodb 时，关系数据会和 messages 一起落到 mongodb，无需新表/迁移；
 * - 查询是 KV + 应用层 join，关系图查询最多 1~2 跳，不构成瓶颈。
 *
 * **Key schema**（同一 namespace 内）：
 * - `person:{platform}:{userId}` → PersonNode
 * - `event:{uuid}`               → EventNode
 * - `entity:{uuid}`              → EntityNode
 * - `edge:{uuid}`                → RelationEdge
 *
 * listMetadata(namespace) 返回所有条目，按 key 前缀分类即可。
 * 不维护倒排索引：关系图体量预期 < 数千节点，全量加载完全可接受；
 * 真要扩到 10k+ 再加索引（届时换 namespace 划分即可）。
 */
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { EntityNode, EventNode, PersonNode, RelationEdge, RelationGraphSnapshot } from './types.js';

export const RELATION_NAMESPACE = 'user-relation';

const PERSON_PREFIX = 'person:';
const EVENT_PREFIX = 'event:';
const ENTITY_PREFIX = 'entity:';
const EDGE_PREFIX = 'edge:';
const MERGE_REJECT_PREFIX = 'merge-reject:';

/** key 编码 / 解码 */
export function personKey(platform: string, userId: string): string {
  return `${PERSON_PREFIX}${platform}:${userId}`;
}
export function eventKey(eventId: string): string {
  return `${EVENT_PREFIX}${eventId}`;
}
function entityKey(entityId: string): string {
  return `${ENTITY_PREFIX}${entityId}`;
}
export function edgeKey(edgeId: string): string {
  return `${EDGE_PREFIX}${edgeId}`;
}
/**
 * mergeReject 持久化缓存的 key：把两端 id 排序，得到对称稳定键。
 * 用于 consolidate LLM 否决合并的去重缓存——下次 maintain 时若双方"真新关系"指标未变即可跳过 LLM。
 *
 * **失效信号（2026-05 改造）**：采用 `evidence.length` 作为"是否有新关系/新提及"的稳定信号。
 * 旧版用 `lastReinforcedAt`，但该字段会被 evictByQuota → rewriteWeights 的衰减回写批量刷新，
 * 导致缓存全量失效、连续 maintain 重复调 LLM。evidence.length 仅在节点真新增 evidence 时增长，
 * 与衰减回写解耦，是更稳定的"分别没有新关系产生"指标。
 * 旧字段 aReinforcedAt/bReinforcedAt 保留作为兼容信息，但**不再参与判断**。
 */
function mergeRejectKey(aId: string, bId: string): string {
  const [x, y] = aId < bId ? [aId, bId] : [bId, aId];
  return `${MERGE_REJECT_PREFIX}${x}|${y}`;
}

/** consolidate LLM 否决合并的缓存记录。 */
interface MergeRejectRecord {
  /** 排序后的较小 id */
  aId: string;
  /** 排序后的较大 id */
  bId: string;
  /** 决策时 a 节点的 lastReinforcedAt；保留作为审计信息，不参与失效判断 */
  aReinforcedAt: number;
  /** 决策时 b 节点的 lastReinforcedAt；保留作为审计信息，不参与失效判断 */
  bReinforcedAt: number;
  /**
   * 决策时 a 节点的 evidence 数量。当前值改变 → 节点产生了新关系/新提及 → 缓存失效需重判。
   * 老数据无此字段时回退为"必失效"（一次性影响，下次写入即恢复）。
   */
  aEvidenceCount?: number;
  /** 决策时 b 节点的 evidence 数量；与 aEvidenceCount 同语义。 */
  bEvidenceCount?: number;
  /** LLM 给出的理由 */
  reason: string;
  /** 决策时间戳 */
  decidedAt: number;
  /** 决策来源：strict-equiv（严格等价路径）/ wide-recall（宽召回路径）/ cross-kind（跨 kind 同名召回） */
  decidedBy: 'strict-equiv' | 'wide-recall' | 'cross-kind';
  /** 决策时节点的种类（entity / event / person），主要为调试与未来扩展用 */
  kind: 'entity' | 'event' | 'person';
}

/** Memory 后端不支持 metadata 时使用的 NoOp 实现 —— 抛错而非静默吞掉，避免数据丢失被忽略 */
class UnsupportedMemoryError extends Error {
  constructor() {
    super(
      'RelationStore 要求当前 memory 服务支持 "metadata" 能力 (saveMetadata/getMetadata/listMetadata/deleteMetadata)。' +
        '请启用 plugin-memory-sqlite / plugin-memory-mongodb 或其他实现 metadata 能力的 memory 插件。',
    );
    this.name = 'UnsupportedMemoryError';
  }
}

function assertMetadataSupport(memory: MemoryService): asserts memory is MemoryService & {
  saveMetadata: NonNullable<MemoryService['saveMetadata']>;
  getMetadata: NonNullable<MemoryService['getMetadata']>;
  listMetadata: NonNullable<MemoryService['listMetadata']>;
  deleteMetadata: NonNullable<MemoryService['deleteMetadata']>;
} {
  if (!memory.saveMetadata || !memory.getMetadata || !memory.listMetadata || !memory.deleteMetadata) {
    throw new UnsupportedMemoryError();
  }
}

export class RelationStore {
  constructor(private readonly memory: MemoryService) {
    assertMetadataSupport(memory);
  }

  // ----- Person -----

  async getPerson(platform: string, userId: string): Promise<PersonNode | undefined> {
    const data = await this.memory.getMetadata!(RELATION_NAMESPACE, personKey(platform, userId));
    return data as PersonNode | undefined;
  }

  async upsertPerson(node: PersonNode): Promise<void> {
    await this.memory.saveMetadata!(
      RELATION_NAMESPACE,
      personKey(node.platform, node.userId),
      node as unknown as Record<string, unknown>,
    );
  }

  async deletePerson(platform: string, userId: string): Promise<void> {
    await this.memory.deleteMetadata!(RELATION_NAMESPACE, personKey(platform, userId));
  }

  // ----- Event -----

  async getEvent(eventId: string): Promise<EventNode | undefined> {
    const data = await this.memory.getMetadata!(RELATION_NAMESPACE, eventKey(eventId));
    return data as EventNode | undefined;
  }

  async upsertEvent(node: EventNode): Promise<void> {
    await this.memory.saveMetadata!(RELATION_NAMESPACE, eventKey(node.id), node as unknown as Record<string, unknown>);
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.memory.deleteMetadata!(RELATION_NAMESPACE, eventKey(eventId));
  }

  // ----- Entity -----

  async getEntity(entityId: string): Promise<EntityNode | undefined> {
    const data = await this.memory.getMetadata!(RELATION_NAMESPACE, entityKey(entityId));
    return data as EntityNode | undefined;
  }

  async upsertEntity(node: EntityNode): Promise<void> {
    await this.memory.saveMetadata!(RELATION_NAMESPACE, entityKey(node.id), node as unknown as Record<string, unknown>);
  }

  async deleteEntity(entityId: string): Promise<void> {
    await this.memory.deleteMetadata!(RELATION_NAMESPACE, entityKey(entityId));
  }

  // ----- Edge -----

  async getEdge(edgeId: string): Promise<RelationEdge | undefined> {
    const data = await this.memory.getMetadata!(RELATION_NAMESPACE, edgeKey(edgeId));
    return data as RelationEdge | undefined;
  }

  async upsertEdge(edge: RelationEdge): Promise<void> {
    await this.memory.saveMetadata!(RELATION_NAMESPACE, edgeKey(edge.id), edge as unknown as Record<string, unknown>);
  }

  async deleteEdge(edgeId: string): Promise<void> {
    await this.memory.deleteMetadata!(RELATION_NAMESPACE, edgeKey(edgeId));
  }

  // ----- MergeReject 缓存（consolidate LLM 否决合并的持久化去重） -----

  async getMergeReject(aId: string, bId: string): Promise<MergeRejectRecord | undefined> {
    const data = await this.memory.getMetadata!(RELATION_NAMESPACE, mergeRejectKey(aId, bId));
    return data as MergeRejectRecord | undefined;
  }

  async saveMergeReject(record: MergeRejectRecord): Promise<void> {
    await this.memory.saveMetadata!(
      RELATION_NAMESPACE,
      mergeRejectKey(record.aId, record.bId),
      record as unknown as Record<string, unknown>,
    );
  }

  async deleteMergeReject(aId: string, bId: string): Promise<void> {
    await this.memory.deleteMetadata!(RELATION_NAMESPACE, mergeRejectKey(aId, bId));
  }

  /** 列出全部 MergeReject 记录（webui / debug 用，体量预计 < 候选数）。 */
  async listMergeRejects(): Promise<MergeRejectRecord[]> {
    const entries = await this.memory.listMetadata!(RELATION_NAMESPACE);
    const out: MergeRejectRecord[] = [];
    for (const { key, data } of entries) {
      if (key.startsWith(MERGE_REJECT_PREFIX)) out.push(data as unknown as MergeRejectRecord);
    }
    return out;
  }

  /** 当某个节点被合并/删除时，清理所有涉及它的 MergeReject 缓存（旧 id 不再有效）。 */
  async deleteMergeRejectsByNode(nodeId: string): Promise<number> {
    const entries = await this.memory.listMetadata!(RELATION_NAMESPACE);
    let deleted = 0;
    for (const { key, data } of entries) {
      if (!key.startsWith(MERGE_REJECT_PREFIX)) continue;
      const r = data as unknown as MergeRejectRecord;
      if (r.aId === nodeId || r.bId === nodeId) {
        await this.memory.deleteMetadata!(RELATION_NAMESPACE, key);
        deleted++;
      }
    }
    return deleted;
  }

  // ----- 全量加载（webui / 注入用） -----

  async loadAll(): Promise<RelationGraphSnapshot> {
    const entries = await this.memory.listMetadata!(RELATION_NAMESPACE);
    const persons: PersonNode[] = [];
    const events: EventNode[] = [];
    const entities: EntityNode[] = [];
    const edges: RelationEdge[] = [];

    for (const { key, data } of entries) {
      if (key.startsWith(PERSON_PREFIX)) persons.push(data as unknown as PersonNode);
      else if (key.startsWith(EVENT_PREFIX)) events.push(data as unknown as EventNode);
      else if (key.startsWith(ENTITY_PREFIX)) entities.push(data as unknown as EntityNode);
      else if (key.startsWith(EDGE_PREFIX)) edges.push(data as unknown as RelationEdge);
      // 其他 key 静默忽略，便于未来加扩展类型而不破坏老版
    }

    return { persons, events, entities, edges };
  }

  /** 级联删除人物：移除该人物所有相关边，然后删除人物本身 */
  async deletePersonCascade(platform: string, userId: string): Promise<{ deletedEdges: number }> {
    const id = `${platform}:${userId}`;
    const snapshot = await this.loadAll();
    let deletedEdges = 0;
    for (const edge of snapshot.edges) {
      const involved =
        (edge.kind === 'person-event' && edge.fromPersonId === id) ||
        (edge.kind === 'person-entity' && edge.fromPersonId === id) ||
        (edge.kind === 'person-person' && (edge.fromPersonId === id || edge.toPersonId === id));
      if (involved) {
        await this.deleteEdge(edge.id);
        deletedEdges++;
      }
    }
    await this.deletePerson(platform, userId);
    // 顺手清掉这个人的 mergeReject 缓存（pair metadata 会变孤儿）
    await this.deleteMergeRejectsByNode(id);
    return { deletedEdges };
  }

  /** 级联删除事件：移除所有指向该事件的边，然后删除事件本身 */
  async deleteEventCascade(eventId: string): Promise<{ deletedEdges: number }> {
    const snapshot = await this.loadAll();
    let deletedEdges = 0;
    for (const edge of snapshot.edges) {
      const involved =
        (edge.kind === 'person-event' && edge.toEventId === eventId) ||
        (edge.kind === 'event-event' && (edge.fromEventId === eventId || edge.toEventId === eventId)) ||
        (edge.kind === 'event-entity' && edge.fromEventId === eventId);
      if (involved) {
        await this.deleteEdge(edge.id);
        deletedEdges++;
      }
    }
    await this.deleteEvent(eventId);
    await this.deleteMergeRejectsByNode(eventId);
    return { deletedEdges };
  }

  /** 级联删除实体：移除所有指向该实体的 person-entity / event-entity / entity-entity 边 */
  async deleteEntityCascade(entityId: string): Promise<{ deletedEdges: number }> {
    const snapshot = await this.loadAll();
    let deletedEdges = 0;
    for (const edge of snapshot.edges) {
      const involved =
        (edge.kind === 'person-entity' && edge.toEntityId === entityId) ||
        (edge.kind === 'event-entity' && edge.toEntityId === entityId) ||
        (edge.kind === 'entity-entity' && (edge.fromEntityId === entityId || edge.toEntityId === entityId));
      if (involved) {
        await this.deleteEdge(edge.id);
        deletedEdges++;
      }
    }
    await this.deleteEntity(entityId);
    await this.deleteMergeRejectsByNode(entityId);
    return { deletedEdges };
  }
}
