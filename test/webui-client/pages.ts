import {
  type DeclarativePageView,
  type FramePageView,
  HOST_PANEL_TABS,
  type HostPanelTab,
  type LayoutOperation,
  type LayoutRecords,
  type PageRef,
  type PageView,
  type PanelTabRef,
} from '../../packages/api-webui/src/index.js';
import type { FakeRequest } from './harness.js';

// 页面用例的页面表、布局记录与取数路径。页面声明是界面从 GET /api/pages 拿到的样子（函数已去掉）

/** 计划任务页：带实例后缀（多实例插件），最外层一块概况、一张带详情的表与一组页面动作 */
export const JOBS: DeclarativePageView = {
  instance: 'zz-jobs:night',
  key: 'jobs',
  title: '计划',
  icon: 'clock',
  placement: 'plugin',
  actions: {
    create: {
      label: '新建',
      effect: 'write',
      input: {
        name: { type: 'string', label: '名称', required: true },
        every: { type: 'number', label: '间隔（秒）', integer: true, description: '不小于 5' },
        mode: {
          type: 'select',
          label: '方式',
          options: [
            { label: '周期', value: 'cron' },
            { label: '一次', value: 'once' },
          ],
        },
        enabled: { type: 'boolean', label: '启用', default: true },
        tags: { type: 'list', label: '标签' },
      },
    },
    edit: {
      label: '编辑',
      effect: 'write',
      row: true,
      input: { every: { type: 'number', label: '间隔（秒）' }, note: { type: 'textarea', label: '备注' } },
    },
    run: { label: '执行', effect: 'write', row: true },
    pause: { label: '暂停', effect: 'write', row: true },
    remove: { label: '删除', effect: 'destructive', row: true, confirm: '删除这个任务？删除后不能恢复。' },
    purge: { label: '清空', effect: 'destructive' },
  },
  content: [
    { type: 'info', id: 'summary', label: '概况' },
    {
      type: 'table',
      id: 'list',
      rowKey: 'name',
      empty: '还没有任务',
      columns: [
        { key: 'name', label: '名称', primary: true },
        { key: 'every', label: '间隔' },
        { key: 'status', label: '状态', kind: 'status', primary: true },
      ],
      rowActions: [
        { action: 'run' },
        { action: 'pause', visibleWhen: 'pausable' },
        { action: 'edit' },
        { action: 'remove' },
      ],
      detail: [
        { type: 'markdown', id: 'log', label: '日志' },
        { type: 'actions', actions: ['run'] },
      ],
    },
    { type: 'actions', actions: ['create', 'purge'] },
  ],
};

export const JOB_ROWS = [
  { name: '周报', every: 3600, status: { text: '就绪' }, pausable: true, note: '每周一' },
  { name: '备份', every: 60, status: { text: '执行中', state: 'running' }, pausable: false },
];

/** 带标签的页面：两个标签，第二个是关系图 */
export const GRAPH: DeclarativePageView = {
  instance: 'zz-graph',
  key: 'graph',
  title: '关系',
  icon: 'not-a-lucide-icon',
  placement: 'plugin',
  content: {
    tabs: [
      { key: 'notes', title: '说明', content: [{ type: 'markdown', id: 'about' }] },
      {
        key: 'map',
        title: '图',
        content: [
          {
            type: 'graph',
            id: 'map',
            empty: '还没有关系',
            nodeKinds: [
              { kind: 'person', label: '人物', tone: 1 },
              { kind: 'event', label: '事件', tone: 3 },
              { kind: 'thing', label: '实体', tone: 4 },
            ],
            edgeKinds: [
              { kind: 'knows', label: '认识', tone: 2 },
              { kind: 'likes', label: '喜欢', tone: 5 },
            ],
            detail: [{ type: 'info', id: 'node' }],
          },
        ],
      },
    ],
  },
};

/** 设置里的一节：不能固定，不出现在 /p/ 下 */
export const SETTINGS_PAGE: DeclarativePageView = {
  instance: 'zz-auth',
  key: 'auth',
  title: '权限',
  placement: 'settings',
  content: [{ type: 'markdown', id: 'about' }],
};

/** 会话面板：笔记，行动作删除 */
export const NOTES: DeclarativePageView = {
  instance: 'zz-notes',
  key: 'notes',
  title: '笔记',
  icon: 'notebook',
  placement: 'session',
  actions: { drop: { label: '删除', effect: 'destructive', row: true } },
  content: [
    {
      type: 'table',
      id: 'notes',
      rowKey: 'id',
      columns: [{ key: 'text', label: '内容', primary: true }],
      rowActions: [{ action: 'drop' }],
    },
  ],
};

/** 另一个会话面板：只在一部分会话适用 */
export const FILES: DeclarativePageView = {
  instance: 'zz-files',
  key: 'files',
  title: '上传的文件',
  placement: 'session',
  content: [{ type: 'table', id: 'files', rowKey: 'name', columns: [{ key: 'name', label: '名称', primary: true }] }],
};

/** 插件前端：插件页面，一个 write 动作与一个带输入的 destructive 动作，没申请宿主数据能力 */
export const BOARD: FramePageView = {
  instance: 'zz-board',
  key: 'board',
  title: '看板',
  icon: 'layout-grid',
  placement: 'plugin',
  frame: { src: '/frames/tok-board/index.html', host: [] },
  actions: {
    archive: { label: '归档', effect: 'write', input: { id: { type: 'string', label: '卡片', required: true } } },
    purge: {
      label: '清空',
      effect: 'destructive',
      confirm: '清空后不能恢复。',
      input: {
        list: {
          type: 'select',
          label: '列表',
          options: [
            { label: '待办', value: 'todo' },
            { label: '完成', value: 'done' },
          ],
        },
        note: { type: 'string', label: '备注' },
      },
    },
  },
};

/** 插件前端：会话面板，申请了两种宿主数据能力 */
export const ROSTER: FramePageView = {
  instance: 'zz-roster',
  key: 'roster',
  title: '子会话',
  placement: 'session',
  frame: { src: '/frames/tok-roster/index.html', host: ['sessions:read', 'turn:abort'] },
  actions: { mark: { label: '标记', effect: 'write' } },
};

export const refOf = (page: PageView): PageRef => ({ instance: page.instance, pageKey: page.key });

/** 页面地址 */
export const pagePath = (page: PageView) => `/p/${encodeURIComponent(page.instance)}/${encodeURIComponent(page.key)}`;

/** 取数路径：路径段与查询串的写法照 api-webui 的路由约定 */
export function dataPath(page: PageView, componentId: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return `/api/pages/${encodeURIComponent(page.instance)}/${encodeURIComponent(page.key)}/data/${encodeURIComponent(componentId)}${search ? `?${search}` : ''}`;
}

export const actionPath = (page: PageView, action: string) =>
  `/api/pages/${encodeURIComponent(page.instance)}/${encodeURIComponent(page.key)}/actions/${encodeURIComponent(action)}`;

/** 取数的回应 */
export const data = (value: unknown) => ({ data: value });

/** 会话面板标签的一条记录：宿主标签与插件页面 */
export const hostTab = (host: HostPanelTab, open = true) => ({ tab: { host }, open });
export const pageTab = (page: PageView, open = true) => ({ tab: refOf(page), open });

/** 新记录的会话面板标签：宿主的标签都开着 */
export const hostTabs = () => HOST_PANEL_TABS.map(host => hostTab(host));

const sameTab = (a: PanelTabRef) => (b: PanelTabRef) =>
  'host' in a
    ? 'host' in b && a.host === b.host
    : !('host' in b) && a.instance === b.instance && a.pageKey === b.pageKey;

/** 布局记录：GET 回现在的记录，POST 按操作改了再回，像服务端那样（只做界面发得出的固定、取消、打开与关闭标签） */
export function layoutStore(initial: Partial<LayoutRecords> = {}) {
  const records: LayoutRecords = { pinned: [], panelTabs: hostTabs(), ...initial };
  return {
    records,
    route({ method, body }: FakeRequest): LayoutRecords {
      if (method === 'GET') return records;
      const operation = body as LayoutOperation;
      if ('page' in operation) {
        const at = records.pinned.findIndex(sameTab(operation.page));
        if (operation.op === 'pin' && at < 0) records.pinned.push(operation.page);
        if (operation.op === 'unpin' && at >= 0) records.pinned.splice(at, 1);
        return records;
      }
      const open = operation.op === 'open-tab';
      const entry = records.panelTabs.find(({ tab }) => sameTab(tab)(operation.tab));
      if (entry) entry.open = open;
      else if (open) records.panelTabs.push({ tab: operation.tab, open });
      return records;
    },
  };
}
