import type { LayoutOperation, LayoutRecords, PageRef, PageView } from '@aalis/api-webui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from 'react';
import { useConnection } from '../connection';
import { isRecord, postJson, useJson } from '../rest';

// 插件登记的页面与 owner 的布局记录（固定的页面、会话面板的标签）：整页各取一份，页面表在插件登记表变了（plugins.changed）、
// 布局记录在别处改了（layout.changed）时重取，管理连接重连后两样都重取

interface Pages {
  /** 登记着的页面，按位置内的先后排好；没取到之前为 undefined，重取失败时留着上一次的 */
  pages?: readonly PageView[];
  /** 最近一次取页面表失败的原因 */
  pagesError?: Error;
  layout?: LayoutRecords;
  /** 最近一次取布局记录失败的原因 */
  layoutError?: Error;
  /** 重取页面表与布局记录 */
  retry(): void;
  /** 改布局记录：按操作写入，写不进去时抛错 */
  changeLayout(operation: LayoutOperation): Promise<void>;
}

const Context = createContext<Pages | undefined>(undefined);

export function usePages(): Pages {
  const pages = useContext(Context);
  if (!pages) throw new Error('只能在 PagesProvider 里取页面');
  return pages;
}

export const sameRef = (a: PageRef) => (b: PageRef) => a.instance === b.instance && a.pageKey === b.pageKey;

export const refOf = (page: PageView): PageRef => ({ instance: page.instance, pageKey: page.key });

/** 实例 id 第一个「:」之后是实例名；插件的第一个实例没有 */
export const instanceName = (instance: string): string | undefined => {
  const at = instance.indexOf(':');
  return at < 0 ? undefined : instance.slice(at + 1);
};

/** 页面在图标栏、菜单与标签上的名字：多实例插件的页面后面带实例名 */
export const pageName = (page: PageView): string => {
  const name = instanceName(page.instance);
  return name === undefined ? page.title : `${page.title} · ${name}`;
};

function parsePages(body: unknown): PageView[] {
  if (!isRecord(body) || !Array.isArray(body.pages)) throw new Error('页面表的回应不是预期的形状');
  return body.pages as PageView[];
}

function parseLayout(body: unknown): LayoutRecords {
  if (!isRecord(body) || !Array.isArray(body.pinned) || !Array.isArray(body.panelTabs)) {
    throw new Error('布局记录的回应不是预期的形状');
  }
  return { pinned: body.pinned, panelTabs: body.panelTabs };
}

export function PagesProvider({ children }: { children: ReactNode }) {
  const { admin } = useConnection();
  const [pagesVersion, reloadPages] = useReducer((n: number) => n + 1, 0);
  const [layoutVersion, reloadLayout] = useReducer((n: number) => n + 1, 0);
  const pages = useJson('/api/pages', parsePages, pagesVersion);
  const fetched = useJson('/api/layout', parseLayout, layoutVersion);
  // 自己改了的记录先用写入的回应，直到取回比它新的
  const [written, setWritten] = useState<{ base?: LayoutRecords; layout: LayoutRecords }>();

  useEffect(() => {
    const offs = [
      admin.on('plugins.changed', reloadPages),
      admin.on('layout.changed', reloadLayout),
      admin.onReconnect(() => {
        reloadPages();
        reloadLayout();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [admin]);

  const base = fetched.value;
  const changeLayout = useCallback(
    async (operation: LayoutOperation) => {
      const layout = parseLayout(await postJson('/api/layout', operation));
      setWritten({ base, layout });
    },
    [base],
  );

  const retry = useCallback(() => {
    reloadPages();
    reloadLayout();
  }, []);

  const layout = written && written.base === base ? written.layout : base;
  const value = useMemo<Pages>(
    () => ({
      pages: pages.value,
      pagesError: pages.error,
      layout,
      layoutError: fetched.error,
      retry,
      changeLayout,
    }),
    [pages.value, pages.error, layout, fetched.error, retry, changeLayout],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
