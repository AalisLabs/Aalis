// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_PROTOCOL_VERSION,
  type SessionItem,
  type SessionMethodResult,
} from '../../packages/api-session-protocol/src/index.js';
import {
  ConnectionLostError,
  createSessionClient,
  PROTOCOL_VERSION,
  RequestError,
  type SessionClient,
  type SubscriptionListener,
} from '../../packages/plugin-webui-client/src/protocol/session-client.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';

// ════════════════════════════════════════════════════════════
// 会话协议客户端：握手、请求与回应配对、订阅多个会话、按 epoch 与 seq 去重、断线重连后重新握手与订阅、resync 重取。
// 用假的 WebSocket 驱动，重连的退避用假时钟推进
// ════════════════════════════════════════════════════════════

type Snapshot = SessionMethodResult<'session/subscribe'>;

const init: SessionMethodResult<'initialize'> = {
  protocolVersion: '1.0',
  experimental: true,
  server: { name: 'server' },
  identity: { platform: 'webui', userId: 'console' },
  surface: 'webui',
  features: { send: true, rewind: false, compress: true },
  appName: 'Aalis',
};

function snapshot(sessionId: string, epoch: string, seq: number): Snapshot {
  return {
    epoch,
    seq,
    session: {
      id: sessionId,
      title: sessionId,
      childCount: 0,
      kind: 'owner',
      section: 'owner',
      createdAt: 1,
      updatedAt: 1,
      running: false,
      error: false,
      unread: false,
      attention: false,
      archived: false,
    },
    items: [],
    approvals: [],
  };
}

const message = (itemId: string, text: string): SessionItem => ({
  kind: 'agent-message',
  itemId,
  at: 1,
  text,
  attachments: [],
});

/** 记下一个会话收到的全部事件 */
function recorder() {
  const events: string[] = [];
  const listener: SubscriptionListener = {
    snapshot: s => events.push(`snapshot ${s.epoch}#${s.seq}`),
    item: (item, phase) => events.push(`${phase} ${item.itemId}`),
    delta: (itemId, text) => events.push(`delta ${itemId} ${text}`),
    failed: error => events.push(`failed ${error.message}`),
  };
  return { events, listener };
}

let client: SessionClient;

/** 打开连接并完成握手 */
async function connect(socket = FakeWebSocket.last): Promise<FakeWebSocket> {
  socket.open();
  socket.reply('initialize', init);
  await vi.waitFor(() => expect(client.state.status).toBe('open'));
  return socket;
}

beforeEach(() => {
  FakeWebSocket.install();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ authed: true })),
  );
});

afterEach(() => {
  client.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('握手与请求', () => {
  it('连到页面所在源的 /session，先握手，握手之前发起的请求等握手完再发', async () => {
    client = createSessionClient();
    const socket = FakeWebSocket.last;
    expect(socket.url).toBe('ws://localhost:3000/session');
    expect(client.state.status).toBe('connecting');

    const listed = client.request('sessions/list', {});
    socket.open();
    expect(socket.frames.map(f => f.method)).toEqual(['initialize']);
    expect(socket.request('initialize').params).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'webui', version: expect.any(String) },
    });
    socket.reply('initialize', init);
    await vi.waitFor(() => expect(socket.frames.map(f => f.method)).toEqual(['initialize', 'sessions/list']));
    socket.reply('sessions/list', { sessions: [], groups: [] });
    await expect(listed).resolves.toEqual({ sessions: [], groups: [] });
    expect(client.state.status).toBe('open');
  });

  it('客户端实现的协议主版本与契约一致', () => {
    client = createSessionClient();
    expect(PROTOCOL_VERSION.split('.')[0]).toBe(SESSION_PROTOCOL_VERSION.split('.')[0]);
  });

  it('回应按 id 配对，乱序到达也各归各位；错误帧带上业务错误码', async () => {
    client = createSessionClient();
    const socket = await connect();
    const renamed = client.request('session/rename', { sessionId: 'a', title: '甲' });
    const archived = client.request('session/archive', { sessionId: 'b' });
    await vi.waitFor(() => expect(socket.frames).toHaveLength(3));
    socket.fail('session/archive', '会话不存在：b', 'not-found');
    socket.reply('session/rename', {});
    await expect(renamed).resolves.toEqual({});
    const error = await archived.catch(e => e);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ message: '会话不存在：b', reason: 'not-found' });
  });

  it('id 为空的错误帧（服务端认不出客户端发的帧）作为缺陷抛出，不悄悄丢掉', async () => {
    client = createSessionClient();
    const socket = await connect();
    expect(() =>
      socket.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '不是 JSON-RPC 2.0 请求' } }),
    ).toThrow('服务端拒收了这个客户端发出的一帧：不是 JSON-RPC 2.0 请求');
  });

  it('握手被拒（协议版本不兼容）时停止重连，等着的请求一并失败', async () => {
    vi.useFakeTimers();
    client = createSessionClient();
    const socket = FakeWebSocket.last;
    const listed = client.request('sessions/list', {}).catch(e => e);
    socket.open();
    socket.fail('initialize', '协议主版本不同：客户端 1.0，服务端 2.0', 'unsupported');
    await vi.waitFor(() =>
      expect(client.state).toEqual({ status: 'stopped', reason: '协议主版本不同：客户端 1.0，服务端 2.0' }),
    );
    expect(socket.closedByClient).toBe(true);
    expect(await listed).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.sockets).toHaveLength(1);
  });
});

describe('订阅与去重', () => {
  it('先回快照再收推送，丢掉快照之前与重复的推送，多个会话各自去重', async () => {
    client = createSessionClient();
    const socket = await connect();
    const a = recorder();
    const b = recorder();
    client.subscribe('a', a.listener);
    client.subscribe('b', b.listener);
    await vi.waitFor(() => expect(socket.frames.filter(f => f.method === 'session/subscribe')).toHaveLength(2));
    const [subA, subB] = socket.frames.filter(f => f.method === 'session/subscribe');
    expect(subA.params).toEqual({ sessionId: 'a' });
    expect(subB.params).toEqual({ sessionId: 'b' });

    // 快照到之前的推送丢掉：快照已包含它们
    socket.notify('item/completed', { sessionId: 'a', epoch: 'e1', seq: 3, item: message('m0', '早') });
    socket.push({ jsonrpc: '2.0', id: subA.id, result: snapshot('a', 'e1', 5) });
    socket.push({ jsonrpc: '2.0', id: subB.id, result: snapshot('b', 'e1', 1) });
    await vi.waitFor(() => expect(a.events).toEqual(['snapshot e1#5']));

    socket.notify('item/started', { sessionId: 'a', epoch: 'e1', seq: 5, item: message('m1', '') });
    socket.notify('item/started', { sessionId: 'a', epoch: 'e1', seq: 6, item: message('m2', '') });
    socket.notify('item/delta', { sessionId: 'a', epoch: 'e1', seq: 7, itemId: 'm2', text: '你好' });
    socket.notify('item/delta', { sessionId: 'a', epoch: 'e1', seq: 7, itemId: 'm2', text: '你好' });
    socket.notify('item/completed', { sessionId: 'b', epoch: 'e1', seq: 2, item: message('n1', '乙') });
    socket.notify('item/completed', { sessionId: 'a', epoch: 'e1', seq: 8, item: message('m2', '你好') });
    socket.notify('item/completed', { sessionId: 'c', epoch: 'e1', seq: 9, item: message('x', '没订阅') });

    expect(a.events).toEqual(['snapshot e1#5', 'started m2', 'delta m2 你好', 'completed m2']);
    expect(b.events).toEqual(['snapshot e1#1', 'completed n1']);
  });

  it('epoch 变了重新订阅，取新的快照', async () => {
    client = createSessionClient();
    const socket = await connect();
    const a = recorder();
    client.subscribe('a', a.listener);
    await vi.waitFor(() => socket.request('session/subscribe'));
    socket.reply('session/subscribe', snapshot('a', 'e1', 4));
    await vi.waitFor(() => expect(a.events).toEqual(['snapshot e1#4']));

    socket.notify('item/completed', { sessionId: 'a', epoch: 'e2', seq: 1, item: message('m1', '新') });
    expect(socket.frames.filter(f => f.method === 'session/subscribe')).toHaveLength(2);
    socket.reply('session/subscribe', snapshot('a', 'e2', 1));
    await vi.waitFor(() => expect(a.events).toEqual(['snapshot e1#4', 'snapshot e2#1']));
  });

  it('收到 resync 重取快照，之前的条目作废', async () => {
    client = createSessionClient();
    const socket = await connect();
    const a = recorder();
    client.subscribe('a', a.listener);
    await vi.waitFor(() => socket.request('session/subscribe'));
    socket.reply('session/subscribe', snapshot('a', 'e1', 2));
    await vi.waitFor(() => expect(a.events).toHaveLength(1));

    socket.notify('session/resync', { sessionId: 'a', epoch: 'e1', seq: 3 });
    // 重订的快照到来之前的推送都丢掉
    socket.notify('item/completed', { sessionId: 'a', epoch: 'e1', seq: 4, item: message('m1', '旧') });
    socket.reply('session/subscribe', snapshot('a', 'e1', 4));
    await vi.waitFor(() => expect(a.events).toEqual(['snapshot e1#2', 'snapshot e1#4']));
  });

  it('同一会话重订了两次，只认最后一次的快照', async () => {
    client = createSessionClient();
    const socket = await connect();
    const a = recorder();
    client.subscribe('a', a.listener);
    await vi.waitFor(() => socket.request('session/subscribe'));
    const first = socket.request('session/subscribe').id;
    socket.notify('session/resync', { sessionId: 'a', epoch: 'e1', seq: 1 });
    // 第一次订阅还没回，resync 对还没有快照的订阅不起作用；改由第二个订阅者触发重订
    client.subscribe('a', recorder().listener);
    const second = socket.request('session/subscribe').id;
    expect(second).not.toBe(first);
    socket.push({ jsonrpc: '2.0', id: second, result: snapshot('a', 'e1', 9) });
    socket.push({ jsonrpc: '2.0', id: first, result: snapshot('a', 'e1', 3) });
    await vi.waitFor(() => expect(a.events).toEqual(['snapshot e1#9']));
    socket.notify('item/completed', { sessionId: 'a', epoch: 'e1', seq: 8, item: message('m1', '旧') });
    expect(a.events).toEqual(['snapshot e1#9']);
  });

  it('订阅失败（会话不存在）告诉订阅者；最后一个订阅者退出时退订', async () => {
    client = createSessionClient();
    const socket = await connect();
    const a = recorder();
    const stop = client.subscribe('a', a.listener);
    await vi.waitFor(() => socket.request('session/subscribe'));
    socket.fail('session/subscribe', '会话不存在：a', 'not-found');
    await vi.waitFor(() => expect(a.events).toEqual(['failed 会话不存在：a']));
    stop();
    await vi.waitFor(() => expect(socket.request('session/unsubscribe').params).toEqual({ sessionId: 'a' }));
  });
});

describe('连接级推送', () => {
  it('有人关心会话列表时发 sessions/watch，推送按名字分给登记的处理函数', async () => {
    client = createSessionClient();
    const socket = await connect();
    const changed = vi.fn();
    const features = vi.fn();
    client.on('sessions/changed', changed);
    client.on('features/changed', features);
    await vi.waitFor(() => socket.request('sessions/watch'));
    socket.notify('sessions/changed', { upserts: [], removes: ['a'], groups: [] });
    socket.notify('features/changed', { features: { send: true, rewind: true, compress: false } });
    expect(changed).toHaveBeenCalledWith({ upserts: [], removes: ['a'], groups: [] });
    expect(features).toHaveBeenCalledWith({ features: { send: true, rewind: true, compress: false } });
  });
});

describe('断线重连', () => {
  it('断开后在途的请求失败；按退避重连，重新握手、watch 并重订打开着的会话，取回快照', async () => {
    vi.useFakeTimers();
    client = createSessionClient();
    const ready = vi.fn();
    client.onReady(ready);
    const socket = await connect();
    client.on('sessions/changed', () => {});
    const a = recorder();
    client.subscribe('a', a.listener);
    await vi.waitFor(() => socket.request('session/subscribe'));
    socket.reply('session/subscribe', snapshot('a', 'e1', 2));
    await vi.waitFor(() => expect(a.events).toHaveLength(1));

    const inFlight = client.request('session/rename', { sessionId: 'a', title: '甲' }).catch(e => e);
    socket.drop(1001, '服务停止');
    expect(await inFlight).toBeInstanceOf(ConnectionLostError);
    expect(client.state).toEqual({ status: 'retrying', code: 1001, reason: '服务停止' });

    // 断开期间收到的推送不再处理，新连接要等退避
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const again = FakeWebSocket.last;
    expect(again).not.toBe(socket);
    again.open();
    again.reply('initialize', init);
    await vi.waitFor(() =>
      expect(again.frames.map(f => f.method)).toEqual(['initialize', 'sessions/watch', 'session/subscribe']),
    );
    again.reply('session/subscribe', snapshot('a', 'e2', 0));
    await vi.waitFor(() => expect(a.events).toEqual(['snapshot e1#2', 'snapshot e2#0']));
    expect(client.state.status).toBe('open');
    expect(ready).toHaveBeenCalledTimes(2);
    expect(ready).toHaveBeenLastCalledWith(init);
  });

  it('连续失败时退避拉长，网络恢复或页面回到前台时立即重试', async () => {
    vi.useFakeTimers();
    client = createSessionClient();
    FakeWebSocket.last.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    FakeWebSocket.last.drop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeWebSocket.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.sockets).toHaveLength(3);

    FakeWebSocket.last.drop();
    window.dispatchEvent(new Event('online'));
    expect(FakeWebSocket.sockets).toHaveLength(4);
    FakeWebSocket.last.drop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeWebSocket.sockets).toHaveLength(5);

    // 连上之后退避从头算
    await connect();
    FakeWebSocket.last.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.sockets).toHaveLength(6);
  });

  it('一次也没连上就断开时查登录状态，登录失效就重新加载页面，由服务端给出登录页', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { protocol: 'https:', host: 'aalis.example', reload });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('/api/auth/status');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ authed: false });
      }),
    );
    client = createSessionClient();
    expect(FakeWebSocket.last.url).toBe('wss://aalis.example/session');
    FakeWebSocket.last.drop();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('连上过的连接断开不查登录状态；登录有效时照常重连', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000', reload });
    client = createSessionClient();
    await connect();
    FakeWebSocket.last.drop();
    expect(fetch).not.toHaveBeenCalled();

    client.close();
    client = createSessionClient();
    FakeWebSocket.last.drop();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const sockets = FakeWebSocket.sockets.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.sockets).toHaveLength(sockets + 1);
    expect(reload).not.toHaveBeenCalled();
  });
});
