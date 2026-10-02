// ════════════════════════════════════════════════════════════
// 会话协议的连接层：JSON-RPC 帧的解析与校验、握手、按方法表分派、错误帧、推送与断开。
// 每条连接接入它所在的审批面（对端的登记句柄），审批推送经它到达，在场上报与应答也经它。
// 方法的业务逻辑不在这里，由 index 传入的处理函数表承担。
// ════════════════════════════════════════════════════════════

import type { ApprovalAttendance } from '@aalis/api-approval';
import {
  type ErrorCode,
  RequestFrameSchema,
  RPC_ERROR_CODES,
  SESSION_PROTOCOL_VERSION,
  type SessionConnection,
  type SessionMethod,
  type SessionMethodParams,
  type SessionMethodResult,
  type SessionNotification,
  type SessionNotificationParams,
  type SessionPeer,
  sessionMethods,
} from '@aalis/api-session-protocol';
import type { Logger } from '@aalis/core';

/** 处理函数抛出它，连接层把它写成错误帧；数值码见 RPC_ERROR_CODES，业务错误另带 reason（error.data.code） */
export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly reason?: ErrorCode,
  ) {
    super(message);
  }
}

/** 业务错误 */
export function failure(reason: ErrorCode, message: string): ProtocolError {
  return new ProtocolError(RPC_ERROR_CODES.applicationError, message, reason);
}

/** 一条已握手的连接，处理函数从它取对端、登记 watch 与订阅 */
export interface ServerConnection {
  readonly peer: SessionPeer;
  /** 这条连接在它所在审批面上的接入：在场上报与应答 */
  readonly attendance: ApprovalAttendance;
  /** 调过 sessions/watch，会话列表的增量推给它 */
  watching: boolean;
  /**
   * 订阅一个会话（已订阅的换成新的一份）。返回的 release 调用之前，这个会话的推送先攒着；release 时按序补发，之后照常推送。
   * 订阅在快照取定的同一拍登记、回应发出之后 release，快照之后的推送一条不漏，也不会跑到快照前面。
   * 取快照失败时 cancel 撤掉这次登记。两者只在这个会话登记的仍是这一次时生效，不碰同一连接之后的另一次订阅
   */
  subscribe(sessionId: string): { release(): void; cancel(): void };
  unsubscribe(sessionId: string): void;
}

/** 一次请求：afterReply 登记的动作在这次请求的成功回应发出之后执行 */
export interface RequestContext {
  afterReply(action: () => void): void;
}

/** 方法名 → 处理函数。initialize 由连接层自己处理 */
export type MethodHandlers = {
  [M in Exclude<SessionMethod, 'initialize'>]: (
    params: SessionMethodParams<M>,
    conn: ServerConnection,
    request: RequestContext,
  ) => SessionMethodResult<M> | Promise<SessionMethodResult<M>>;
};

type Frame = Record<string, unknown>;

type LiveConnection = ServerConnection & {
  /** 订阅的会话 → 攒着的推送；null 为照常推送 */
  readonly subscriptions: Map<string, string[] | null>;
  send(frame: Frame): void;
  sendText(frame: string): void;
  drop(): void;
};

const SERVER_NAME = '@aalis/plugin-session-server';

const majorOf = (version: string) => version.split('.')[0];

export function createSessionServer(handlers: MethodHandlers, logger: Logger) {
  const connections = new Set<LiveConnection>();

  function connect(peer: SessionPeer, send: (frame: string) => void): SessionConnection {
    let initialized = false;
    let closed = false;
    /** 握手时主版本不合：回完错误帧再断开 */
    let farewell: string | undefined;
    const subscriptions = new Map<string, string[] | null>();
    // 审批推送只发给上报过在场的连接，在场上报要先握手：握手之前不会有推送
    const attendance = peer.surface.attend(peer.identity, {
      requested: approval => {
        const params: SessionNotificationParams<'approval/requested'> = { approval };
        conn.send({ method: 'approval/requested', params });
      },
      settled: (approvalId, state) => {
        const params: SessionNotificationParams<'approval/settled'> = { approvalId, state };
        conn.send({ method: 'approval/settled', params });
      },
    });
    const conn: LiveConnection = {
      peer,
      attendance,
      watching: false,
      subscriptions,
      sendText(frame) {
        if (!closed) send(frame);
      },
      send(frame) {
        conn.sendText(JSON.stringify({ jsonrpc: '2.0', ...frame }));
      },
      subscribe(sessionId) {
        const held: string[] = [];
        subscriptions.set(sessionId, held);
        return {
          release() {
            if (subscriptions.get(sessionId) !== held) return;
            subscriptions.set(sessionId, null);
            for (const frame of held) conn.sendText(frame);
          },
          cancel() {
            if (subscriptions.get(sessionId) === held) subscriptions.delete(sessionId);
          },
        };
      },
      unsubscribe(sessionId) {
        subscriptions.delete(sessionId);
      },
      drop() {
        closed = true;
        connections.delete(conn);
        attendance.leave();
      },
    };
    connections.add(conn);

    const initialize = (params: SessionMethodParams<'initialize'>): SessionMethodResult<'initialize'> => {
      if (initialized) throw new ProtocolError(RPC_ERROR_CODES.invalidRequest, '这条连接已经握过手');
      if (majorOf(params.protocolVersion) !== majorOf(SESSION_PROTOCOL_VERSION)) {
        farewell = `协议主版本不同：客户端 ${params.protocolVersion}，服务端 ${SESSION_PROTOCOL_VERSION}`;
        throw failure('unsupported', farewell);
      }
      initialized = true;
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        experimental: true,
        server: { name: SERVER_NAME },
        identity: peer.identity,
        surface: peer.surface.name,
      };
    };

    const dispatch = async (method: string, params: unknown, request: RequestContext): Promise<unknown> => {
      if (!Object.hasOwn(sessionMethods, method)) {
        throw new ProtocolError(RPC_ERROR_CODES.methodNotFound, `没有这个方法：${method}`);
      }
      const spec = sessionMethods[method as SessionMethod];
      const handler = method === 'initialize' ? initialize : handlers[method as keyof MethodHandlers];
      const parsed = spec.params.safeParse(params ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || '参数'}：${issue.message}`);
        throw new ProtocolError(RPC_ERROR_CODES.invalidParams, detail.join('；'));
      }
      if (method !== 'initialize' && !initialized) {
        throw new ProtocolError(RPC_ERROR_CODES.invalidRequest, '请先 initialize 握手');
      }
      return (handler as (params: unknown, conn: ServerConnection, request: RequestContext) => unknown)(
        parsed.data,
        conn,
        request,
      );
    };

    const fail = (id: string | number | null, code: number, message: string, reason?: ErrorCode) =>
      conn.send({ id, error: { code, message, ...(reason ? { data: { code: reason } } : {}) } });

    return {
      async receive(raw) {
        if (closed) return;
        let frame: unknown;
        try {
          frame = JSON.parse(raw);
        } catch {
          fail(null, RPC_ERROR_CODES.parseError, '帧不是合法的 JSON');
          return;
        }
        const request = RequestFrameSchema.safeParse(frame);
        if (!request.success) {
          fail(null, RPC_ERROR_CODES.invalidRequest, '不是 JSON-RPC 2.0 请求');
          return;
        }
        const { id, method, params } = request.data;
        const after: Array<() => void> = [];
        try {
          conn.send({ id, result: await dispatch(method, params, { afterReply: action => void after.push(action) }) });
          for (const action of after) action();
        } catch (err) {
          if (err instanceof ProtocolError) {
            fail(id, err.code, err.message, err.reason);
          } else {
            logger.warn(`处理 ${method} 出错:`, err);
            fail(id, RPC_ERROR_CODES.internalError, err instanceof Error ? err.message : String(err));
          }
        }
        if (farewell !== undefined) {
          conn.drop();
          peer.disconnect(farewell);
        }
      },
      close: conn.drop,
    };
  }

  /** 推一条通知给 to 选中的连接；没有连接要推时不调 build */
  function notify<N extends SessionNotification>(
    method: N,
    build: () => SessionNotificationParams<N>,
    to: (conn: ServerConnection) => boolean,
  ): void {
    const targets = [...connections].filter(to);
    if (targets.length === 0) return;
    const params = build();
    for (const conn of targets) conn.send({ method, params });
  }

  /** 推一条通知给订阅了这个会话的连接；订阅还在等快照回应的先攒着 */
  function notifySession<N extends SessionNotification>(
    sessionId: string,
    method: N,
    params: SessionNotificationParams<N>,
  ): void {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const conn of connections) {
      const held = conn.subscriptions.get(sessionId);
      if (held) held.push(frame);
      else if (held === null) conn.sendText(frame);
    }
  }

  /** 有连接订阅着的会话 */
  function subscribedSessions(): Set<string> {
    return new Set([...connections].flatMap(conn => [...conn.subscriptions.keys()]));
  }

  /** 断开全部连接（会话服务停止时），客户端重连到新的提供者 */
  function disconnectAll(reason: string): void {
    for (const conn of [...connections]) {
      conn.drop();
      conn.peer.disconnect(reason);
    }
  }

  return { connect, notify, notifySession, subscribedSessions, disconnectAll };
}
