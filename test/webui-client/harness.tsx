import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { expect, vi } from 'vitest';
import type { SessionMethodParams, SessionMethodResult } from '../../packages/api-session-protocol/src/index.js';
import { SESSION_LAYERS } from '../../packages/api-session-settings/src/index.js';
import { PAGE_LANGUAGE_ID, type PageLanguage } from '../../packages/api-webui/src/index.js';
import { App } from '../../packages/plugin-webui-client/src/App.js';
import { setLanguage } from '../../packages/plugin-webui-client/src/language.js';
import { type AdminClient, createAdminClient } from '../../packages/plugin-webui-client/src/protocol/admin-client.js';
import {
  createSessionClient,
  type RoomGroup,
  type SessionClient,
  type SessionSummary,
} from '../../packages/plugin-webui-client/src/protocol/session-client.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
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
  features: { send: true, rewind: true, compress: true, settings: true },
  appName: 'Aalis',
};

/** 层表：session/config/layers 回包的 order，与会话服务给的同一份（称呼按原文渲染） */
export const LAYER_ORDER: SessionMethodResult<'session/config/layers'>['order'] = SESSION_LAYERS.map(
  ({ name, label }) => ({ name, label: toSource(label) }),
);

/** 默认工作区：没有聊天窗口的会话的场所 */
export const HOME_PLACE: SessionSummary['place'] = { key: 'workspace:default', kind: 'workspace', name: '默认工作区' };

export function summary(id: string, fields: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: id,
    childCount: 0,
    kind: 'owner',
    section: 'owner',
    place: HOME_PLACE,
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

/** 模型列表（GET /api/models/llm）里一个能对话的模型 */
export const CHAT_MODEL = { model: 'zz-chat', provider: '测试模型', contextId: 'zz-llm', capabilities: ['chat'] };

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
    lacking: [],
    waiting: [],
    unconfigured: [],
    tools: [],
    commands: [],
    configSection: false,
    config: {},
    defaultConfig: {},
    ...fields,
  };
}

/** IM 房间：缺省是 onebot 的一个群，场所是它的窗口 */
export function room(id: string, instance: string | undefined, fields: Partial<SessionSummary> = {}): SessionSummary {
  return summary(id, {
    kind: 'room',
    section: 'rooms',
    platform: 'onebot',
    instance,
    account: '10001',
    chat: { type: 'group', multiParty: true },
    place: { key: `onebot:group:${id}`, kind: 'window', name: fields.title ?? id },
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
 * 登录状态、插件列表、页面表、布局记录、「需要处理」、模型列表、服务列表与界面的语言有缺省的回应（缺省有一个能对话的模型，
 * 首页不出「开始使用」；服务列表为空；语言见 {@link language}），没有的路径回 404。语言包的补充按路径认，不看查询串（ns 的清单
 * 随前端打包的字典而定）。服务端写进页面的语言块与那一刻 GET /api/i18n/languages 的回应相同，见 {@link renderApp}
 */
export type FakeRest = Record<string, unknown>;

const MESSAGES = '/api/i18n/messages';

/**
 * 界面的语言：GET /api/i18n/languages 回全局默认层的这条语言链与服务进程的时区（取测试进程的时区，用例里本地时间构造的时刻
 * 照常对得上；前端不读 languages，给空的），语言包的补充是 packs；链为空是 i18n 不在。缺省的回应是 zh-CN；英文界面的用例在
 * rest 里展开 language(['en'])，要别的时区的用例直接写这条路由
 */
export function language(chain: string[], { packs = {} }: { packs?: object } = {}): FakeRest {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { '/api/i18n/languages': { languages: [], chain, timeZone }, [MESSAGES]: { entries: packs } };
}

/** 请求被作废时按浏览器的行为立即以作废的原因失败，不等回应 */
const aborted = (signal: AbortSignal | null | undefined) =>
  new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** 换掉全局的 fetch，按路径回 rest 里的 JSON；返回连同缺省回应的全部路由 */
export function stubRest(rest: FakeRest = {}): FakeRest {
  const routes: FakeRest = {
    '/api/auth/status': { authed: true },
    '/api/plugins': { plugins: [] },
    '/api/pages': { pages: [] },
    '/api/layout': { pinned: [], panelTabs: hostTabs() },
    '/api/attention': { items: [] },
    '/api/models/llm': { providers: [CHAT_MODEL] },
    '/api/services': { services: {} },
    ...language(['zh-CN']),
    ...rest,
  };
  const answer = async (input: string, init?: RequestInit) => {
    const url = new URL(input, location.origin);
    const route = routes[url.pathname === MESSAGES ? MESSAGES : url.pathname + url.search];
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
  return routes;
}

/** 服务端写进页面的语言块：与这一刻 GET /api/i18n/languages 的回应相同（按请求算的回应同样算一次），回应不是 JSON 时没有 */
function pageLanguageOf(route: unknown): PageLanguage | undefined {
  const reply = typeof route === 'function' ? (route as (request: FakeRequest) => unknown)({ method: 'GET' }) : route;
  const { chain, timeZone } = (reply ?? {}) as Partial<PageLanguage>;
  return Array.isArray(chain) && typeof timeZone === 'string' ? { chain, timeZone } : undefined;
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
 * 在 url 上渲染整个前端，等界面画出来、会话连接握手完成；rest 是假的 REST 回应。url 给成几条时，前面的是打开页面之前就有的
 * 历史。page 是服务端写进页面的语言块：缺省照 GET /api/i18n/languages 的回应，false 是没有这一块（直接打开 /index.html、
 * 开发模式）
 */
export async function renderApp(
  url: string | string[],
  handlers: FakeHandlers,
  rest?: FakeRest,
  { page }: { page?: PageLanguage | false } = {},
): Promise<Harness> {
  const routes = stubRest(rest);
  const written = page === undefined ? pageLanguageOf(routes['/api/i18n/languages']) : page;
  if (written) {
    const block = Object.assign(document.createElement('script'), { type: 'application/json', id: PAGE_LANGUAGE_ID });
    block.textContent = JSON.stringify(written);
    document.head.append(block);
  }
  const all: FakeHandlers = {
    initialize: () => INIT,
    'sessions/watch': () => ({}),
    'session/config/layers': () => ({ layers: [{ layer: { scope: 'global' } }], order: LAYER_ORDER }),
    ...handlers,
  };
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
      <div data-testid="app">
        <App session={session} admin={admin} />
      </div>
      <Where />
    </MemoryRouter>,
  );
  // 等界面画出来、各处的副作用执行完毕再接上会话连接，用例都从「界面先于握手画好」写起
  await vi.waitFor(() => expect(screen.getByTestId('app').childElementCount).toBeGreaterThan(0));
  await act(async () => {});
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
      // 界面的语言是模块里的状态：复原成原文，免得漏给同一文件里后面单独渲染组件的用例
      setLanguage({ chain: [], timeZone: 'UTC', packs: new Map() });
      document.documentElement.lang = '';
      document.getElementById(PAGE_LANGUAGE_ID)?.remove();
    },
  };
}
