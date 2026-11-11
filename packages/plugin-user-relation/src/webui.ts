// ============================================================
// plugin-user-relation —— 关系图页与原始数据页
//
// 关系图页：一张全图，节点（人物、事件、实体）与边按类别取色，疏密取本插件配置的 graphSpacing；选中一个节点在详情里
// 看它的属性与连着它的关系。原始数据页：人物、事件、实体三张表，行动作删除（连同相关的边）。
// 数据源与处理函数是 apply 的闭包，直接用本次激活构造的 RelationService；删除之后两页都重取。
// 抽取写入的变化不推送，靠打开时取一次与手动刷新。
// ============================================================

import type { BoundWebui, GraphData, InfoItem, TableRow } from '@aalis/api-webui';
import type { Logger } from '@aalis/core';
import { TextError, type TextRef } from '@aalis/schema-i18n';
import type { RelationService } from './service.js';
import { t } from './texts.js';
import type { EntityKind, EntityNode, EventCategory, EventNode, PersonNode, RelationEdge } from './types.js';
import { edgeEndpoints } from './utils.js';

/** 关系名：存储里的英文键 → 字典里的显示名；推荐词表之外自创的关系原样显示 */
const RELATION_NAMES: Record<string, string | TextRef> = {
  // person-event role
  initiator: t('relationInitiator'),
  participant: t('relationParticipant'),
  witness: t('relationWitness'),
  target: t('relationTarget'),
  reporter: t('relationReporter'),
  // person-entity role
  enthusiast: t('relationEnthusiast'),
  owner: t('relationOwner'),
  creator: t('relationCreator'),
  critic: t('relationCritic'),
  visitor: t('relationVisitor'),
  mentioned: t('relationMentioned'),
  // person-person relation
  friend: t('relationFriend'),
  cp: 'CP',
  rival: t('relationRival'),
  mentor: t('relationMentor'),
  colleague: t('relationColleague'),
  familiar: t('relationFamiliar'),
  antagonist: t('relationAntagonist'),
  admirer: t('relationAdmirer'),
  // event-event relation
  'caused-by': t('relationCausedBy'),
  follows: t('relationFollows'),
  'part-of': t('relationPartOf'),
  related: t('relationRelated'),
  // event-entity relation
  about: t('relationAbout'),
  uses: t('relationUses'),
  'located-at': t('relationLocatedAt'),
  produced: t('relationProduced'),
  // entity-entity relation
  contains: t('relationContains'),
  'variant-of': t('relationVariantOf'),
  opposite: t('relationOpposite'),
};

/** 落盘值的显示名：表里有的取字典里的名字，表里没有的（第一方之外写进的值、词表之外的关系词）原样显示 */
export const nameIn = (names: Readonly<Record<string, string | TextRef>>, value: string): string | TextRef =>
  Object.hasOwn(names, value) ? names[value] : value;

/** 边上的关系：人物对事件、实体是角色，其余是关系类型 */
const edgeLabel = (edge: RelationEdge) =>
  nameIn(RELATION_NAMES, edge.kind === 'person-event' || edge.kind === 'person-entity' ? edge.role : edge.relationType);

/** 实体类型的显示名（存储里的值照旧）；/relation orphans 同用 */
export const ENTITY_KIND_NAMES: Record<EntityKind, TextRef> = {
  topic: t('entityTopic'),
  place: t('entityPlace'),
  thing: t('entityThing'),
  work: t('entityWork'),
};

/** 事件类别的显示名（存储里的值照旧） */
const EVENT_CATEGORY_NAMES: Record<EventCategory, TextRef> = {
  discussion: t('categoryDiscussion'),
  conflict: t('categoryConflict'),
  collaboration: t('categoryCollaboration'),
  incident: t('categoryIncident'),
  milestone: t('categoryMilestone'),
  other: t('categoryOther'),
};

function previewEvidence(item: RelationEdge | EventNode | EntityNode): string | TextRef {
  if (item.evidence.length === 0) return '';
  const recent = [...item.evidence].sort((a, b) => b.extractedAt - a.extractedAt)[0];
  return recent.quote ?? t('evidenceCount', { count: recent.messageIds.length });
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const personLabel = (person: PersonNode) => person.displayName?.trim() || person.userId;

const NODE_KINDS = [
  { kind: 'person', label: t('persons'), tone: 1 },
  { kind: 'event', label: t('events'), tone: 2 },
  { kind: 'entity', label: t('entities'), tone: 3 },
] as const;
const EDGE_KINDS = [
  { kind: 'person-person', label: t('personPerson'), tone: 1 },
  { kind: 'person-event', label: t('personEvent'), tone: 2 },
  { kind: 'person-entity', label: t('personEntity'), tone: 3 },
  { kind: 'event-event', label: t('eventEvent'), tone: 4 },
  { kind: 'event-entity', label: t('eventEntity'), tone: 5 },
  { kind: 'entity-entity', label: t('entityEntity'), tone: 6 },
] as const;

/** 删除动作核对的种类：找不到时的报错 */
const NO_SUCH: Record<'person' | 'event' | 'entity', TextRef> = {
  person: t('noSuchPerson'),
  event: t('noSuchEvent'),
  entity: t('noSuchEntity'),
};

/** 关系图页与原始数据页；spacing 是关系图布局的理想边长（像素） */
export function registerRelationPages(webui: BoundWebui, service: RelationService, logger: Logger, spacing: number) {
  /** 全图：节点与边，引用了缺失节点的边跳过并记告警（某些级联删除或合并路径可能漏清边，这里不修存储） */
  async function graph(): Promise<GraphData> {
    const snap = await service.loadAll();
    const nodes = [
      ...snap.persons.map(p => ({ id: p.id, label: personLabel(p), kind: 'person' })),
      ...snap.events.map(e => ({ id: e.id, label: truncate(e.title, 18), kind: 'event' })),
      ...snap.entities.map(e => ({ id: e.id, label: truncate(e.name, 16), kind: 'entity' })),
    ];
    const ids = new Set(nodes.map(node => node.id));
    const edges: GraphData['edges'] = [];
    const dangling: string[] = [];
    for (const edge of snap.edges) {
      const [source, target] = edgeEndpoints(edge);
      if (ids.has(source) && ids.has(target)) edges.push({ source, target, label: edgeLabel(edge), kind: edge.kind });
      else dangling.push(`${edge.id}(${source}→${target})`);
    }
    if (dangling.length > 0) {
      const more = dangling.length > 5 ? `，… 共 ${dangling.length} 条` : '';
      logger.warn(
        `关系图跳过 ${dangling.length}/${snap.edges.length} 条引用了缺失节点的边: ${dangling.slice(0, 5).join(', ')}${more}`,
      );
    }
    return { nodes, edges };
  }

  /** 选中的节点：人物的 id 是「平台:用户 ID」，事件与实体是 UUID */
  async function nodeDetail(id: string) {
    const snap = await service.loadAll();
    const node =
      snap.persons.find(p => p.id === id) ?? snap.events.find(e => e.id === id) ?? snap.entities.find(e => e.id === id);
    if (!node) throw new TextError(t('noNode', { id }));
    const labels = new Map<string, string>([
      ...snap.persons.map(p => [p.id, personLabel(p)] as const),
      ...snap.events.map(e => [e.id, e.title] as const),
      ...snap.entities.map(e => [e.id, e.name] as const),
    ]);
    return { node, labels, edges: snap.edges.filter(edge => edgeEndpoints(edge).includes(id)) };
  }

  function nodeInfo(node: PersonNode | EventNode | EntityNode): InfoItem[] {
    if ('userId' in node) {
      return [
        { label: t('infoKind'), value: t('person') },
        { label: t('columnDisplayName'), value: node.displayName ?? '' },
        { label: t('columnPlatform'), value: node.platform },
        { label: t('columnUserId'), value: node.userId, kind: 'code' },
        { label: t('columnFirstSeen'), value: node.firstSeenAt, kind: 'time' },
        { label: t('columnLastSeen'), value: node.lastSeenAt, kind: 'time' },
        { label: t('infoMentions'), value: node.mentionCount },
      ];
    }
    const common: InfoItem[] = [
      { label: t('columnSummary'), value: node.summary ?? '', kind: 'long-text' },
      { label: t('columnEvidenceCount'), value: node.evidence.length },
      { label: t('columnLastReinforced'), value: node.lastReinforcedAt, kind: 'time' },
    ];
    if ('title' in node) {
      return [
        { label: t('infoKind'), value: t('event') },
        { label: t('columnTitle'), value: node.title },
        { label: t('columnCategory'), value: node.category ? nameIn(EVENT_CATEGORY_NAMES, node.category) : '' },
        { label: t('columnSession'), value: node.sessionScope },
        ...common,
      ];
    }
    return [
      { label: t('infoKind'), value: t('entity') },
      { label: t('columnName'), value: node.name },
      { label: t('columnType'), value: nameIn(ENTITY_KIND_NAMES, node.entityKind) },
      { label: t('columnAliases'), value: t('aliasList', { aliases: node.aliases ?? [] }) },
      ...common,
    ];
  }

  const graphPage = webui.definePage({
    key: 'user-relation',
    title: t('displayName'),
    icon: 'share-2',
    content: [
      {
        type: 'graph',
        id: 'graph',
        description: t('graphDescription'),
        empty: t('graphEmpty'),
        nodeKinds: [...NODE_KINDS],
        edgeKinds: [...EDGE_KINDS],
        spacing,
        data: graph,
        detail: [
          { type: 'info', id: 'node', data: async ({ rowKey }) => nodeInfo((await nodeDetail(rowKey)).node) },
          {
            type: 'table',
            id: 'relations',
            label: t('relations'),
            rowKey: 'id',
            empty: t('relationsEmpty'),
            columns: [
              { key: 'other', label: t('columnOther'), primary: true },
              { key: 'relation', label: t('columnRelation'), primary: true },
              { key: 'weight', label: t('columnWeight') },
              { key: 'lastReinforcedAt', label: t('columnLastReinforced'), kind: 'time' },
              { key: 'evidence', label: t('columnLatestEvidence'), kind: 'long-text' },
            ],
            async data({ rowKey }) {
              const { labels, edges } = await nodeDetail(rowKey);
              return edges.map(edge => {
                const [source, target] = edgeEndpoints(edge);
                const other = source === rowKey ? target : source;
                return {
                  id: edge.id,
                  other: labels.get(other) ?? other,
                  relation: edgeLabel(edge),
                  weight: Math.round(edge.weight * 100) / 100,
                  lastReinforcedAt: edge.lastReinforcedAt,
                  evidence: previewEvidence(edge),
                };
              });
            },
          },
        ],
      },
    ],
  });

  /** 删除前先核节点在且种类对：删除本身对不存在的节点什么也不做，不核就会把找不到当成成功 */
  async function removeNode(id: string, kind: 'person' | 'event' | 'entity', remove: () => Promise<unknown>) {
    const found = await service.findNodeById(id);
    if (found?.kind !== kind) throw new TextError(NO_SUCH[kind]);
    await remove();
    rawPage.invalidate();
    graphPage.invalidate();
    return t('nodeRemoved', { name: found.name });
  }

  const byRecent = <T extends { lastReinforcedAt: number }>(a: T, b: T) => b.lastReinforcedAt - a.lastReinforcedAt;
  const rawPage = webui.definePage({
    key: 'user-relation-raw',
    title: t('rawTitle'),
    icon: 'table',
    actions: {
      deletePerson: {
        label: t('deleteLabel'),
        effect: 'destructive',
        confirm: t('deletePersonConfirm'),
        row: true,
        handler({ rowKey }) {
          const sep = rowKey.indexOf(':');
          return removeNode(rowKey, 'person', () => service.deletePerson(rowKey.slice(0, sep), rowKey.slice(sep + 1)));
        },
      },
      deleteEvent: {
        label: t('deleteLabel'),
        effect: 'destructive',
        confirm: t('deleteEventConfirm'),
        row: true,
        handler: ({ rowKey }) => removeNode(rowKey, 'event', () => service.deleteEvent(rowKey)),
      },
      deleteEntity: {
        label: t('deleteLabel'),
        effect: 'destructive',
        confirm: t('deleteEntityConfirm'),
        row: true,
        handler: ({ rowKey }) => removeNode(rowKey, 'entity', () => service.deleteEntity(rowKey)),
      },
    },
    content: {
      tabs: [
        {
          key: 'persons',
          title: t('persons'),
          content: [
            {
              type: 'table',
              id: 'persons',
              rowKey: 'id',
              empty: t('personsEmpty'),
              columns: [
                { key: 'displayName', label: t('columnDisplayName'), primary: true },
                { key: 'platform', label: t('columnPlatform') },
                { key: 'userId', label: t('columnUserId'), kind: 'code' },
                { key: 'firstSeenAt', label: t('columnFirstSeen'), kind: 'time' },
                { key: 'lastSeenAt', label: t('columnLastSeen'), kind: 'time', primary: true },
              ],
              rowActions: [{ action: 'deletePerson' }],
              data: async (): Promise<TableRow[]> =>
                (await service.loadAll()).persons
                  .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
                  .map(p => ({
                    id: p.id,
                    displayName: p.displayName ?? '',
                    platform: p.platform,
                    userId: p.userId,
                    firstSeenAt: p.firstSeenAt,
                    lastSeenAt: p.lastSeenAt,
                  })),
            },
          ],
        },
        {
          key: 'events',
          title: t('events'),
          content: [
            {
              type: 'table',
              id: 'events',
              rowKey: 'id',
              empty: t('eventsEmpty'),
              columns: [
                { key: 'title', label: t('columnTitle'), primary: true },
                { key: 'category', label: t('columnCategory') },
                { key: 'sessionScope', label: t('columnSession') },
                { key: 'summary', label: t('columnSummary'), kind: 'long-text' },
                { key: 'evidence', label: t('columnLatestEvidence'), kind: 'long-text' },
                { key: 'evidenceCount', label: t('columnEvidenceCount') },
                { key: 'lastReinforcedAt', label: t('columnLastReinforced'), kind: 'time', primary: true },
              ],
              rowActions: [{ action: 'deleteEvent' }],
              data: async (): Promise<TableRow[]> =>
                (await service.loadAll()).events.sort(byRecent).map(e => ({
                  id: e.id,
                  title: e.title,
                  category: e.category ? nameIn(EVENT_CATEGORY_NAMES, e.category) : '',
                  sessionScope: e.sessionScope,
                  summary: e.summary ?? '',
                  evidence: previewEvidence(e),
                  evidenceCount: e.evidence.length,
                  lastReinforcedAt: e.lastReinforcedAt,
                })),
            },
          ],
        },
        {
          key: 'entities',
          title: t('entities'),
          content: [
            {
              type: 'table',
              id: 'entities',
              rowKey: 'id',
              empty: t('entitiesEmpty'),
              columns: [
                { key: 'name', label: t('columnName'), primary: true },
                { key: 'entityKind', label: t('columnType') },
                { key: 'aliases', label: t('columnAliases'), kind: 'long-text' },
                { key: 'summary', label: t('columnSummary'), kind: 'long-text' },
                { key: 'evidenceCount', label: t('columnEvidenceCount') },
                { key: 'lastReinforcedAt', label: t('columnLastReinforced'), kind: 'time', primary: true },
              ],
              rowActions: [{ action: 'deleteEntity' }],
              data: async (): Promise<TableRow[]> =>
                (await service.loadAll()).entities.sort(byRecent).map(e => ({
                  id: e.id,
                  name: e.name,
                  entityKind: nameIn(ENTITY_KIND_NAMES, e.entityKind),
                  aliases: t('aliasList', { aliases: e.aliases ?? [] }),
                  summary: e.summary ?? '',
                  evidenceCount: e.evidence.length,
                  lastReinforcedAt: e.lastReinforcedAt,
                })),
            },
          ],
        },
      ],
    },
  });
}
