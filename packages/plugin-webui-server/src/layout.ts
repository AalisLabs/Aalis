// ============================================================
// layout.ts — owner 的界面布局记录
//
// 图标栏上固定的页面与会话面板的标签（都按 owner 排的顺序），存在本插件的插件数据里，跟着 owner 走、换设备一致。
// 不进插件配置：保存配置会重载本插件、断开会话连接。按操作写、不整份覆盖，两台设备同时改各自生效：操作排队逐个应用，
// 每个操作落盘成功才算数，落盘失败时记录不变。所属插件停用时记录保留，界面按当前的页面表决定显示哪些。
// ============================================================

import { isStorageNotFound, type OwnStorage } from '@aalis/api-storage';
import {
  HOST_PANEL_TABS,
  type LayoutOperation,
  type LayoutRecords,
  MAX_LAYOUT_ENTRIES,
  type PageRef,
  type PanelTabRef,
} from '@aalis/api-webui';
import type { Logger } from '@aalis/core';

/** 私有目录下的布局记录 */
const LAYOUT = 'layout.json';

/** 实例 id 与页面 key 的长度上限 */
const REF_MAX_LENGTH = 512;

type PinOperation = Extract<LayoutOperation, { page: PageRef }>;
type TabOperation = Extract<LayoutOperation, { tab: PanelTabRef }>;
/** 宿主标签与插件标签同一套写法的四个操作；移出只对插件标签 */
type SharedTabOperation = Exclude<TabOperation['op'], 'remove-tab'>;
type TabEntry = LayoutRecords['panelTabs'][number];

const PIN_OPERATIONS: ReadonlySet<unknown> = new Set([
  'pin',
  'unpin',
  'move-up',
  'move-down',
] satisfies PinOperation['op'][]);
const TAB_OPERATIONS: ReadonlySet<unknown> = new Set([
  'open-tab',
  'close-tab',
  'tab-up',
  'tab-down',
] satisfies SharedTabOperation[]);

/** 插件标签最多几个：宿主标签总在表里，连同它们不超过 MAX_LAYOUT_ENTRIES */
const PAGE_TABS_MAX = MAX_LAYOUT_ENTRIES - HOST_PANEL_TABS.length;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isRefPart = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= REF_MAX_LENGTH;

/** 是不是一个页面：只有 instance 与 pageKey 两个字符串 */
function isPageRef(value: unknown): value is PageRef {
  return isRecord(value) && Object.keys(value).length === 2 && isRefPart(value.instance) && isRefPart(value.pageKey);
}

/** 是不是一个标签：页面，或只有 host 一个键、认得出的宿主标签 */
function isTabRef(value: unknown): value is PanelTabRef {
  return (
    isPageRef(value) ||
    (isRecord(value) && Object.keys(value).length === 1 && HOST_PANEL_TABS.some(host => host === value.host))
  );
}

const isTabEntry = (value: unknown): value is TabEntry =>
  isRecord(value) && Object.keys(value).length === 2 && isTabRef(value.tab) && typeof value.open === 'boolean';

/** 核一个操作：固定的四个只收 op 与 page，标签的四个只收 op 与 tab，移出只收 op 与插件标签 */
export function parseLayoutOperation(value: unknown): LayoutOperation | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2) return undefined;
  if (PIN_OPERATIONS.has(value.op) && isPageRef(value.page)) {
    return { op: value.op as PinOperation['op'], page: value.page };
  }
  if (TAB_OPERATIONS.has(value.op) && isTabRef(value.tab)) {
    return { op: value.op as SharedTabOperation, tab: value.tab };
  }
  if (value.op === 'remove-tab' && isPageRef(value.tab)) return { op: 'remove-tab', tab: value.tab };
  return undefined;
}

/** 操作被拒：记录满了 */
export class LayoutFull extends Error {}

const samePage = (a: PageRef) => (b: PageRef) => a.instance === b.instance && a.pageKey === b.pageKey;
const sameTab = (a: PanelTabRef) => (b: PanelTabRef) =>
  'host' in a ? 'host' in b && a.host === b.host : !('host' in b) && samePage(a)(b);

/** 与前一个或后一个对调；不在表里或已到头时回原数组 */
function swapped<T>(entries: T[], at: number, step: -1 | 1): T[] {
  const to = at + step;
  if (at < 0 || to < 0 || to >= entries.length) return entries;
  const next = [...entries];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

function pinnedAfter(pinned: PageRef[], { op, page }: PinOperation): PageRef[] {
  const at = pinned.findIndex(samePage(page));
  if (op === 'pin') {
    if (at >= 0) return pinned;
    if (pinned.length >= MAX_LAYOUT_ENTRIES) throw new LayoutFull(`最多 ${MAX_LAYOUT_ENTRIES} 条，先取消一些`);
    return [...pinned, page];
  }
  if (op === 'unpin') return at < 0 ? pinned : pinned.filter((_, i) => i !== at);
  return swapped(pinned, at, op === 'move-up' ? -1 : 1);
}

/** 打开与关闭只改开关、位置不动；插件标签第一次打开时追加在末尾，没打开过的关了也不进表；移出删掉这一条 */
function tabsAfter(tabs: TabEntry[], { op, tab }: TabOperation): TabEntry[] {
  const at = tabs.findIndex(entry => sameTab(entry.tab)(tab));
  if (op === 'remove-tab') return at < 0 ? tabs : tabs.filter((_, i) => i !== at);
  if (op === 'tab-up' || op === 'tab-down') return swapped(tabs, at, op === 'tab-up' ? -1 : 1);
  const open = op === 'open-tab';
  if (at >= 0) return tabs[at].open === open ? tabs : tabs.map((entry, i) => (i === at ? { ...entry, open } : entry));
  if (!open) return tabs;
  if (tabs.length >= MAX_LAYOUT_ENTRIES) throw new LayoutFull(`会话面板最多记 ${MAX_LAYOUT_ENTRIES} 个标签`);
  return [...tabs, { tab, open }];
}

/** 应用一个操作，回新的记录；没有变化时回原对象 */
function applied(records: LayoutRecords, operation: LayoutOperation): LayoutRecords {
  if ('page' in operation) {
    const pinned = pinnedAfter(records.pinned, operation);
    return pinned === records.pinned ? records : { ...records, pinned };
  }
  const panelTabs = tabsAfter(records.panelTabs, operation);
  return panelTabs === records.panelTabs ? records : { ...records, panelTabs };
}

/** 文件里读出的固定页面：留下形状对的、不重复的，最多 MAX_LAYOUT_ENTRIES 条 */
function pinnedOf(value: unknown): PageRef[] {
  const out: PageRef[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (isPageRef(entry) && !out.some(samePage(entry)) && out.length < MAX_LAYOUT_ENTRIES) out.push(entry);
  }
  return out;
}

/**
 * 文件里读出的会话面板标签：留下形状对的、不重复的，插件标签最多 PAGE_TABS_MAX 个，认不出的宿主标签按形状不对丢掉；
 * 缺的宿主标签按宿主的顺序补在末尾、开着，新加的宿主标签因此对已有的记录也出现
 */
function panelTabsOf(value: unknown): TabEntry[] {
  const out: TabEntry[] = [];
  let pages = 0;
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isTabEntry(entry) || out.some(kept => sameTab(kept.tab)(entry.tab))) continue;
    if ('host' in entry.tab) out.push(entry);
    else if (pages < PAGE_TABS_MAX) {
      pages++;
      out.push(entry);
    }
  }
  for (const host of HOST_PANEL_TABS) {
    if (!out.some(kept => sameTab(kept.tab)({ host }))) out.push({ tab: { host }, open: true });
  }
  return out;
}

/** 文件里的记录：只读 pinned 与 panelTabs，别的键不认 */
const recordsOf = (parsed: Record<string, unknown>): LayoutRecords => ({
  pinned: pinnedOf(parsed.pinned),
  panelTabs: panelTabsOf(parsed.panelTabs),
});

export function createLayoutStore(storage: Pick<OwnStorage, 'readFile' | 'writeFile' | 'uri'>, logger: Logger) {
  let records: LayoutRecords | undefined;
  let loading: Promise<LayoutRecords> | undefined;
  /** 操作排队：后一个在前一个落盘之后、基于它的结果应用 */
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * 读出记录。文件不存在按没有记录起步；内容坏了告警后同样从空起步，下次操作时覆盖。读不出来（权限、存储不可用）直接抛出、
   * 下次再读：照空表落盘会覆盖原有记录
   */
  async function load(): Promise<LayoutRecords> {
    let text: string | undefined;
    try {
      text = String(await storage.readFile(LAYOUT, 'utf8'));
    } catch (err) {
      if (!isStorageNotFound(err)) throw err;
    }
    if (text === undefined) return recordsOf({});
    try {
      return recordsOf(JSON.parse(text) as Record<string, unknown>);
    } catch (err) {
      logger.warn(`布局记录 ${storage.uri(LAYOUT)} 读不懂，按没有记录起步，下次改动时覆盖:`, err);
      return recordsOf({});
    }
  }

  function current(): Promise<LayoutRecords> {
    if (records) return Promise.resolve(records);
    loading ??= load().then(
      loaded => (records = loaded),
      err => {
        loading = undefined;
        throw err;
      },
    );
    return loading;
  }

  return {
    read: current,

    /** 应用一个操作并落盘，回改后的记录与有没有变化；记录满了抛 {@link LayoutFull}，落盘失败照原样抛出、记录不变 */
    apply(operation: LayoutOperation): Promise<{ records: LayoutRecords; changed: boolean }> {
      const run = queue.then(async () => {
        const before = await current();
        const after = applied(before, operation);
        if (after === before) return { records: before, changed: false };
        await storage.writeFile(LAYOUT, JSON.stringify(after));
        records = after;
        return { records: after, changed: true };
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

export type LayoutStore = ReturnType<typeof createLayoutStore>;
