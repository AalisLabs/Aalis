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
    return { deletedEdges };
  }

  /** 级联删除事件：移除所有指向该事件的边，然后删除事件本身 */
  async deleteEventCascade(eventId: string): Promise<{ deletedEdges: number }> {
    const snapshot = await this.loadAll();
    let deletedEdges = 0;
    for (const edge of snapshot.edges) {
      const involved =
        (edge.kind === 'person-event' && edge.toEventId === eventId) ||
        (edge.kind === 'event-event' && (edge.fromEventId === eventId || edge.toEventId === eventId));
      if (involved) {
        await this.deleteEdge(edge.id);
        deletedEdges++;
      }
    }
    await this.deleteEvent(eventId);
    return { deletedEdges };
  }

  /** 级联删除实体：移除所有指向该实体的 person-entity 边 */
  async deleteEntityCascade(entityId: string): Promise<{ deletedEdges: number }> {
    const snapshot = await this.loadAll();
    let deletedEdges = 0;
    for (const edge of snapshot.edges) {
      if (edge.kind === 'person-entity' && edge.toEntityId === entityId) {
        await this.deleteEdge(edge.id);
        deletedEdges++;
      }
    }
    await this.deleteEntity(entityId);
    return { deletedEdges };
  }
}
