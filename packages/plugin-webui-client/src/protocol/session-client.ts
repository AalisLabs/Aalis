import type {
  ErrorCode,
  SessionItem,
  SessionMethod,
  SessionMethodParams,
  SessionMethodResult,
  SessionNotification,
  SessionNotificationParams,
} from '@aalis/api-session-protocol';
import { version } from '../../package.json';
import { type ConnectionState, openSocket } from './socket';

// 会话协议的客户端：一条 /session 连接上握手、配对请求与回应、订阅多个会话。
// 推送带 epoch 与按会话递增的 seq：快照之前与不大于快照 seq 的推送丢掉，epoch 变了或收到 resync 就重新订阅取快照。
// 断线后重连，重新握手、watch 并重订打开着的会话；断开时在途的请求以 ConnectionLostError 失败，不重发。

/** 本客户端实现的协议版本 */
export const PROTOCOL_VERSION = '1.0';
const CLIENT = { name: 'webui', version };

export type SessionSnapshot = SessionMethodResult<'session/subscribe'>;
export type InitializeResult = SessionMethodResult<'initialize'>;

/** 服务端回了错误；reason 是业务错误码，帧或参数不合时没有 */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly reason?: ErrorCode,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/** 请求发出后连接断开：服务端可能执行了，也可能没有 */
export class ConnectionLostError extends Error {
  constructor() {
    super('与服务端的连接断开，这次请求没有收到回应');
    this.name = 'ConnectionLostError';
  }
}

/** 一个会话的订阅者：快照（初次与每次重订）、条目的开始与完成、流式增量，以及订阅失败 */
export interface SubscriptionListener {
  snapshot(snapshot: SessionSnapshot): void;
  item(item: SessionItem, phase: 'started' | 'completed'): void;
  delta(itemId: string, text: string): void;
  failed(error: Error): void;
}

/** 不属于某个订阅的推送 */
export type ConnectionNotification = Exclude<
  SessionNotification,
  'item/started' | 'item/delta' | 'item/completed' | 'session/resync'
>;

export interface SessionClient {
  /** 握手完成才算 open */
  readonly state: ConnectionState;
  onState(listener: (state: ConnectionState) => void): () => void;
  /** 每次握手完成（包括重连后的）时调用 */
  onReady(listener: (init: InitializeResult) => void): () => void;
  /** 发一个请求；还没握手时等握手完再发 */
  request<M extends SessionMethod>(method: M, params: SessionMethodParams<M>): Promise<SessionMethodResult<M>>;
  on<N extends ConnectionNotification>(name: N, handler: (params: SessionNotificationParams<N>) => void): () => void;
  /** 订阅一个会话，返回退订。同一会话再来一个订阅者时重新订阅，各订阅者都收到新的快照 */
  subscribe(sessionId: string, listener: SubscriptionListener): () => void;
  close(): void;
}

interface Subscription {
  listeners: Set<SubscriptionListener>;
  /** 最近一次快照的位置；等快照时为空，这期间的推送都丢掉，快照已包含它们 */
  position?: { epoch: string; seq: number };
  /** 每次重新订阅加一，只认最后一次订阅回来的快照 */
  generation: number;
}

interface PushPosition {
  sessionId: string;
  epoch: string;
  seq: number;
}

type ErrorBody = { message: string; data?: { code: ErrorCode } };

type IncomingFrame =
  | { id: number; result: unknown }
  | { id: number; error: ErrorBody }
  | { id: null; error: ErrorBody }
  | { method: string; params: unknown };

/** 后台发出、没人等结果的请求：断线时失败是预期的，别的失败照常抛出 */
export function unlessLost(error: unknown): void {
  if (!(error instanceof ConnectionLostError)) throw error;
}

/** 握手的等待：断线后换一个新的；停止或关闭时拒绝，等着的请求一并失败 */
function handshakeGate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 没有请求在等时被拒绝不算未处理：等着的请求各自从 promise 收到拒绝
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export function createSessionClient(): SessionClient {
  let nextId = 1;
  const pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
  const subscriptions = new Map<string, Subscription>();
  const handlers = new Map<string, Set<(params: never) => void>>();
  const readyListeners = new Set<(init: InitializeResult) => void>();
  /** 当前连接已握手 */
  let ready = false;
  /** 当前连接已发过 sessions/watch */
  let watching = false;
  let handshake = handshakeGate();

  function call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      if (!socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))) {
        reject(new ConnectionLostError());
        return;
      }
      pending.set(id, { resolve, reject });
    });
  }

  function request<M extends SessionMethod>(
    method: M,
    params: SessionMethodParams<M>,
  ): Promise<SessionMethodResult<M>> {
    const sent = ready ? call(method, params) : handshake.promise.then(() => call(method, params));
    return sent as Promise<SessionMethodResult<M>>;
  }

  function watch(): void {
    watching = true;
    request('sessions/watch', {}).catch(unlessLost);
  }

  function resubscribe(sessionId: string): void {
    const subscription = subscriptions.get(sessionId) as Subscription;
    const generation = ++subscription.generation;
    subscription.position = undefined;
    const current = () => subscriptions.get(sessionId) === subscription && subscription.generation === generation;
    request('session/subscribe', { sessionId }).then(
      snapshot => {
        if (!current()) return;
        subscription.position = { epoch: snapshot.epoch, seq: snapshot.seq };
        for (const listener of subscription.listeners) listener.snapshot(snapshot);
      },
      (error: Error) => {
        // 断线时等重连后重订
        if (!current() || error instanceof ConnectionLostError) return;
        for (const listener of subscription.listeners) listener.failed(error);
      },
    );
  }

  /** 推送是否该交给订阅者：快照之后、没见过的才交，epoch 变了就重订 */
  function accept({ sessionId, epoch, seq }: PushPosition): Subscription | undefined {
    const subscription = subscriptions.get(sessionId);
    const position = subscription?.position;
    if (!position) return undefined;
    if (epoch !== position.epoch) {
      resubscribe(sessionId);
      return undefined;
    }
    if (seq <= position.seq) return undefined;
    position.seq = seq;
    return subscription;
  }

  function notify(method: string, params: unknown): void {
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const push = params as SessionNotificationParams<'item/started'>;
        const phase = method === 'item/started' ? 'started' : 'completed';
        for (const listener of accept(push)?.listeners ?? []) listener.item(push.item, phase);
        return;
      }
      case 'item/delta': {
        const push = params as SessionNotificationParams<'item/delta'>;
        for (const listener of accept(push)?.listeners ?? []) listener.delta(push.itemId, push.text);
        return;
      }
      case 'session/resync': {
        const push = params as SessionNotificationParams<'session/resync'>;
        if (accept(push)) resubscribe(push.sessionId);
        return;
      }
      default:
        for (const handler of handlers.get(method) ?? []) (handler as (params: unknown) => void)(params);
    }
  }

  const socket = openSocket('/session', {
    async opened() {
      const init = (await call('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        client: CLIENT,
      })) as InitializeResult;
      ready = true;
      handshake.resolve();
      if (handlers.get('sessions/changed')?.size) watch();
      for (const sessionId of subscriptions.keys()) resubscribe(sessionId);
      for (const listener of readyListeners) listener(init);
    },
    message(text) {
      const frame = JSON.parse(text) as IncomingFrame;
      if ('method' in frame) {
        notify(frame.method, frame.params);
        return;
      }
      // id 为空的错误帧：服务端认不出这一帧是哪个请求（不是 JSON、不合帧格式），只会是客户端的缺陷
      if (frame.id === null) throw new Error(`服务端拒收了这个客户端发出的一帧：${frame.error.message}`);
      const waiting = pending.get(frame.id) as { resolve(result: unknown): void; reject(error: Error): void };
      pending.delete(frame.id);
      if ('error' in frame) waiting.reject(new RequestError(frame.error.message, frame.error.data?.code));
      else waiting.resolve(frame.result);
    },
    closed() {
      for (const waiting of pending.values()) waiting.reject(new ConnectionLostError());
      pending.clear();
      if (ready) handshake = handshakeGate();
      ready = false;
      watching = false;
      for (const subscription of subscriptions.values()) subscription.position = undefined;
    },
  });

  socket.onState(state => {
    if (state.status === 'stopped') handshake.reject(new Error(state.reason));
  });

  return {
    get state() {
      return socket.state;
    },
    onState: listener => socket.onState(listener),
    onReady(listener) {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    request,
    on(name, handler) {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler as (params: never) => void);
      if (name === 'sessions/changed' && ready && !watching) watch();
      return () => set.delete(handler as (params: never) => void);
    },
    subscribe(sessionId, listener) {
      const subscription = subscriptions.get(sessionId) ?? { listeners: new Set(), generation: 0 };
      subscriptions.set(sessionId, subscription);
      subscription.listeners.add(listener);
      // 还没握手时由握手之后统一订阅
      if (ready) resubscribe(sessionId);
      return () => {
        subscription.listeners.delete(listener);
        if (subscription.listeners.size > 0) return;
        subscriptions.delete(sessionId);
        if (ready) request('session/unsubscribe', { sessionId }).catch(unlessLost);
      };
    },
    close() {
      socket.close();
      handshake.reject(new ConnectionLostError());
    },
  };
}
