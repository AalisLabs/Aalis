import type { ApprovalSurface } from '../../packages/api-approval/src/index.js';
import {
  ErrorFrameSchema,
  SESSION_PROTOCOL_VERSION,
  type SessionItem,
  type SessionMethod,
  type SessionMethodParams,
  type SessionMethodResult,
  type SessionNotification,
  type SessionNotificationParams,
  type SessionPeer,
  type SessionProtocolService,
  sessionMethods,
  sessionNotifications,
} from '../../packages/api-session-protocol/src/index.js';
import { raw as rawData } from '../../packages/plugin-session-server/src/connection.js';
import { type Localized, localize } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// 会话协议的测试客户端：经 sessionProtocol.connect 直接收发帧，不走网络。收到的帧逐条解析留存；
// 结果与通知先过协议 schema 再交给用例，类型是线上的形状（文字已按连接的读者渲染成字符串）。线上一律是字符串：
// 收到的帧里除去服务端不渲染的原样数据，出现文字对象就抛错（判据与服务端同一个）。
// ════════════════════════════════════════════════════════════

/** 不接审批服务的审批面：只看会话、不涉及审批的用例用它 */
export const DETACHED_SURFACE: ApprovalSurface = {
  name: 'webui',
  attend: () => ({
    presence() {},
    undelivered() {},
    present: () => false,
    respond: () => ({ ok: false, refusal: 'unavailable', message: '审批服务不在' }),
    leave() {},
  }),
};

const OWNER: Omit<SessionPeer, 'disconnect'> = {
  identity: { platform: 'webui', userId: 'console' },
  surface: DETACHED_SURFACE,
};
export const CLIENT = { name: 'test-client', version: '0.0.0' };

export type Frame = Record<string, unknown> & { id?: unknown; method?: string };

type Snapshot = Localized<SessionMethodResult<'session/subscribe'>>;

/** 一条连接：call 发请求、取回同 id 的回应并过 schema，fail 取回错误帧 */
export function client(server: SessionProtocolService, peer: Omit<SessionPeer, 'disconnect'> = OWNER) {
  const frames: Frame[] = [];
  const disconnects: string[] = [];
  const conn = server.connect({ ...peer, disconnect: reason => disconnects.push(reason) }, text => {
    const frame = JSON.parse(text) as Frame;
    localize(
      frame,
      ref => {
        throw new Error(`线上出现了文字对象：${JSON.stringify(ref)}`);
      },
      rawData,
    );
    frames.push(frame);
  });
  let nextId = 0;

  /** 送一帧原文，回这一帧引出的全部新帧 */
  const raw = async (frame: unknown) => {
    const before = frames.length;
    await conn.receive(typeof frame === 'string' ? frame : JSON.stringify(frame));
    return frames.slice(before);
  };
  const request = async (method: string, params?: unknown): Promise<Frame> => {
    const id = ++nextId;
    await conn.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    const reply = frames.find(f => f.id === id);
    if (!reply) throw new Error(`${method} 没有回应`);
    return reply;
  };
  /** 发请求，结果先过这个方法的结果 schema */
  const call = async <M extends SessionMethod>(method: M, params: SessionMethodParams<M>) => {
    const reply = await request(method, params);
    if ('error' in reply) throw new Error(`${method} 出错：${JSON.stringify(reply.error)}`);
    return sessionMethods[method].result.parse(reply.result) as Localized<SessionMethodResult<M>>;
  };
  /** 发请求，回应须是错误帧 */
  const fail = async (method: string, params?: unknown) => {
    const reply = await request(method, params);
    return ErrorFrameSchema.parse(reply).error;
  };
  /** 收到过的某种通知，参数先过 schema */
  const notifications = <N extends SessionNotification>(name: N) =>
    frames
      .filter(f => f.method === name)
      .map(f => sessionNotifications[name].parse(f.params) as Localized<SessionNotificationParams<N>>);
  /** 握手 */
  const init = () => call('initialize', { protocolVersion: SESSION_PROTOCOL_VERSION, client: CLIENT });
  const list = (params: SessionMethodParams<'sessions/list'> = {}) => call('sessions/list', params);
  /** 在列表里找一条摘要（列表默认一页 50 条，用例里的会话不超过一页） */
  const summary = async (id: string) => {
    const page = await list();
    const hit = page.sessions.find(s => s.id === id);
    if (!hit) throw new Error(`列表里没有 ${id}`);
    return hit;
  };

  /**
   * 订阅一个会话，返回快照与这次订阅之后收到的条目推送。推送须在快照回应之后到达，
   * 否则抛错：服务端保证快照回应之前不推这个会话的条目。
   */
  const subscribe = async (sessionId: string) => {
    const from = frames.length;
    const snapshot = await call('session/subscribe', { sessionId });
    const replyAt = frames.findIndex((f, i) => i >= from && 'result' in f);
    const early = frames
      .slice(from, replyAt)
      .filter(f => f.method?.startsWith('item/') && (f.params as { sessionId?: string }).sessionId === sessionId);
    if (early.length > 0) throw new Error(`快照回应之前收到了 ${early.length} 条推送`);
    return { snapshot, from: replyAt + 1 };
  };

  /**
   * 客户端的时间线：快照里的条目，按序叠上之后的推送。丢掉 seq 不大于快照的推送；
   * started 与 completed 按 itemId 放入或覆盖，delta 接在消息、思考的正文或工具输出后面。
   */
  const timeline = (sessionId: string, base: { snapshot: Snapshot; from: number }) => {
    const items = new Map<string, Localized<SessionItem>>(
      base.snapshot.items.map(item => [item.itemId, structuredClone(item)]),
    );
    for (const frame of frames.slice(base.from)) {
      const params = frame.params as { sessionId?: string; seq?: number } | undefined;
      if (!frame.method?.startsWith('item/') || params?.sessionId !== sessionId) continue;
      if ((params.seq ?? 0) <= base.snapshot.seq) continue;
      if (frame.method === 'item/delta') {
        const { itemId, text } = sessionNotifications['item/delta'].parse(frame.params);
        const item = items.get(itemId);
        if (!item) throw new Error(`delta 指向不存在的条目 ${itemId}`);
        if (item.kind === 'tool-call') item.output = (item.output ?? '') + text;
        else if (item.kind === 'agent-message' || item.kind === 'reasoning') item.text += text;
        else throw new Error(`delta 指向 ${item.kind} 条目`);
        continue;
      }
      const { item } = sessionNotifications['item/completed'].parse(frame.params);
      items.set(item.itemId, item as Localized<SessionItem>);
    }
    return [...items.values()];
  };

  return {
    conn,
    frames,
    disconnects,
    raw,
    call,
    fail,
    notifications,
    init,
    list,
    summary,
    subscribe,
    timeline,
  };
}
