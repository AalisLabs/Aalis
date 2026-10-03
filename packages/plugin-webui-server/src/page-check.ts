// ============================================================
// page-check.ts — 页面登记时的质量门槛
//
// 插件交来的页面声明在登记时整份核一遍，不过就不登记：一屏最多 MAX_SCREEN_COMPONENTS 个组件、最多 MAX_PAGE_TABS
// 个标签；标签页只在最外层，详情里的组件不再带详情；组件 id 在页面内唯一；引用的动作都存在，且行动作只放在表格行上
// 与详情里、页面动作只放在最外层与标签里；不认识的字段一律拒收（旧写法的 refresh、danger、source 等在这里就被拦下）。
// 核过的声明原样经 JSON 下发给界面，函数随序列化去掉。
// ============================================================

import {
  type ActionView,
  type CellKind,
  MAX_PAGE_TABS,
  MAX_SCREEN_COMPONENTS,
  type PageComponentDefinition,
  type PageContext,
  type PagePlacement,
} from '@aalis/api-webui';

/** 有数据源的组件 */
export type SourceComponent = Exclude<PageComponentDefinition<string, PageContext>, { type: 'actions' }>;

/** 数据源：详情里的另收 rowKey */
export interface CheckedSource {
  component: SourceComponent;
  inDetail: boolean;
}

/** 核过的动作：调用时按 row 决定收不收 rowKey，按 input 校验输入 */
export type CheckedAction = ActionView & {
  handler(args: { rowKey?: string; input?: Record<string, unknown>; ctx: PageContext }): unknown;
};

export interface CheckedPage {
  placement: PagePlacement;
  sources: Map<string, CheckedSource>;
  actions: Map<string, CheckedAction>;
}

const PLACEMENTS: ReadonlySet<string> = new Set(['plugin', 'settings', 'session']);
const EFFECTS: ReadonlySet<string> = new Set(['read', 'write', 'destructive']);
const CELL_KINDS: ReadonlySet<CellKind> = new Set<CellKind>([
  'text',
  'time',
  'countdown',
  'link',
  'status',
  'code',
  'long-text',
  'image',
  'file',
]);
/** lucide 图标名：小写字母、数字与连字符。内联 SVG 一类的标记在这里就被拒 */
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const COMMON_KEYS = ['type', 'label', 'description'];
const COMPONENT_KEYS: Record<string, string[]> = {
  table: [...COMMON_KEYS, 'id', 'rowKey', 'columns', 'empty', 'rowActions', 'detail', 'data'],
  graph: [...COMMON_KEYS, 'id', 'empty', 'nodeKinds', 'edgeKinds', 'spacing', 'detail', 'data'],
  info: [...COMMON_KEYS, 'id', 'data'],
  markdown: [...COMMON_KEYS, 'id', 'data'],
  actions: [...COMMON_KEYS, 'actions'],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** 核一份页面声明：过了回分派用的索引，不过回全部问题（每条带位置） */
export function checkPage(page: unknown): { ok: true; page: CheckedPage } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const fail = (path: string, message: string): void => {
    problems.push(path ? `${path}：${message}` : message);
  };
  const strict = (value: Record<string, unknown>, allowed: readonly string[], path: string) => {
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) fail(path ? `${path}.${key}` : key, '不认识的字段');
  };
  const optionalText = (value: unknown, path: string) => {
    if (value !== undefined && typeof value !== 'string') fail(path, '要是字符串');
  };

  if (!isRecord(page)) return { ok: false, problems: ['页面声明不是对象'] };
  strict(page, ['key', 'title', 'icon', 'placement', 'order', 'applies', 'content', 'actions'], '');
  if (!isText(page.key)) fail('key', '要是非空字符串');
  if (!isText(page.title)) fail('title', '要是非空字符串');
  if (page.icon !== undefined && !(typeof page.icon === 'string' && ICON_NAME.test(page.icon))) {
    fail('icon', '只收 lucide 图标名（小写字母、数字与连字符）');
  }
  const placement = (page.placement ?? 'plugin') as PagePlacement;
  if (!PLACEMENTS.has(placement)) fail('placement', '只有 plugin、settings、session');
  if (page.order !== undefined && !Number.isFinite(page.order)) fail('order', '要是有限的数');
  if (page.applies !== undefined) {
    if (typeof page.applies !== 'function') fail('applies', '要是函数');
    else if (placement !== 'session') fail('applies', '只给会话面板（placement 为 session）');
  }

  const actions = new Map<string, CheckedAction>();
  if (page.actions !== undefined && !isRecord(page.actions)) fail('actions', '要是对象');
  for (const [name, action] of Object.entries(isRecord(page.actions) ? page.actions : {})) {
    const path = `actions.${name}`;
    if (!isRecord(action)) {
      fail(path, '要是对象');
      continue;
    }
    strict(action, ['label', 'effect', 'confirm', 'input', 'row', 'handler'], path);
    if (!isText(action.label)) fail(`${path}.label`, '要是非空字符串');
    if (!EFFECTS.has(action.effect as string)) fail(`${path}.effect`, '只有 read、write、destructive');
    if (action.confirm !== undefined) {
      if (action.effect !== 'destructive') fail(`${path}.confirm`, '确认文案只给 destructive 的动作');
      else if (!isText(action.confirm)) fail(`${path}.confirm`, '要是非空字符串');
    }
    if (action.input !== undefined) {
      if (!isRecord(action.input) || Object.keys(action.input).length === 0) fail(`${path}.input`, '要是非空的字段表');
      else
        for (const [key, field] of Object.entries(action.input)) {
          if (!isRecord(field) || !isText(field.type) || !isText(field.label)) {
            fail(`${path}.input.${key}`, '要是带 type 与 label 的配置字段');
          }
        }
    }
    if (action.row !== undefined && typeof action.row !== 'boolean') fail(`${path}.row`, '要是布尔值');
    if (typeof action.handler !== 'function') fail(`${path}.handler`, '要是函数');
    actions.set(name, action as unknown as CheckedAction);
  }

  const sources = new Map<string, CheckedSource>();
  const referenced = (name: unknown, path: string, row: boolean) => {
    const action = typeof name === 'string' ? actions.get(name) : undefined;
    if (!action) fail(path, `引用的动作 ${String(name)} 没有声明`);
    else if ((action.row === true) !== row) {
      fail(
        path,
        row
          ? `${name} 不是行动作（row: true），不能放在表格行上或详情里`
          : `${name} 是行动作，只能放在表格行上或详情里`,
      );
    }
  };
  const kinds = (value: unknown, path: string) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) return fail(path, '要是数组');
    const seen = new Set<unknown>();
    for (const [i, kind] of value.entries()) {
      const at = `${path}[${i}]`;
      if (!isRecord(kind)) {
        fail(at, '要是对象');
        continue;
      }
      strict(kind, ['kind', 'label', 'tone'], at);
      if (!isText(kind.kind) || seen.has(kind.kind)) fail(`${at}.kind`, '要是不重复的非空字符串');
      seen.add(kind.kind);
      if (!isText(kind.label)) fail(`${at}.label`, '要是非空字符串');
      if (!Number.isInteger(kind.tone) || (kind.tone as number) < 1 || (kind.tone as number) > 6) {
        fail(`${at}.tone`, '只有 1 到 6');
      }
    }
  };

  const component = (value: unknown, path: string, inDetail: boolean) => {
    if (!isRecord(value)) return fail(path, '组件要是对象');
    const allowed = COMPONENT_KEYS[value.type as string];
    if (!allowed)
      return fail(`${path}.type`, `不认识的组件 ${String(value.type)}（只有 table、graph、info、markdown、actions）`);
    strict(value, allowed, path);
    optionalText(value.label, `${path}.label`);
    optionalText(value.description, `${path}.description`);
    if (value.type === 'actions') {
      if (!Array.isArray(value.actions) || value.actions.length === 0) return fail(`${path}.actions`, '要是非空数组');
      for (const [i, name] of value.actions.entries()) referenced(name, `${path}.actions[${i}]`, inDetail);
      return;
    }
    if (!isText(value.id)) fail(`${path}.id`, '要是非空字符串');
    else if (sources.has(value.id)) fail(`${path}.id`, `组件 id ${value.id} 重复`);
    else sources.set(value.id, { component: value as unknown as SourceComponent, inDetail });
    if (typeof value.data !== 'function') fail(`${path}.data`, '要是函数');
    if (value.type === 'table') {
      if (!isText(value.rowKey)) fail(`${path}.rowKey`, '要是非空字符串');
      optionalText(value.empty, `${path}.empty`);
      if (!Array.isArray(value.columns) || value.columns.length === 0) fail(`${path}.columns`, '要是非空数组');
      else {
        const keys = new Set<unknown>();
        for (const [i, column] of value.columns.entries()) {
          const at = `${path}.columns[${i}]`;
          if (!isRecord(column)) {
            fail(at, '要是对象');
            continue;
          }
          strict(column, ['key', 'label', 'kind', 'primary'], at);
          if (!isText(column.key) || keys.has(column.key)) fail(`${at}.key`, '要是不重复的非空字符串');
          keys.add(column.key);
          if (!isText(column.label)) fail(`${at}.label`, '要是非空字符串');
          if (column.kind !== undefined && !CELL_KINDS.has(column.kind as CellKind))
            fail(`${at}.kind`, '不认识的显示种类');
          if (column.primary !== undefined && typeof column.primary !== 'boolean') fail(`${at}.primary`, '要是布尔值');
        }
      }
      if (value.rowActions !== undefined) {
        if (!Array.isArray(value.rowActions)) fail(`${path}.rowActions`, '要是数组');
        else
          for (const [i, entry] of value.rowActions.entries()) {
            const at = `${path}.rowActions[${i}]`;
            if (!isRecord(entry)) {
              fail(at, '要是对象');
              continue;
            }
            strict(entry, ['action', 'visibleWhen'], at);
            referenced(entry.action, `${at}.action`, true);
            if (entry.visibleWhen !== undefined && !isText(entry.visibleWhen)) {
              fail(`${at}.visibleWhen`, '要是行字段名');
            }
          }
      }
    } else if (value.type === 'graph') {
      optionalText(value.empty, `${path}.empty`);
      kinds(value.nodeKinds, `${path}.nodeKinds`);
      kinds(value.edgeKinds, `${path}.edgeKinds`);
      if (value.spacing !== undefined && !(Number.isFinite(value.spacing) && (value.spacing as number) > 0)) {
        fail(`${path}.spacing`, '要是正数');
      }
    }
    if (value.detail !== undefined) {
      if (inDetail) fail(`${path}.detail`, '详情里的组件不能再带详情');
      else screen(value.detail, `${path}.detail`, true);
    }
  };

  const screen = (value: unknown, path: string, inDetail: boolean) => {
    if (!Array.isArray(value) || value.length === 0) return fail(path, '要是非空的组件数组');
    if (value.length > MAX_SCREEN_COMPONENTS) {
      fail(path, `一屏最多 ${MAX_SCREEN_COMPONENTS} 个组件，现在 ${value.length} 个`);
    }
    for (const [i, item] of value.entries()) component(item, `${path}[${i}]`, inDetail);
  };

  if (Array.isArray(page.content)) screen(page.content, 'content', false);
  else if (isRecord(page.content) && Array.isArray(page.content.tabs)) {
    strict(page.content, ['tabs'], 'content');
    const tabs = page.content.tabs;
    if (tabs.length === 0 || tabs.length > MAX_PAGE_TABS) {
      fail('content.tabs', `要有 1 到 ${MAX_PAGE_TABS} 个标签，现在 ${tabs.length} 个`);
    }
    const keys = new Set<unknown>();
    for (const [i, tab] of tabs.entries()) {
      const at = `content.tabs[${i}]`;
      if (!isRecord(tab)) {
        fail(at, '要是对象');
        continue;
      }
      strict(tab, ['key', 'title', 'content'], at);
      if (!isText(tab.key) || keys.has(tab.key)) fail(`${at}.key`, '要是不重复的非空字符串');
      keys.add(tab.key);
      if (!isText(tab.title)) fail(`${at}.title`, '要是非空字符串');
      screen(tab.content, `${at}.content`, false);
    }
  } else fail('content', '要是组件数组或 { tabs }');

  return problems.length > 0 ? { ok: false, problems } : { ok: true, page: { placement, sources, actions } };
}

/**
 * 核一条提示：open 指向的页面要是本实例已登记、位置为 plugin 或 settings 的页面。placementOf 按页面 key 取本实例页面的位置
 */
export function checkNotice(notice: unknown, placementOf: (pageKey: string) => PagePlacement | undefined): string[] {
  const problems: string[] = [];
  const fail = (path: string, message: string) => problems.push(`${path}：${message}`);
  if (!isRecord(notice)) return ['提示不是对象'];
  for (const key of Object.keys(notice)) {
    if (!['id', 'level', 'title', 'detail', 'open'].includes(key)) fail(key, '不认识的字段');
  }
  if (!isText(notice.id)) fail('id', '要是非空字符串');
  if (notice.level !== 'action' && notice.level !== 'error') fail('level', '只有 action、error');
  if (!isText(notice.title)) fail('title', '要是非空字符串');
  if (notice.detail !== undefined && typeof notice.detail !== 'string') fail('detail', '要是字符串');
  const open = notice.open;
  if (open !== undefined && open !== 'config') {
    const page = isRecord(open) && Object.keys(open).length === 1 ? open.page : undefined;
    const placement = isText(page) ? placementOf(page) : undefined;
    if (placement !== 'plugin' && placement !== 'settings') {
      fail('open', '只收 config，或本插件已登记、位置为 plugin 或 settings 的页面 { page }');
    }
  }
  return problems;
}
