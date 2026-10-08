import {
  HOST_PANEL_TABS,
  type HostPanelTab,
  type LayoutRecords,
  type PageRef,
  type PageView,
  type PanelTabRef,
} from '@aalis/api-webui';
import { useEffect, useReducer, useRef } from 'react';
import { type NavigateOptions, useNavigate } from 'react-router';
import { useBack } from '../back';
import { useToast } from '../components/Toast';
import { useConnection } from '../connection';
import { pageName, refOf, sameRef, usePages } from '../pages/registry';
import { useHost } from '../plugins/list';
import { isRecord, useJson } from '../rest';
import { paths } from '../routes';
import { usePhone } from '../shell/Shell';
import type { PlanItem, UsageItem } from './live-session';

// 会话右侧面板的标签：宿主的标签与插件的会话面板走同一张表（布局记录的 panelTabs，按 owner 排的顺序、各带开关），
// 由一个合成函数按「此刻可用」排成标签栏与「+」。宿主标签按数据出现；插件标签要这个会话适用，适用与否由 webui-server
// 按会话算好，插件启停、会话面板页面带本会话或不带会话的 page.invalidate、管理连接重连后重取

interface HostData {
  plan?: PlanItem;
  usage?: UsageItem;
  /** 有子会话，或这个会话有后台任务（含保留着的结束的） */
  background: boolean;
  phone: boolean;
}

/** 宿主的标签：名字，与此刻可不可用 */
const HOST_TABS: Record<HostPanelTab, { title: string; available(data: HostData): boolean }> = {
  plan: { title: '计划', available: ({ plan }) => plan !== undefined && plan.entries.length > 0 },
  settings: { title: '设置', available: () => true },
  // 手机上用量从会话头的百分比打开底部抽屉
  usage: { title: '用量', available: ({ usage, phone }) => usage !== undefined && !phone },
  background: { title: '后台', available: ({ background }) => background },
};

/** 宿主标签的名字；前端还不认识的宿主标签（webui-server 比前端新）没有 */
export const hostTabTitle = (host: string): string | undefined =>
  Object.hasOwn(HOST_TABS, host) ? HOST_TABS[host as HostPanelTab].title : undefined;

/** 布局记录没取到时：宿主的标签都开着 */
const NEW_RECORD: LayoutRecords['panelTabs'] = HOST_PANEL_TABS.map(host => ({ tab: { host }, open: true }));

/** 标签栏与「+」里的一项 */
interface PanelTab {
  ref: PanelTabRef;
  /** 宿主标签是它的名字，插件标签是页面的地址，两者不会重 */
  key: string;
  title: string;
  /** 插件标签的页面 */
  page?: PageView;
}

const sameTab = (a: PanelTabRef) => (b: PanelTabRef) =>
  'host' in a ? 'host' in b && a.host === b.host : !('host' in b) && sameRef(a)(b);

const pageTab = (page: PageView): PanelTab => ({
  ref: refOf(page),
  key: paths.page(refOf(page)),
  title: pageName(page),
  page,
});

/**
 * 标签栏：表里开着、此刻可用的，按表的顺序。「+」：表里关着、此刻可用的，加上适用、还不在表里的插件页面（按页面的先后）
 */
function composeTabs(
  entries: LayoutRecords['panelTabs'],
  available: (tab: HostPanelTab) => boolean,
  applicable: readonly PageView[],
): { bar: PanelTab[]; add: PanelTab[] } {
  const usable = (ref: PanelTabRef): PanelTab | undefined => {
    if (!('host' in ref)) {
      const page = applicable.find(candidate => sameRef(ref)(refOf(candidate)));
      return page && pageTab(page);
    }
    // 记录里可能有前端还不认识的宿主标签（webui-server 比前端新），当作不可用
    const title = hostTabTitle(ref.host);
    if (title === undefined || !available(ref.host)) return undefined;
    return { ref, key: ref.host, title };
  };
  const bar: PanelTab[] = [];
  const add: PanelTab[] = [];
  for (const { tab, open } of entries) {
    const found = usable(tab);
    if (found) (open ? bar : add).push(found);
  }
  for (const page of applicable) {
    if (!entries.some(({ tab }) => sameTab(tab)(refOf(page)))) add.push(pageTab(page));
  }
  return { bar, add };
}

function parseRefs(body: unknown): PageRef[] {
  if (!isRecord(body) || !Array.isArray(body.pages)) throw new Error('会话面板的回应不是预期的形状');
  return body.pages as PageRef[];
}

export interface SessionTabs {
  bar: PanelTab[];
  add: PanelTab[];
  /** 适用的页面、页面表或布局记录没取到：标签可能不全 */
  error?: Error;
  retry(): void;
  pathOf(ref: PanelTabRef): string;
  /** 切到一个标签：不在标签栏里的先打开（open-tab），写入成功再切 */
  show(ref: PanelTabRef, options?: NavigateOptions): void;
  /** 关掉一个标签，回到不带标签的会话地址（上一条历史就是它时退回去） */
  close(ref: PanelTabRef): void;
}

export function useSessionTabs(sessionId: string, data: Omit<HostData, 'phone'>): SessionTabs {
  const phone = usePhone();
  const navigate = useNavigate();
  const goBack = useBack();
  const toast = useToast();
  const host = useHost();
  const { admin } = useConnection();
  const { pages, pagesError, layout, layoutError, retry: retryPages, changeLayout } = usePages();
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const sessionPages = pages?.filter(page => page.placement === 'session');
  const latest = useRef(sessionPages);
  useEffect(() => {
    latest.current = sessionPages;
  });

  useEffect(() => {
    const offs = [
      admin.on('plugins.changed', refetch),
      admin.onReconnect(refetch),
      admin.on('page.invalidate', event => {
        if (event.sessionId !== undefined && event.sessionId !== sessionId) return;
        if (latest.current?.some(page => page.instance === event.instance && page.key === event.pageKey)) refetch();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [admin, sessionId]);

  const applicable = useJson(`/api/session-pages?${new URLSearchParams({ sessionId })}`, parseRefs, version);
  const { bar, add } = composeTabs(
    layout?.panelTabs ?? NEW_RECORD,
    tab => HOST_TABS[tab].available({ ...data, phone }),
    (sessionPages ?? []).filter(page => applicable.value?.some(sameRef(refOf(page)))),
  );

  // 写入回来之前可能已经切到别的会话（工作台随之卸载），那时不再跳转
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const change = (op: 'open-tab' | 'close-tab', tab: PanelTabRef, then: () => void) =>
    void changeLayout({ op, tab }).then(
      () => {
        if (mounted.current) then();
      },
      (err: Error) =>
        toast({ kind: 'danger', text: `${op === 'open-tab' ? '打开' : '关闭'}标签失败：${err.message}`, source: host }),
    );
  const pathOf = (ref: PanelTabRef) =>
    'host' in ref ? paths.session(sessionId, ref.host) : paths.sessionPanel(sessionId, ref);

  return {
    bar,
    add,
    error: applicable.error ?? layoutError ?? pagesError,
    retry: () => {
      refetch();
      retryPages();
    },
    pathOf,
    show(ref, options) {
      const go = () => navigate(pathOf(ref), options);
      if (bar.some(tab => sameTab(tab.ref)(ref))) go();
      else change('open-tab', ref, go);
    },
    close: ref => change('close-tab', ref, () => goBack(paths.session(sessionId))),
  };
}
