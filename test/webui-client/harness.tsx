import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { expect, vi } from 'vitest';
import type {
  RoomGroup,
  SessionMethodParams,
  SessionMethodResult,
  SessionSummary,
} from '../../packages/api-session-protocol/src/index.js';
import { App } from '../../packages/plugin-webui-client/src/App.js';
import { type AdminClient, createAdminClient } from '../../packages/plugin-webui-client/src/protocol/admin-client.js';
import {
  createSessionClient,
  type SessionClient,
} from '../../packages/plugin-webui-client/src/protocol/session-client.js';
import { type FakeHandlers, FakeWebSocket } from '../helpers/fake-websocket.js';
import { hostTabs } from './pages.js';

// 整个前端连着假的会话服务渲染：会话连接上按 handlers 自动回应，管理连接只负责推事件。
// 用例在 beforeEach 里 FakeWebSocket.install() 并补上 jsdom 没有的东西，afterEach 里 close()

export const INIT: SessionMethodResult<'initialize'> = {
  protocolVersion: '1.0',
  experimental: true,
  server: { name: 'server' },
  identity: { platform: 'webui', userId: 'console' },
  surface: 'webui',
  features: { send: true, rewind: true, compress: true },
  appName: 'Aalis',
};

export function summary(id: string, fields: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: id,
    childCount: 0,
    kind: 'owner',
    section: 'owner',
    createdAt: 0,
    updatedAt: 0,
    running: false,
    error: false,
    unread: false,
    attention: false,
    archived: false,
    background: 0,
    ...fields,
  };
}

/** 插件列表（GET /api/plugins）的一行，名字取实例 id 第一个「:」之前的部分 */
export function pluginRow(instanceId: string, fields: Record<string, unknown> = {}) {
  return {
    name: instanceId.split(':')[0],
    instanceId,
    state: 'active',
    reusable: false,
    provides: [],
    requiredServices: [],
    optionalServices: [],
    missing: [],
    tools: [],
    commands: [],
    config: {},
    defaultConfig: {},
    ...fields,
  };
}

export function room(id: string, instance: string | undefined, fields: Partial<SessionSummary> = {}): SessionSummary {
  return summary(id, {
    kind: 'room',
    section: 'rooms',
    platform: 'onebot',
    instance,
    account: '10001',
    audience: 'group',
    ...fields,
  });
}

export function group(instance: string | undefined, fields: Partial<RoomGroup> = {}): RoomGroup {
  return { platform: 'onebot', instance, label: instance ?? 'onebot', rooms: 0, accounts: 1, attention: 0, ...fields };
}

type ListParams = SessionMethodParams<'sessions/list'>;

/** 假的 sessions/list：按参数取用例给的那一组，一页回完 */
export function lists(
  pick: (params: ListParams) => SessionSummary[],
  groups: RoomGroup[] = [],
): (params: ListParams) => SessionMethodResult<'sessions/list'> {
  return params => ({ sessions: pick(params), groups });
}

/** 当前会话连接的服务端一侧（重连后是新的那条） */
export const server = () => FakeWebSocket.at('/session');

/** 会话连接上发出的某个方法的参数，按先后 */
export function requests(method: string, socket = server()): unknown[] {
  return socket.frames.filter(f => f.method === method).map(f => f.params);
}

/** 发出的 sessions/list 请求的参数，按先后 */
export const listRequests = (socket?: FakeWebSocket) => requests('sessions/list', socket) as ListParams[];

/** 主区域 */
export const main = () => within(screen.getByRole('main'));

/** 会话面板里关闭选中标签的按钮（「关闭「…」」）；标签都关了时没有 */
export const panelClosers = () =>
  within(screen.getByRole('complementary', { name: '会话面板' })).queryAllByRole('button', { name: /^关闭「/ });

/** 在选择器里选一项：点开，点名字是 label 的那一项（弹层挂在 body 或所在的对话框里） */
export function choose(combobox: HTMLElement, label: string | RegExp): void {
  fireEvent.click(combobox);
  fireEvent.click(screen.getByRole('option', { name: label }));
}

/** 选择器列出的各项的名字：点开数一遍，再按 Esc 关上 */
export function optionsOf(combobox: HTMLElement): string[] {
  fireEvent.click(combobox);
  const list = screen.getByRole('listbox');
  const names = within(list)
    .queryAllByRole('option')
    .map(option => option.textContent ?? '');
  fireEvent.keyDown(list, { key: 'Escape' });
  return names;
}

/** jsdom 没有模态对话框：按浏览器的行为补上打开与关闭 */
export function installDialog(): () => void {
  const native = { showModal: HTMLDialogElement.prototype.showModal, close: HTMLDialogElement.prototype.close };
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  return () => Object.assign(HTMLDialogElement.prototype, native);
}

/** 浏览器的后退（系统返回手势）与前进：退回或前进一条历史 */
let go: (delta: number) => void = () => {};

function Where() {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  go = delta => navigate(delta);
  return <output data-testid="where">{pathname + search + hash}</output>;
}

export interface Harness {
  session: SessionClient;
  admin: AdminClient;
  /** 会话连接的服务端一侧 */
  server: FakeWebSocket;
  /** 当前地址（路径、查询串与锚点） */
  where(): string;
  /** 浏览器后退一条（系统返回手势） */
  back(): void;
  /** 浏览器前进一条 */
  forward(): void;
  /** 会话连接断开后重连：新连接按同样的 handlers 回应，握手完成后返回 */
  reconnect(): Promise<FakeWebSocket>;
  close(): void;
}

/** 一次 REST 请求：方法与按 JSON 解析的请求体 */
export interface FakeRequest {
  method: string;
  body?: unknown;
}

/**
 * 假的 REST：路径（含查询串）→ 回应的 JSON，或按请求算回应的函数（返回 Response 时原样回，可以带状态码）；
 * 登录状态、插件列表、页面表、布局记录与「需要处理」有缺省的回应，没有的路径回 404
 */
export type FakeRest = Record<string, unknown>;

/** 请求被作废时按浏览器的行为立即以作废的原因失败，不等回应 */
const aborted = (signal: AbortSignal | null | undefined) =>
  new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** 换掉全局的 fetch，按路径回 rest 里的 JSON */
export function stubRest(rest: FakeRest = {}): void {
  const routes: FakeRest = {
    '/api/auth/status': { authed: true },
    '/api/plugins': { plugins: [] },
    '/api/pages': { pages: [] },
    '/api/layout': { pinned: [], panelTabs: hostTabs() },
    '/api/attention': { items: [] },
    ...rest,
  };
  const answer = async (input: string, init?: RequestInit) => {
    const url = new URL(input, location.origin);
    const route = routes[url.pathname + url.search];
    if (route === undefined) return Response.json({ error: '未知 API' }, { status: 404 });
    if (typeof route !== 'function') return Response.json(route);
    const request: FakeRequest = {
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    const reply = await (route as (request: FakeRequest) => unknown)(request);
    return reply instanceof Response ? reply : Response.json(reply);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => Promise.race([answer(input, init), aborted(init?.signal)])),
  );
}

/** 发出的 REST 请求，按先后：路径（含查询串）、方法与请求体 */
export function restCalls(): Array<FakeRequest & { path: string }> {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = new URL(String(input), location.origin);
    return {
      path: url.pathname + url.search,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
  });
}

/**
 * 在 url 上渲染整个前端，等会话连接握手完成；rest 是假的 REST 回应。url 给成几条时，前面的是打开页面之前就有的历史
 */
export async function renderApp(url: string | string[], handlers: FakeHandlers, rest?: FakeRest): Promise<Harness> {
  stubRest(rest);
  const all: FakeHandlers = { initialize: () => INIT, 'sessions/watch': () => ({}), ...handlers };
  const session = createSessionClient();
  const admin = createAdminClient();
  const connect = async () => {
    const server = FakeWebSocket.at('/session');
    server.serve(all);
    await act(async () => server.open());
    await vi.waitFor(() => expect(session.state.status).toBe('open'));
    return server;
  };
  FakeWebSocket.at('/admin').open();
  render(
    <MemoryRouter initialEntries={[url].flat()}>
      <App session={session} admin={admin} />
      <Where />
    </MemoryRouter>,
  );
  const server = await connect();
  return {
    session,
    admin,
    server,
    where: () => document.querySelector('[data-testid="where"]')?.textContent ?? '',
    back: () => act(() => go(-1)),
    forward: () => act(() => go(1)),
    reconnect: connect,
    close() {
      cleanup();
      session.close();
      admin.close();
    },
  };
}
