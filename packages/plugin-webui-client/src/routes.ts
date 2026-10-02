import { useParams } from 'react-router';

// 地址表：当前会话、右侧面板的标签与房间表的组都由地址决定，能收藏、能刷新，浏览器后退按地址逐层退回

/** 会话右侧面板的标签 */
const SESSION_TABS = ['plan', 'settings', 'usage'] as const;
export type SessionTab = (typeof SESSION_TABS)[number];

/** 路由的写法，路由表照它登记 */
export const routes = {
  home: '/',
  newSession: '/new',
  session: '/s/:sessionId',
  sessionTab: '/s/:sessionId/:tab',
  rooms: '/rooms',
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

export const paths = {
  home: routes.home,
  newSession: routes.newSession,
  session: (sessionId: string, tab?: SessionTab) => `/s/${encodeURIComponent(sessionId)}${tab ? `/${tab}` : ''}`,
  rooms: (group: RoomGroupAddress) => `/rooms?${new URLSearchParams(group)}`,
};

/** 地址上的当前会话与右侧面板标签；不在会话地址上时为 undefined，认不出的标签当作没有 */
export function useSessionAddress(): { sessionId: string; tab?: SessionTab } | undefined {
  const { sessionId, tab } = useParams();
  if (sessionId === undefined) return undefined;
  return { sessionId, tab: SESSION_TABS.find(known => known === tab) };
}
