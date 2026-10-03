import { HOST_PANEL_TABS, type HostPanelTab, type PageRef } from '@aalis/api-webui';
import { matchPath, useParams } from 'react-router';

// 地址表：当前会话、右侧面板的标签、房间表的组、打开的页面与插件详情都由地址决定，能收藏、能刷新，浏览器后退按地址逐层退回

/** 路由的写法，路由表照它登记 */
export const routes = {
  home: '/',
  newSession: '/new',
  session: '/s/:sessionId',
  sessionTab: '/s/:sessionId/:tab',
  sessionPanel: '/s/:sessionId/p/:instance/:pageKey',
  rooms: '/rooms',
  page: '/p/:instance/:pageKey',
  plugins: '/plugins',
  market: '/market',
  plugin: '/plugins/:instance',
  settings: '/settings',
  settingsSection: '/settings/:section',
  settingsPage: '/settings/p/:instance/:pageKey',
} as const;

/** 房间表的一组：按适配器实例取；还没记下实例的房间按平台成一组 */
export type RoomGroupAddress = { instance: string } | { platform: string };

/** 带实例与平台的东西（组、会话、地址）所在的组 */
type Grouped = { instance?: string; platform?: string };

export const addressOf = (group: { instance?: string; platform: string }): RoomGroupAddress =>
  group.instance === undefined ? { platform: group.platform } : { instance: group.instance };

/** 在不在这一组：有实例的按实例比，没记下实例的按平台比 */
export const inGroup = (item: Grouped, group: RoomGroupAddress): boolean =>
  'instance' in group
    ? item.instance === group.instance
    : item.instance === undefined && item.platform === group.platform;

/** 地址栏里的组：先看 instance，再看 platform */
export function groupFromParams(params: URLSearchParams): RoomGroupAddress | undefined {
  const instance = params.get('instance');
  if (instance !== null) return { instance };
  const platform = params.get('platform');
  return platform === null ? undefined : { platform };
}

const pageSegments = (ref: PageRef) => `${encodeURIComponent(ref.instance)}/${encodeURIComponent(ref.pageKey)}`;

export const paths = {
  home: routes.home,
  newSession: routes.newSession,
  session: (sessionId: string, tab?: HostPanelTab) => `/s/${encodeURIComponent(sessionId)}${tab ? `/${tab}` : ''}`,
  sessionPanel: (sessionId: string, ref: PageRef) => `/s/${encodeURIComponent(sessionId)}/p/${pageSegments(ref)}`,
  rooms: (group: RoomGroupAddress) => `/rooms?${new URLSearchParams(group)}`,
  page: (ref: PageRef) => `/p/${pageSegments(ref)}`,
  plugins: routes.plugins,
  market: routes.market,
  /** 插件详情；给 section 时落在那一块（配置区是 config） */
  plugin: (instance: string, section?: 'config') =>
    `/plugins/${encodeURIComponent(instance)}${section ? `#${section}` : ''}`,
  settings: routes.settings,
  /** 设置里宿主自己的一节 */
  settingsSection: (section: string) => `/settings/${section}`,
  /** 位置为设置的页面：设置里插件的一节 */
  settingsPage: (ref: PageRef) => `/settings/p/${pageSegments(ref)}`,
};

/** 地址上打开着的页面（位置为插件详情的）；不在页面地址上时为 undefined */
export function pageAt(pathname: string): PageRef | undefined {
  const params = matchPath(routes.page, pathname)?.params;
  if (params?.instance === undefined || params.pageKey === undefined) return undefined;
  return { instance: decodeURIComponent(params.instance), pageKey: decodeURIComponent(params.pageKey) };
}

/**
 * 地址上的当前会话与右侧面板的标签：宿主的标签或一个会话面板页面。不在会话地址上时为 undefined，认不出的标签当作没有
 */
export function useSessionAddress(): { sessionId: string; tab?: HostPanelTab; panel?: PageRef } | undefined {
  const { sessionId, tab, instance, pageKey } = useParams();
  if (sessionId === undefined) return undefined;
  if (instance !== undefined && pageKey !== undefined) return { sessionId, panel: { instance, pageKey } };
  return { sessionId, tab: HOST_PANEL_TABS.find(known => known === tab) };
}
