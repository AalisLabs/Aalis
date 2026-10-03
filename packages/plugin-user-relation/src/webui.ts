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
import type { RelationService } from './service.js';
import type { EntityNode, EventNode, PersonNode, RelationEdge } from './types.js';
import { edgeEndpoints } from './utils.js';

/** 关系类型 → 中文显示（不影响存储里的英文 key） */
const RELATION_LABEL_ZH: Record<string, string> = {
  // person-event role
  initiator: '发起者',
  participant: '参与者',
  witness: '旁观者',
  target: '被指向',
  reporter: '转述者',
  // person-entity role
  enthusiast: '爱好者',
  owner: '拥有者',
  creator: '创作者',
  critic: '批评者',
  visitor: '访客',
  mentioned: '仅提及',
  // person-person relation
  friend: '朋友',
  cp: 'CP',
  rival: '对手',
  mentor: '师徒',
  colleague: '同事',
  familiar: '熟人',
  antagonist: '对头',
  admirer: '仰慕者',
  // event-event relation
  'caused-by': '因→果',
  follows: '随后',
  'part-of': '属于',
  related: '相关',
  // event-entity relation
  about: '关于',
  uses: '使用',
  'located-at': '位于',
  produced: '产出',
  // entity-entity relation
  contains: '包含',
  'variant-of': '变体',
  opposite: '对立',
};

const labelZh = (raw: string) => RELATION_LABEL_ZH[raw] ?? raw;

/** 边上的关系：人物对事件、实体是角色，其余是关系类型 */
const edgeLabel = (edge: RelationEdge) =>
  labelZh(edge.kind === 'person-event' || edge.kind === 'person-entity' ? edge.role : edge.relationType);

function previewEvidence(item: RelationEdge | EventNode | EntityNode): string {
  if (item.evidence.length === 0) return '';
  const recent = [...item.evidence].sort((a, b) => b.extractedAt - a.extractedAt)[0];
  return recent.quote ?? `${recent.messageIds.length} 条证据`;
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const personLabel = (person: PersonNode) => person.displayName?.trim() || person.userId;

const NODE_KINDS = [
  { kind: 'person', label: '人物', tone: 1 },
  { kind: 'event', label: '事件', tone: 2 },
  { kind: 'entity', label: '实体', tone: 3 },
] as const;
const EDGE_KINDS = [
  { kind: 'person-person', label: '人物之间', tone: 1 },
  { kind: 'person-event', label: '人物与事件', tone: 2 },
  { kind: 'person-entity', label: '人物与实体', tone: 3 },
  { kind: 'event-event', label: '事件之间', tone: 4 },
  { kind: 'event-entity', label: '事件与实体', tone: 5 },
  { kind: 'entity-entity', label: '实体之间', tone: 6 },
] as const;

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
    if (!node) throw new Error(`关系图里没有节点 ${id}`);
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
        { label: '种类', value: '人物' },
        { label: '显示名', value: node.displayName ?? '' },
        { label: '平台', value: node.platform },
        { label: '用户 ID', value: node.userId, kind: 'code' },
        { label: '首次出现', value: node.firstSeenAt, kind: 'time' },
        { label: '最近活跃', value: node.lastSeenAt, kind: 'time' },
        { label: '被提及次数', value: node.mentionCount },
      ];
    }
    const common: InfoItem[] = [
      { label: '摘要', value: node.summary ?? '', kind: 'long-text' },
      { label: '证据数', value: node.evidence.length },
      { label: '最近强化', value: node.lastReinforcedAt, kind: 'time' },
    ];
    if ('title' in node) {
      return [
        { label: '种类', value: '事件' },
        { label: '标题', value: node.title },
        { label: '类别', value: node.category ?? '' },
        { label: '会话', value: node.sessionScope },
        ...common,
      ];
    }
    return [
      { label: '种类', value: '实体' },
      { label: '名称', value: node.name },
      { label: '类型', value: node.entityKind },
      { label: '别名', value: (node.aliases ?? []).join('、') },
      ...common,
    ];
  }

  const graphPage = webui.definePage({
    key: 'user-relation',
    title: '人物关系图',
    icon: 'share-2',
    content: [
      {
        type: 'graph',
        id: 'graph',
        description: '点一个节点看它的属性与关系；原始数据与删除在「关系图原始数据」页。',
        empty: '关系图还是空的',
        nodeKinds: [...NODE_KINDS],
        edgeKinds: [...EDGE_KINDS],
        spacing,
        data: graph,
        detail: [
          { type: 'info', id: 'node', data: async ({ rowKey }) => nodeInfo((await nodeDetail(rowKey)).node) },
          {
            type: 'table',
            id: 'relations',
            label: '关系',
            rowKey: 'id',
            empty: '没有连着它的关系',
            columns: [
              { key: 'other', label: '对端', primary: true },
              { key: 'relation', label: '关系', primary: true },
              { key: 'weight', label: '权重' },
              { key: 'lastReinforcedAt', label: '最近强化', kind: 'time' },
              { key: 'evidence', label: '最新证据', kind: 'long-text' },
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

  /** 删除前先核节点在且种类对：删除本身对不存在的节点什么也不做，不核就会把扑空当成成功 */
  async function removeNode(id: string, kind: 'person' | 'event' | 'entity', remove: () => Promise<unknown>) {
    const found = await service.findNodeById(id);
    if (found?.kind !== kind) throw new Error(`没有这个${{ person: '人物', event: '事件', entity: '实体' }[kind]}`);
    await remove();
    rawPage.invalidate();
    graphPage.invalidate();
    return `已删除 ${found.name} 及其相关的边`;
  }

  const byRecent = <T extends { lastReinforcedAt: number }>(a: T, b: T) => b.lastReinforcedAt - a.lastReinforcedAt;
  const rawPage = webui.definePage({
    key: 'user-relation-raw',
    title: '关系图原始数据',
    icon: 'table',
    actions: {
      deletePerson: {
        label: '删除',
        effect: 'destructive',
        confirm: '删除这个人物及其所有相关的边？',
        row: true,
        handler({ rowKey }) {
          const sep = rowKey.indexOf(':');
          return removeNode(rowKey, 'person', () => service.deletePerson(rowKey.slice(0, sep), rowKey.slice(sep + 1)));
        },
      },
      deleteEvent: {
        label: '删除',
        effect: 'destructive',
        confirm: '删除这个事件及其所有相关的边？',
        row: true,
        handler: ({ rowKey }) => removeNode(rowKey, 'event', () => service.deleteEvent(rowKey)),
      },
      deleteEntity: {
        label: '删除',
        effect: 'destructive',
        confirm: '删除这个实体及其所有相关的边？',
        row: true,
        handler: ({ rowKey }) => removeNode(rowKey, 'entity', () => service.deleteEntity(rowKey)),
      },
    },
    content: {
      tabs: [
        {
          key: 'persons',
          title: '人物',
          content: [
            {
              type: 'table',
              id: 'persons',
              rowKey: 'id',
              empty: '还没有人物',
              columns: [
                { key: 'displayName', label: '显示名', primary: true },
                { key: 'platform', label: '平台' },
                { key: 'userId', label: '用户 ID', kind: 'code' },
                { key: 'firstSeenAt', label: '首次出现', kind: 'time' },
                { key: 'lastSeenAt', label: '最近活跃', kind: 'time', primary: true },
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
          title: '事件',
          content: [
            {
              type: 'table',
              id: 'events',
              rowKey: 'id',
              empty: '还没有事件',
              columns: [
                { key: 'title', label: '标题', primary: true },
                { key: 'category', label: '类别' },
                { key: 'sessionScope', label: '会话' },
                { key: 'summary', label: '摘要', kind: 'long-text' },
                { key: 'evidence', label: '最新证据', kind: 'long-text' },
                { key: 'evidenceCount', label: '证据数' },
                { key: 'lastReinforcedAt', label: '最近强化', kind: 'time', primary: true },
              ],
              rowActions: [{ action: 'deleteEvent' }],
              data: async (): Promise<TableRow[]> =>
                (await service.loadAll()).events.sort(byRecent).map(e => ({
                  id: e.id,
                  title: e.title,
                  category: e.category ?? '',
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
          title: '实体',
          content: [
            {
              type: 'table',
              id: 'entities',
              rowKey: 'id',
              empty: '还没有实体',
              columns: [
                { key: 'name', label: '名称', primary: true },
                { key: 'entityKind', label: '类型' },
                { key: 'aliases', label: '别名', kind: 'long-text' },
                { key: 'summary', label: '摘要', kind: 'long-text' },
                { key: 'evidenceCount', label: '证据数' },
                { key: 'lastReinforcedAt', label: '最近强化', kind: 'time', primary: true },
              ],
              rowActions: [{ action: 'deleteEntity' }],
              data: async (): Promise<TableRow[]> =>
                (await service.loadAll()).entities.sort(byRecent).map(e => ({
                  id: e.id,
                  name: e.name,
                  entityKind: e.entityKind,
                  aliases: (e.aliases ?? []).join('、'),
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
