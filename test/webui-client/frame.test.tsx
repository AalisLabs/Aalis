// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_PROTOCOL_VERSION,
  FRAME_SANDBOX,
  type FrameHostMessage,
  type FrameInit,
  type FramePageView,
  type FrameResult,
  type PageView,
  THEME_TOKENS,
} from '../../packages/api-webui/src/index.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  type FakeRest,
  group,
  type Harness,
  installDialog,
  lists,
  renderApp,
  requests,
  restCalls,
  server,
  summary,
} from './harness.js';
import { snapshot } from './items.js';
import { actionPath, BOARD, data, dataPath, hostTabs, layoutStore, pagePath, pageTab, ROSTER, refOf } from './pages.js';

// ════════════════════════════════════════════════════════════
// 插件前端的宿主一侧：iframe 的属性与握手（来源窗口、nonce、只认一次、主版本、握手前不可见、第一次 load 之后超时、
// 第二次 load 与 leaving 卸载、IPv6 不挂载）与出处一行；转发（数据与动作带上挂载时的实例、页面与会话，没声明的动作
// 不发请求，destructive 经宿主确认框，open 的两种目标，同一时刻一个宿主对话框，连续取消卸载，HTTP 回应对到错误码，
// invalidate 的过滤与重连，主题推送，页面撤回时卸载）；宿主数据能力按申请转发；在途与频率上限，反复挂载卸载后监听、
// 端口与计时器回到基线。框架一侧由用例扮演：hello 是派发到窗口上的消息，端口换成同步投递的假端口
// ════════════════════════════════════════════════════════════

/** 握手超时，从第一次 load 起算 */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** 宿主对话框打开后多久内不接受点按 */
const DIALOG_ARM_MS = 500;
const MAX_PENDING = 8;
const MESSAGES_PER_SECOND = 200;

/** 假的 MessagePort：同步投递，按结构化克隆复制；关了以后不再投递 */
class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  peer?: FakePort;
  closed = false;

  postMessage(data: unknown): void {
    if (this.closed || this.peer?.closed) return;
    this.peer?.onmessage?.({ data: structuredClone(data) });
  }

  close(): void {
    this.closed = true;
  }
}

let channels: FakeChannel[] = [];

class FakeChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
    channels.push(this);
  }
}

/** 主题变化用到的观察者：数着建了几个、断开了几个 */
let observers = { created: 0, disconnected: 0 };

class CountingObserver extends MutationObserver {
  constructor(callback: MutationCallback) {
    super(callback);
    observers.created += 1;
  }

  override disconnect(): void {
    observers.disconnected += 1;
    super.disconnect();
  }
}

declare const jsdom: { reconfigure(options: { url: string }): void };

let app: Harness | undefined;
let restoreDialog: () => void;

beforeAll(() => {
  restoreDialog = installDialog();
});
afterAll(() => restoreDialog());

beforeEach(() => {
  FakeWebSocket.install();
  stubPlatform('MacIntel');
  stubViewport(1440);
  channels = [];
  observers = { created: 0, disconnected: 0 };
  vi.stubGlobal('MessageChannel', FakeChannel);
  vi.stubGlobal('MutationObserver', CountingObserver);
});

afterEach(() => {
  app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const PLUGINS: FakeRest = {
  '/api/plugins': {
    plugins: [
      { name: 'zz-board', instanceId: 'zz-board', displayName: '看板插件' },
      { name: 'zz-roster', instanceId: 'zz-roster', displayName: '子会话面板' },
    ],
  },
};

/** 插件页面「看板」的 REST；extra 覆盖或补充 */
function boardRest(extra: FakeRest = {}): FakeRest {
  return {
    ...PLUGINS,
    '/api/pages': { pages: [BOARD, ROSTER] },
    '/api/layout': layoutStore().route,
    [dataPath(BOARD, 'cards')]: data([{ id: 'c1', title: '周报' }]),
    ...extra,
  };
}

const ROSTER_PATH = `/s/a/p/${ROSTER.instance}/${ROSTER.key}`;

/** 会话 a 的面板里开着「子会话」 */
function rosterRest(extra: FakeRest = {}): FakeRest {
  return boardRest({
    '/api/layout': layoutStore({ panelTabs: [...hostTabs(), pageTab(ROSTER)] }).route,
    '/api/session-pages?sessionId=a': { pages: [refOf(ROSTER)] },
    ...extra,
  });
}

const SESSIONS = [summary('a', { title: '整理周报' }), summary('b', { title: '读书笔记', parentId: 'a' })];

const handlers = {
  'sessions/list': lists(() => SESSIONS, [group('zz-im')]),
  'session/subscribe': ({ sessionId }: { sessionId: string }) => snapshot([], { session: summary(sessionId) }),
  'session/config/get': () => ({ items: [] }),
  'turn/abort': () => ({}),
};

const frame = () => document.querySelector('iframe');

async function findFrame(): Promise<HTMLIFrameElement> {
  await vi.waitFor(() => expect(frame()).not.toBeNull());
  return frame() as HTMLIFrameElement;
}

const nonceOf = (iframe: HTMLIFrameElement) => (iframe.getAttribute('src') ?? '').split('#')[1];

const helloOf = (iframe: HTMLIFrameElement) => ({
  type: 'hello',
  protocol: FRAME_PROTOCOL_VERSION,
  nonce: nonceOf(iframe),
});

/** 框架发到宿主窗口上的消息：缺省来自这个框架的窗口，来源是 null */
function hello(
  iframe: HTMLIFrameElement,
  message: unknown = helloOf(iframe),
  from: { source?: MessageEventSource; origin?: string } = {},
): void {
  const source = from.source ?? (iframe.contentWindow as Window);
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message, origin: from.origin ?? 'null', source }));
  });
}

const postedTo = (iframe: HTMLIFrameElement) =>
  vi.spyOn(iframe.contentWindow as Window, 'postMessage') as unknown as {
    mock: { calls: Array<[FrameInit, string, FakePort[]]> };
  };

/** 用例扮演的框架：握手拿到的 init 与端口，经端口收到的消息 */
interface Peer {
  init: FrameInit;
  received: FrameHostMessage[];
  /** 经端口发一条消息，不论合不合格 */
  send(message: unknown): void;
  /** 发一个请求（自动编 id），等它的 result */
  request(message: Record<string, unknown>): Promise<FrameResult>;
}

let nextId = 0;

/** 握手：框架发 hello，宿主交出 init 与端口 */
async function connect(target?: HTMLIFrameElement): Promise<Peer> {
  const iframe = target ?? (await findFrame());
  const posted = postedTo(iframe);
  hello(iframe);
  expect(posted.mock.calls).toHaveLength(1);
  const [init, , [port]] = posted.mock.calls[0];
  const received: FrameHostMessage[] = [];
  const waiting = new Map<number, (result: FrameResult) => void>();
  port.onmessage = ({ data }) => {
    const message = data as FrameHostMessage;
    received.push(message);
    if (message.type === 'result') waiting.get(message.id)?.(message);
  };
  return {
    init,
    received,
    send: message => act(() => port.postMessage(message)),
    request(message) {
      const id = ++nextId;
      const result = new Promise<FrameResult>(resolve => waiting.set(id, resolve));
      act(() => port.postMessage({ ...message, id }));
      return result;
    },
  };
}

/** 发一个不用人操作就会回来的请求，等它的 result */
const ask = (peer: Peer, message: Record<string, unknown>) => act(() => peer.request(message));

const failed = (code: string) => ({ type: 'result', ok: false, error: { code, message: expect.any(String) } });

const gets = (path: string) => restCalls().filter(call => call.method === 'GET' && call.path === path).length;

/**
 * 从现在起数宿主挂上的东西：窗口的 message 监听、管理与会话连接上的处理函数（之前挂上的不算）、主题观察者
 * （建了的减去断开了的）。回取当前计数的函数
 */
function countHandlers(harness: Harness) {
  const messageListeners = new Set<unknown>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'message') messageListeners.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'message') messageListeners.delete(listener);
    remove(type, listener, options);
  });
  let subscriptions = 0;
  const count = <T extends object>(target: T, method: keyof T) => {
    const original = (target[method] as (...args: unknown[]) => () => void).bind(target);
    vi.spyOn(target, method as never).mockImplementation(((...args: unknown[]) => {
      subscriptions += 1;
      const off = original(...args);
      let done = false;
      return () => {
        if (!done) subscriptions -= 1;
        done = true;
        off();
      };
    }) as never);
  };
  count(harness.session, 'on');
  count(harness.session, 'onReady');
  count(harness.admin, 'on');
  count(harness.admin, 'onReconnect');
  return () => ({
    listeners: messageListeners.size,
    subscriptions,
    observers: observers.created - observers.disconnected,
  });
}
const posts = (path: string) => restCalls().filter(call => call.method === 'POST' && call.path === path);
const pageCalls = () => restCalls().filter(call => call.path.startsWith('/api/pages/'));
const admin = () => FakeWebSocket.at('/admin');
const refresh = () => fireEvent.click(screen.getAllByRole('button', { name: '刷新' })[0]);
const dialog = (name: string) => within(screen.getByRole('dialog', { name }));

/**
 * 宿主对话框打开后的时刻：performance.now 由用例给。事件的 timeStamp 在浏览器里与它同一个时间原点，jsdom 取的是
 * Date.now，所以一并给
 */
function clock(start = 1_000) {
  let now = start;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    set(next: number) {
      now = next;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('挂载与握手', () => {
  it('iframe 只带沙箱常量给的权限、不送 referrer、不带 allow，标题取页面标题；地址是框架地址加片段里的随机数，每次挂载换一个', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const iframe = await findFrame();
    expect(iframe.getAttribute('sandbox')).toBe(FRAME_SANDBOX);
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe.hasAttribute('allow')).toBe(false);
    expect(iframe.title).toBe('看板');
    const [src, nonce] = (iframe.getAttribute('src') ?? '').split('#');
    expect(src).toBe(BOARD.frame.src);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);

    refresh();
    const again = await findFrame();
    expect(again).not.toBe(iframe);
    expect(nonceOf(again)).toMatch(/^[0-9a-f]{32}$/);
    expect(nonceOf(again)).not.toBe(nonce);
  });

  it('握手：来源窗口不对、来源不是 null、nonce 不对、消息不合格都不理；第一个合格的 hello 收到 init 与专用端口，之后的不理', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const iframe = await findFrame();
    const posted = postedTo(iframe);
    const good = helloOf(iframe);
    hello(iframe, good, { source: window });
    hello(iframe, good, { origin: location.origin });
    hello(iframe, { ...good, nonce: 'f'.repeat(32) });
    hello(iframe, { ...good, extra: true });
    hello(iframe, { ...good, protocol: 'one' });
    expect(posted.mock.calls).toEqual([]);

    hello(iframe, good);
    expect(posted.mock.calls).toHaveLength(1);
    const [init, origin, transfer] = posted.mock.calls[0];
    expect(init).toEqual({
      type: 'init',
      protocol: FRAME_PROTOCOL_VERSION,
      experimental: true,
      theme: expect.any(Object),
    });
    expect(origin).toBe('*');
    expect(channels).toHaveLength(1);
    expect(transfer).toEqual([channels[0].port2]);

    hello(iframe, good);
    expect(posted.mock.calls).toHaveLength(1);
    expect(channels).toHaveLength(1);
  });

  it('握手完成前 iframe 不可见、区域里是宿主的加载态；交出 init 之后才显示', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const iframe = await findFrame();
    expect(iframe.hasAttribute('data-ready')).toBe(false);
    expect(screen.getByRole('status', { name: '正在加载' })).toBeTruthy();
    await connect(iframe);
    expect(iframe.hasAttribute('data-ready')).toBe(true);
    expect(screen.queryByRole('status', { name: '正在加载' })).toBeNull();
  });

  it('主版本不同：不交端口，卸载框架并写明两边的版本；次版本不同照常握手', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const iframe = await findFrame();
    const posted = postedTo(iframe);
    hello(iframe, { ...helloOf(iframe), protocol: '2.0' });
    expect(posted.mock.calls).toEqual([]);
    expect(frame()).toBeNull();
    expect(screen.getByText(`这个页面用的前端协议是 2.0，界面支持的是 ${FRAME_PROTOCOL_VERSION}`)).toBeTruthy();

    refresh();
    const next = await findFrame();
    const nextPosted = postedTo(next);
    hello(next, { ...helloOf(next), protocol: `${FRAME_PROTOCOL_VERSION.split('.')[0]}.9` });
    expect(nextPosted.mock.calls).toHaveLength(1);
  });

  it('第一次 load 之后 10 秒内没有合格的 hello：显示「页面没有响应」，「重新加载」再挂一次；load 之前不计时，握手之后也不计时', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const iframe = await findFrame();
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(60_000));
    expect(frame()).toBe(iframe);
    fireEvent.load(iframe);
    act(() => vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1));
    expect(frame()).toBe(iframe);
    act(() => vi.advanceTimersByTime(1));
    expect(frame()).toBeNull();
    expect(screen.getByText('页面没有响应')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    const next = frame() as HTMLIFrameElement;
    expect(next).not.toBeNull();
    await connect(next);
    fireEvent.load(next);
    act(() => vi.advanceTimersByTime(60_000));
    expect(frame()).toBe(next);
  });

  it('第二次 load：立即卸载，写明离开了宿主给它的地址并记告警；没用助手（没有 hello）的框架同样靠它卸载', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const iframe = await findFrame();
    await connect(iframe);
    fireEvent.load(iframe);
    expect(frame()).toBe(iframe);
    fireEvent.load(iframe);
    expect(frame()).toBeNull();
    expect(screen.getByText('这个页面离开了宿主给它的地址，已停止显示')).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('看板');

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    const next = await findFrame();
    fireEvent.load(next);
    fireEvent.load(next);
    expect(frame()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('leaving：立即卸载，它弹出的宿主对话框一并关掉，记告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const peer = await connect();
    void peer.request({ type: 'open', target: { url: 'https://example.com/' } });
    await screen.findByRole('dialog', { name: '打开外部链接？' });
    peer.send({ type: 'leaving' });
    expect(frame()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('这个页面离开了宿主给它的地址，已停止显示')).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('以 IPv6 字面地址访问时不挂载框架，写明要用主机名或 IPv4 地址访问', async () => {
    jsdom.reconfigure({ url: 'http://[::1]:3000/' });
    try {
      app = await renderApp(pagePath(BOARD), {}, boardRest());
      expect(await screen.findByText('用主机名或 IPv4 地址访问才能显示插件前端')).toBeTruthy();
      expect(frame()).toBeNull();
    } finally {
      jsdom.reconfigure({ url: 'http://localhost:3000/' });
    }
  });

  it('出处：插件页面在标题栏下、会话面板在标签内容顶上写「来自 <插件显示名>」', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const page = await screen.findByRole('region', { name: '看板' });
    const source = await within(page).findByText('来自 看板插件');
    expect(source.closest('header')).toBeNull();
    expect(source.compareDocumentPosition(await findFrame()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    app.close();

    app = await renderApp(ROSTER_PATH, handlers, rosterRest());
    const tab = within(await screen.findByRole('tabpanel'));
    expect(await tab.findByText('来自 子会话面板')).toBeTruthy();
    expect(await findFrame()).toBeTruthy();
  });
});

describe('转发', () => {
  it('数据：带上挂载时的实例、页面与会话面板的会话；数据源名与输入照原样交给服务端，结果回给框架', async () => {
    app = await renderApp(
      pagePath(BOARD),
      {},
      boardRest({ [dataPath(BOARD, 'card', { input: '{"id":"c1"}' })]: data({ id: 'c1', title: '周报' }) }),
    );
    const board = await connect();
    expect(await ask(board, { type: 'data', source: 'cards' })).toMatchObject({
      ok: true,
      value: [{ id: 'c1', title: '周报' }],
    });
    expect(await ask(board, { type: 'data', source: 'card', input: { id: 'c1' } })).toMatchObject({
      ok: true,
      value: { id: 'c1', title: '周报' },
    });
    app.close();

    app = await renderApp(
      ROSTER_PATH,
      handlers,
      rosterRest({ [dataPath(ROSTER, 'tree', { sessionId: 'a', input: '{"depth":2}' })]: data(['b']) }),
    );
    const roster = await connect();
    expect(roster.init.sessionId).toBe('a');
    expect(await ask(roster, { type: 'data', source: 'tree', input: { depth: 2 } })).toMatchObject({
      ok: true,
      value: ['b'],
    });
  });

  it('消息里带实例、页面或会话回 invalid、不发请求；认不出 id 的不合格消息不回', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const peer = await connect();
    for (const extra of [{ instance: 'zz-other' }, { pageKey: 'other' }, { sessionId: 'b' }]) {
      expect(await ask(peer, { type: 'data', source: 'cards', ...extra })).toMatchObject(failed('invalid'));
      expect(await ask(peer, { type: 'action', action: 'archive', ...extra })).toMatchObject(failed('invalid'));
    }
    expect(await ask(peer, { type: 'data', source: 'cards', input: [1] })).toMatchObject(failed('invalid'));
    const count = peer.received.length;
    peer.send({ type: 'nope' });
    peer.send({ type: 'data', id: 'x', source: 'cards' });
    expect(peer.received).toHaveLength(count);
    expect(pageCalls()).toEqual([]);
  });

  it('输入写不成 JSON 时回 invalid：不发请求，也不弹确认框', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const peer = await connect();
    const cyclic: Record<string, unknown> = { id: 'c1' };
    cyclic.self = cyclic;
    expect(await ask(peer, { type: 'data', source: 'cards', input: cyclic })).toMatchObject(failed('invalid'));
    expect(await ask(peer, { type: 'action', action: 'purge', input: { note: 10n } })).toMatchObject(failed('invalid'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pageCalls()).toEqual([]);
  });

  it('动作：write 不弹 Toast，结果只回框架；请求体只有会话与输入', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest({ [actionPath(BOARD, 'archive')]: { message: '已归档 c1' } }));
    const board = await connect();
    expect(await ask(board, { type: 'action', action: 'archive', input: { id: 'c1' } })).toMatchObject({
      ok: true,
      value: '已归档 c1',
    });
    expect(posts(actionPath(BOARD, 'archive')).map(call => call.body)).toEqual([{ input: { id: 'c1' } }]);
    expect(screen.queryByText('已归档 c1')).toBeNull();
    app.close();

    app = await renderApp(ROSTER_PATH, handlers, rosterRest({ [actionPath(ROSTER, 'mark')]: {} }));
    const roster = await connect();
    expect(await ask(roster, { type: 'action', action: 'mark' })).toMatchObject({ ok: true, value: null });
    expect(posts(actionPath(ROSTER, 'mark')).map(call => call.body)).toEqual([{ sessionId: 'a' }]);
  });

  it('没声明的动作回 not-found、不发请求，原型上的名字也算没声明', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const peer = await connect();
    for (const action of ['explode', 'toString', 'constructor', '__proto__']) {
      expect(await ask(peer, { type: 'action', action })).toMatchObject(failed('not-found'));
    }
    expect(pageCalls()).toEqual([]);
  });

  it('destructive：先出宿主确认框，写出确认文案与这次的输入值，焦点在「取消」；500 毫秒内的点按无效；取消回 cancelled、不发请求；确认后发请求，结果回框架并用 Toast 显示', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest({ [actionPath(BOARD, 'purge')]: { message: '清空了 3 张' } }));
    const peer = await connect();
    const time = clock();
    const input = { list: 'todo', note: '<b>周五</b>前', extra: { a: 1 } };
    const first = peer.request({ type: 'action', action: 'purge', input });
    const box = dialog('清空？');
    expect(box.getByText('清空后不能恢复。')).toBeTruthy();
    expect(box.getByText('列表')).toBeTruthy();
    expect(box.getByText('待办')).toBeTruthy();
    expect(box.getByText('备注')).toBeTruthy();
    expect(box.getByText('<b>周五</b>前')).toBeTruthy();
    expect(box.getByText('extra')).toBeTruthy();
    expect(box.getByText('{"a":1}')).toBeTruthy();
    expect(document.activeElement).toBe(box.getByRole('button', { name: '取消' }));

    time.advance(DIALOG_ARM_MS - 1);
    fireEvent.click(box.getByRole('button', { name: '清空' }));
    expect(screen.getByRole('dialog', { name: '清空？' })).toBeTruthy();
    fireEvent.click(box.getByRole('button', { name: '取消' }));
    expect(await act(() => first)).toMatchObject(failed('cancelled'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(actionPath(BOARD, 'purge'))).toEqual([]);

    const second = peer.request({ type: 'action', action: 'purge', input });
    time.advance(DIALOG_ARM_MS);
    fireEvent.click(dialog('清空？').getByRole('button', { name: '清空' }));
    expect(await act(() => second)).toMatchObject({ ok: true, value: '清空了 3 张' });
    expect(posts(actionPath(BOARD, 'purge')).map(call => call.body)).toEqual([{ input }]);
    expect(await screen.findByText('清空了 3 张')).toBeTruthy();
  });

  it('500 毫秒从对话框真正打开时算起、按点按发生的时刻判断：渲染被拖住、点按排队晚到都不算数', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest({ [actionPath(BOARD, 'purge')]: { message: '清空了' } }));
    const peer = await connect();
    const time = clock();
    // 收到请求到对话框打开隔了 400 毫秒
    const show = HTMLDialogElement.prototype.showModal;
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
      time.advance(400);
      show.call(this);
    });
    const result = peer.request({ type: 'action', action: 'purge' });
    const opened = performance.now();
    const button = dialog('清空？').getByRole('button', { name: '清空' });
    /** 在 at 时刻点下、处理时已到了第 600 毫秒 */
    const clickAt = (at: number) => {
      time.set(opened + 600);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      Object.defineProperty(event, 'timeStamp', { value: at });
      fireEvent(button, event);
    };
    clickAt(opened + DIALOG_ARM_MS - 1);
    expect(screen.getByRole('dialog', { name: '清空？' })).toBeTruthy();
    expect(posts(actionPath(BOARD, 'purge'))).toEqual([]);
    clickAt(opened + DIALOG_ARM_MS);
    expect(await act(() => result)).toMatchObject({ ok: true, value: '清空了' });
  });

  it('destructive 失败：框架收到 failed，Toast 写原因', async () => {
    app = await renderApp(
      pagePath(BOARD),
      {},
      boardRest({ [actionPath(BOARD, 'purge')]: () => Response.json({ error: '列表锁住了' }, { status: 500 }) }),
    );
    const peer = await connect();
    const time = clock();
    const result = peer.request({ type: 'action', action: 'purge' });
    expect(dialog('清空？').getByText('清空后不能恢复。')).toBeTruthy();
    time.advance(DIALOG_ARM_MS);
    fireEvent.click(dialog('清空？').getByRole('button', { name: '清空' }));
    expect(await act(() => result)).toMatchObject({ ok: false, error: { code: 'failed', message: '列表锁住了' } });
    expect(await screen.findByText('清空失败：列表锁住了')).toBeTruthy();
  });

  it('open 外链：宿主对话框按纯文本写出完整地址，「打开」是在新标签打开的真实链接；500 毫秒内点它无效；点了回空，不调 window.open；取消回 cancelled', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const peer = await connect();
    const time = clock();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    // 链接的默认动作是浏览器打开新标签，jsdom 做不到；在宿主的处理之后拦下
    const followed: boolean[] = [];
    const follow = (event: MouseEvent) => {
      followed.push(!event.defaultPrevented);
      event.preventDefault();
    };
    window.addEventListener('click', follow);
    try {
      const url = 'https://example.com/a b?q=<i>x</i>';
      const href = new URL(url).href;
      const first = peer.request({ type: 'open', target: { url } });
      const box = dialog('打开外部链接？');
      expect(box.getByText(href)).toBeTruthy();
      const link = box.getByRole('link', { name: '打开' });
      expect(link.getAttribute('href')).toBe(href);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(document.activeElement).toBe(box.getByRole('button', { name: '取消' }));

      time.advance(DIALOG_ARM_MS - 1);
      fireEvent.click(link);
      expect(followed).toEqual([false]);
      expect(screen.getByRole('dialog', { name: '打开外部链接？' })).toBeTruthy();
      time.advance(1);
      fireEvent.click(link);
      expect(followed).toEqual([false, true]);
      expect(await act(() => first)).toMatchObject({ ok: true, value: null });
      expect(screen.queryByRole('dialog')).toBeNull();

      const second = peer.request({ type: 'open', target: { url } });
      fireEvent.click(dialog('打开外部链接？').getByRole('button', { name: '取消' }));
      expect(await act(() => second)).toMatchObject(failed('cancelled'));
      expect(open).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('click', follow);
    }
  });

  it('open：与宿主同源的地址回 invalid、不弹框；会话在应用内打开', async () => {
    app = await renderApp(pagePath(BOARD), handlers, boardRest());
    const peer = await connect();
    expect(await ask(peer, { type: 'open', target: { url: `${location.origin}/api/pages` } })).toMatchObject(
      failed('invalid'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await ask(peer, { type: 'open', target: { session: 'b' } })).toMatchObject({ ok: true, value: null });
    await vi.waitFor(() => expect(app?.where()).toBe('/s/b'));
  });

  it('同一时刻只一个宿主对话框：开着时再请求外链或 destructive 动作回 denied，别的请求照常', async () => {
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const peer = await connect();
    void peer.request({ type: 'open', target: { url: 'https://example.com/' } });
    await screen.findByRole('dialog', { name: '打开外部链接？' });
    expect(await ask(peer, { type: 'open', target: { url: 'https://example.org/' } })).toMatchObject(failed('denied'));
    expect(await ask(peer, { type: 'action', action: 'purge' })).toMatchObject(failed('denied'));
    expect(await ask(peer, { type: 'data', source: 'cards' })).toMatchObject({ ok: true });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('宿主对话框连续被取消 3 次：卸载框架、写明反复弹出确认、记告警；中间确认过一次就重新计数', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app = await renderApp(pagePath(BOARD), {}, boardRest({ [actionPath(BOARD, 'purge')]: {} }));
    const peer = await connect();
    const time = clock();
    const answer = async (button: '取消' | '清空') => {
      const result = peer.request({ type: 'action', action: 'purge' });
      time.advance(DIALOG_ARM_MS);
      fireEvent.click(dialog('清空？').getByRole('button', { name: button }));
      return act(() => result);
    };
    await answer('取消');
    await answer('取消');
    expect(await answer('清空')).toMatchObject({ ok: true });
    await answer('取消');
    await answer('取消');
    expect(frame()).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();

    void peer.request({ type: 'open', target: { url: 'https://example.com/' } });
    fireEvent.click(dialog('打开外部链接？').getByRole('button', { name: '取消' }));
    await vi.waitFor(() => expect(frame()).toBeNull());
    expect(screen.getByText('这个页面反复弹出确认，已停止')).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await findFrame()).toBeTruthy();
  });

  it('HTTP 回应对到错误码：400、414、431 → invalid，404 → not-found，503 与连不上 → unavailable，其余 4xx 与 5xx → failed', async () => {
    const statuses: Record<string, number> = {
      s400: 400,
      s414: 414,
      s431: 431,
      s404: 404,
      s503: 503,
      s413: 413,
      s500: 500,
      s502: 502,
    };
    const routes: FakeRest = Object.fromEntries(
      Object.entries(statuses).map(([source, status]) => [
        dataPath(BOARD, source),
        () => Response.json({ error: `回了 ${status}` }, { status }),
      ]),
    );
    routes[dataPath(BOARD, 'offline')] = () => Promise.reject(new TypeError('Failed to fetch'));
    app = await renderApp(pagePath(BOARD), {}, boardRest(routes));
    const peer = await connect();
    const code = async (source: string) => {
      const result = await ask(peer, { type: 'data', source });
      return result.ok ? 'ok' : result.error;
    };
    expect(await code('s400')).toEqual({ code: 'invalid', message: '回了 400' });
    expect(await code('s414')).toEqual({ code: 'invalid', message: '输入太长' });
    expect(await code('s431')).toEqual({ code: 'invalid', message: '输入太长' });
    expect(await code('s404')).toEqual({ code: 'not-found', message: '回了 404' });
    expect(await code('s503')).toEqual({ code: 'unavailable', message: '回了 503' });
    expect(await code('offline')).toMatchObject({ code: 'unavailable' });
    expect(await code('s413')).toEqual({ code: 'failed', message: '回了 413' });
    expect(await code('s500')).toEqual({ code: 'failed', message: '回了 500' });
    expect(await code('s502')).toEqual({ code: 'failed', message: '回了 502' });
  });

  it('invalidate：按页面、会话与数据源过滤；会话或管理连接重连后各推一次不带 source 的', async () => {
    app = await renderApp(ROSTER_PATH, handlers, rosterRest());
    const peer = await connect();
    const invalidations = () => peer.received.filter(message => message.type === 'invalidate');
    const push = (event: Record<string, unknown>) =>
      act(() => admin().push({ type: 'page.invalidate', instance: ROSTER.instance, pageKey: ROSTER.key, ...event }));
    push({ componentId: 'tree' });
    push({ sessionId: 'b' });
    push({ sessionId: 'a', componentId: 'tree' });
    push({});
    act(() => admin().push({ type: 'page.invalidate', instance: BOARD.instance, pageKey: BOARD.key }));
    act(() => admin().push({ type: 'page.invalidate', instance: ROSTER.instance, pageKey: 'other' }));
    expect(invalidations()).toEqual([
      { type: 'invalidate', source: 'tree' },
      { type: 'invalidate', source: 'tree' },
      { type: 'invalidate' },
    ]);

    act(() => admin().drop());
    act(() => FakeWebSocket.at('/admin').open());
    expect(invalidations().slice(3)).toEqual([{ type: 'invalidate' }]);

    vi.useFakeTimers();
    act(() => server().drop());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await app.reconnect();
    await vi.waitFor(() => expect(invalidations().slice(3)).toEqual([{ type: 'invalidate' }, { type: 'invalidate' }]));
  });

  it('主题：init 带当前主题的深浅与令牌；切换主题后推 theme，没变不推', async () => {
    const style = document.createElement('style');
    style.textContent = [
      ':root[data-theme="zz-dark"]{color-scheme:dark;--color-bg:#101010;--color-text:#eeeeee}',
      ':root[data-theme="zz-light"]{color-scheme:light;--color-bg:#fafafa;--color-text:#111111}',
    ].join('\n');
    document.head.append(style);
    document.documentElement.dataset.theme = 'zz-dark';
    try {
      app = await renderApp(pagePath(BOARD), {}, boardRest());
      const peer = await connect();
      expect(peer.init.theme.kind).toBe('dark');
      expect(Object.keys(peer.init.theme.tokens).sort()).toEqual([...THEME_TOKENS].sort());
      expect(peer.init.theme.tokens['--color-bg']).toBe('#101010');
      expect(peer.init.theme.tokens['--color-text']).toBe('#eeeeee');

      document.documentElement.dataset.theme = 'zz-light';
      await vi.waitFor(() => expect(peer.received.filter(message => message.type === 'theme')).toHaveLength(1));
      const [theme] = peer.received.filter(message => message.type === 'theme');
      expect(theme).toMatchObject({ type: 'theme', kind: 'light', tokens: { '--color-bg': '#fafafa' } });

      document.documentElement.dataset.theme = 'zz-light';
      await act(() => Promise.resolve());
      expect(peer.received.filter(message => message.type === 'theme')).toHaveLength(1);
    } finally {
      style.remove();
      delete document.documentElement.dataset.theme;
    }
  });

  it('页面不在页面表里（插件停用）时卸载框架、显示占位；页面表重取回同一个地址不重挂；重新登记换了地址后重新挂载', async () => {
    let pages: PageView[] = [BOARD];
    app = await renderApp(pagePath(BOARD), {}, boardRest({ '/api/pages': () => ({ pages }) }));
    const iframe = await findFrame();
    await connect(iframe);
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(gets('/api/pages')).toBe(2));
    expect(frame()).toBe(iframe);
    expect(iframe.hasAttribute('data-ready')).toBe(true);

    pages = [];
    act(() => admin().push({ type: 'plugins.changed' }));
    expect(await screen.findByText('这个页面所属的插件已停用')).toBeTruthy();
    expect(frame()).toBeNull();

    const moved: FramePageView = { ...BOARD, frame: { ...BOARD.frame, src: '/frames/tok-next/index.html' } };
    pages = [moved];
    act(() => admin().push({ type: 'plugins.changed' }));
    const next = await findFrame();
    expect(next.getAttribute('src')?.split('#')[0]).toBe(moved.frame.src);
  });
});

describe('宿主数据能力', () => {
  const CASES = [
    {
      title: 'sessions.list',
      capability: 'sessions:read',
      message: { type: 'sessions.list', parentId: 'a', archived: true, cursor: '20', limit: 5 },
      method: 'sessions/list',
      params: { parentId: 'a', archived: true, cursor: '20', limit: 5 },
      value: { sessions: SESSIONS },
    },
    {
      title: 'sessions.list（不带参数）',
      capability: 'sessions:read',
      message: { type: 'sessions.list' },
      method: 'sessions/list',
      params: {},
      value: { sessions: SESSIONS },
    },
    {
      title: 'turn.abort',
      capability: 'turn:abort',
      message: { type: 'turn.abort', sessionId: 'b', turnId: 't1' },
      method: 'turn/abort',
      params: { sessionId: 'b', turnId: 't1' },
      value: null,
    },
  ];

  for (const { title, capability, message, method, params, value } of CASES) {
    it(`${title}：申请了 ${capability} 时转发 ${method}，参数逐字对上，sessions.list 的结果不带 groups`, async () => {
      app = await renderApp(ROSTER_PATH, handlers, rosterRest());
      const peer = await connect();
      const before = requests(method).length;
      expect(await ask(peer, message)).toEqual({ type: 'result', id: nextId, ok: true, value });
      expect(requests(method).slice(before)).toEqual([params]);
    });

    it(`${title}：没申请 ${capability} 时回 denied、不发请求`, async () => {
      app = await renderApp(pagePath(BOARD), handlers, boardRest());
      const peer = await connect();
      const before = requests(method).length;
      expect(await ask(peer, message)).toMatchObject(failed('denied'));
      expect(requests(method)).toHaveLength(before);
    });
  }

  it('sessions.changed：申请了 sessions:read 的框架挂载起收到（不带 groups）；没申请的收不到', async () => {
    app = await renderApp(ROSTER_PATH, handlers, rosterRest());
    const roster = await connect();
    const change = { upserts: [summary('c')], removes: ['d'], groups: [group('zz-im')] };
    act(() => server().notify('sessions/changed', change));
    expect(roster.received.filter(message => message.type === 'sessions.changed')).toEqual([
      { type: 'sessions.changed', upserts: change.upserts, removes: change.removes },
    ]);
    app.close();

    app = await renderApp(pagePath(BOARD), handlers, boardRest());
    const board = await connect();
    act(() => server().notify('sessions/changed', change));
    expect(board.received.filter(message => message.type === 'sessions.changed')).toEqual([]);
  });

  it('会话服务不在时回 unavailable；会话协议的 not-found 对到 not-found，参数不合对到 invalid，其余对到 failed', async () => {
    const missing = Object.assign(new Error('没有这个会话'), { code: 'not-found' });
    app = await renderApp(
      ROSTER_PATH,
      { ...handlers, 'sessions/list': undefined, 'turn/abort': undefined },
      rosterRest(),
    );
    const peer = await connect();

    const notFound = peer.request({ type: 'turn.abort', sessionId: 'zz' });
    await vi.waitFor(() => expect(requests('turn/abort')).toHaveLength(1));
    server().fail('turn/abort', missing.message, missing.code);
    expect(await act(() => notFound)).toMatchObject({
      ok: false,
      error: { code: 'not-found', message: '没有这个会话' },
    });

    const invalid = peer.request({ type: 'sessions.list', limit: 5000 });
    await vi.waitFor(() => expect(requests('sessions/list').at(-1)).toEqual({ limit: 5000 }));
    const { id } = server().request('sessions/list');
    act(() => server().push({ jsonrpc: '2.0', id, error: { code: -32602, message: 'limit 太大' } }));
    expect(await act(() => invalid)).toMatchObject({ ok: false, error: { code: 'invalid', message: 'limit 太大' } });

    const broken = peer.request({ type: 'turn.abort', sessionId: 'a' });
    await vi.waitFor(() => expect(requests('turn/abort')).toHaveLength(2));
    act(() =>
      server().push({
        jsonrpc: '2.0',
        id: server().request('turn/abort').id,
        error: { code: -32603, message: '停不下来' },
      }),
    );
    expect(await act(() => broken)).toMatchObject({ ok: false, error: { code: 'failed', message: '停不下来' } });

    act(() => server().drop());
    expect(await ask(peer, { type: 'sessions.list' })).toMatchObject(failed('unavailable'));
    expect(await ask(peer, { type: 'turn.abort', sessionId: 'a' })).toMatchObject(failed('unavailable'));
  });
});

describe('上限与卸载', () => {
  it('在途最多 8 个：第 9 个回 busy，回来一个之后又能发', async () => {
    const gates: Array<() => void> = [];
    app = await renderApp(
      pagePath(BOARD),
      {},
      boardRest({
        [dataPath(BOARD, 'slow')]: () => new Promise(resolve => gates.push(() => resolve(data('慢')))),
      }),
    );
    const peer = await connect();
    const slow = Array.from({ length: MAX_PENDING }, () => peer.request({ type: 'data', source: 'slow' }));
    await vi.waitFor(() => expect(gets(dataPath(BOARD, 'slow'))).toBe(MAX_PENDING));
    expect(await ask(peer, { type: 'data', source: 'cards' })).toMatchObject(failed('busy'));

    gates[0]();
    expect(await act(() => slow[0])).toMatchObject({ ok: true, value: '慢' });
    expect(await ask(peer, { type: 'data', source: 'cards' })).toMatchObject({ ok: true });
    for (const gate of gates.slice(1)) gate();
    await act(() => Promise.all(slow));
  });

  it('每秒最多 200 条：超了卸载框架、写明发了太多消息、记告警，监听与端口回到挂上前；过了一秒重新计', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app = await renderApp(pagePath(BOARD), {}, boardRest());
    const counts = countHandlers(app);
    const baseline = counts();
    const peer = await connect();
    const time = clock();
    for (let i = 0; i < MESSAGES_PER_SECOND; i += 1) peer.send({ type: 'nope' });
    time.advance(1_000);
    for (let i = 0; i < MESSAGES_PER_SECOND; i += 1) peer.send({ type: 'nope' });
    expect(frame()).not.toBeNull();
    time.advance(999);
    peer.send({ type: 'nope' });
    expect(frame()).toBeNull();
    expect(screen.getByText('这个页面发了太多消息，已停止显示')).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual(baseline);
    expect(channels.every(channel => channel.port1.closed)).toBe(true);
  });

  it('挂载、卸载 100 次后：窗口消息监听、管理与会话连接上的处理函数、端口、主题观察者与计时器都回到基线', async () => {
    app = await renderApp(ROSTER_PATH, handlers, rosterRest());
    vi.useFakeTimers();
    const counts = countHandlers(app);

    // 一半握手完再卸载，一半在等握手时卸载
    const cycle = async (handshake: boolean) => {
      const iframe = await findFrame();
      fireEvent.load(iframe);
      if (handshake) await connect(iframe);
      refresh();
    };
    await cycle(true);
    const baseline = counts();
    const timers = vi.getTimerCount();
    for (let i = 0; i < 100; i += 1) await cycle(i % 2 === 0);
    expect(counts()).toEqual(baseline);
    // 外壳自己的计时器在这期间可能到点，只核没有多出来的
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers);
    expect(channels).toHaveLength(51);
    expect(channels.every(channel => channel.port1.closed)).toBe(true);
  });
});
