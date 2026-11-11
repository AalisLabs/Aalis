// ════════════════════════════════════════════════════════════
// 终端的会话视图：经会话协议在进程内接到会话服务，传输只有 connect(peer, send) 这一处。握手之后跟着后台任务（收起规则要知道
// 任务还在不在跑），订阅终端的会话，把条目与增量交给聊天区。帧的规则同 WebUI 的会话客户端：请求按 id 配对；推送的 epoch 变了
// 重新订阅，seq 不大于快照的丢掉；收到 session/resync 重新订阅。快照里只取还没收尾的回合的条目：已收尾的历史不画，聊天区是这次
// 运行的记录。计划、用量与排着的输入不进聊天区。
// 进程内的帧是同步送达的：会话服务发出订阅的回应之后，紧接着在同一拍补发取快照期间暂存的推送，所以快照在回应到达的那一拍就交给
// 聊天区、写上位置，不等 Promise 的下一拍。握手出错（版本不合、取后台任务出错）时关掉这条连接，她的回复只整条写出。
// 审批经审批面直接接入，不走这条连接：连接不上报在场，收不到审批推送
// ════════════════════════════════════════════════════════════

import {
  type BackgroundTask,
  type ErrorCode,
  SESSION_PROTOCOL_VERSION,
  type SessionConnection,
  type SessionItem,
  type SessionMethod,
  type SessionMethodParams,
  type SessionMethodResult,
  type SessionNotificationParams,
  type SessionPeer,
  type SessionProtocolService,
} from '@aalis/api-session-protocol';
import type { Logger } from '@aalis/core';
import type { Localized } from '@aalis/schema-i18n';

/** 聊天区画的条目：时间线上的条目，计划、用量与排着的输入不算（与 WebUI 的时间线同一取法）。帧里的文字已渲染成字符串 */
export type TimelineItem = Localized<Exclude<SessionItem, { kind: 'plan' | 'usage' | 'queue' }>>;
const inTimeline = (item: Localized<SessionItem>): item is TimelineItem =>
  item.kind !== 'plan' && item.kind !== 'usage' && item.kind !== 'queue';

/** 终端在进程内接入，没有单独发版的客户端：版本写它实现的协议版本 */
const CLIENT = { name: 'cli', version: SESSION_PROTOCOL_VERSION };

/** 会话服务回了错误；reason 是业务错误码 */
class RequestFailed extends Error {
  constructor(
    message: string,
    readonly reason?: ErrorCode,
  ) {
    super(message);
  }
}

/** 请求所在的连接已断开（会话服务断开了它，或换了提供者）：在途的作废，不算出错 */
class ConnectionLost extends Error {}

type ErrorBody = { message: string; data?: { code: ErrorCode } };

type IncomingFrame =
  | { id: number; result: unknown }
  | { id: number; error: ErrorBody }
  | { id: null; error: ErrorBody }
  | { method: string; params: unknown };

/** 推送的位置：哪个会话、哪次启动、第几个 */
type Push = SessionNotificationParams<'session/resync'>;
type BackgroundChange = Localized<SessionNotificationParams<'background/changed'>>;
type Snapshot = Localized<SessionMethodResult<'session/subscribe'>>;

/** 等着回应的请求：回应到达的那一拍调 */
interface Waiting {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

interface SessionViewSink {
  /** 一个条目开始或更新（同一 itemId 覆盖） */
  item(item: TimelineItem): void;
  /** 流式增量：接在这个条目的正文后面 */
  delta(itemId: string, text: string): void;
  /** 后台任务的状态变了 */
  tasks(): void;
}

export class SessionView {
  private conn?: SessionConnection;
  /** 这次连接的握手与后台任务的首次取数 */
  private ready: Promise<void> = Promise.resolve();
  private nextId = 0;
  private readonly pending = new Map<number, Waiting>();
  /** 最近一次快照的位置；没订上或正在订时为空，这期间的推送都丢掉 */
  private position?: { epoch: string; seq: number };
  /** 每次订阅加一，只认最后一次订阅回来的快照 */
  private generation = 0;
  private subscribing?: Promise<void>;
  /** 后台任务的状态，按任务 id */
  private readonly tasks = new Map<string, BackgroundTask['status']>();
  /** 取后台任务列表期间到的增量，取完以后补上 */
  private listing?: BackgroundChange[];

  constructor(
    private readonly sessionId: string,
    private readonly peer: Omit<SessionPeer, 'disconnect'>,
    private readonly sink: SessionViewSink,
    private readonly logger: Logger,
  ) {}

  /** 转到后台的调用的任务还在跑 */
  readonly taskRunning = (taskId: string): boolean => this.tasks.get(taskId) === 'running';

  /**
   * 她回复的正文由条目画：订着终端的会话。握手或订阅在途时等到都落定再答：这期间推来的条目由会话服务暂存、回应之后补发，先整条
   * 写出的话条目来了又画一遍。回应之后同一拍补发的 resync 会再订一次，所以等到没有在途的订阅
   */
  async drawsReplies(): Promise<boolean> {
    await this.ready;
    while (this.subscribing) await this.subscribing;
    return this.position !== undefined;
  }

  /** 接到这一家会话服务（follow 的挂载）：交回的清理关掉这条连接 */
  attach(service: SessionProtocolService): () => void {
    const conn: SessionConnection = service.connect({ ...this.peer, disconnect: () => this.drop(conn) }, frame => {
      if (this.conn === conn) this.receive(frame);
    });
    this.conn = conn;
    this.ready = this.handshake(conn);
    return () => {
      this.drop(conn);
      conn.close();
    };
  }

  /** 还没订上就订，等订阅落定；会话服务不在时立即返回。订不上不抛（照整条回复写） */
  async ensureSubscribed(): Promise<void> {
    await this.ready;
    if (this.conn && !this.position) await (this.subscribing ?? this.subscribe());
  }

  /** 握手、跟上后台任务，再订阅；连接在这期间断开就停下 */
  private async handshake(conn: SessionConnection): Promise<void> {
    try {
      await this.request(conn, 'initialize', { protocolVersion: SESSION_PROTOCOL_VERSION, client: CLIENT });
      await this.request(conn, 'background/watch', {});
      this.listing = [];
      const listed = await this.request(conn, 'background/list', {}).then(
        ({ tasks }) => tasks,
        (err: unknown) => {
          // 没有后台任务登记：按没有任务
          if (err instanceof RequestFailed && err.reason === 'unsupported') return [];
          throw err;
        },
      );
      if (this.conn !== conn) return;
      this.tasks.clear();
      for (const task of listed) this.tasks.set(task.id, task.status);
      for (const change of this.listing) this.apply(change);
      this.listing = undefined;
      this.sink.tasks();
    } catch (err) {
      if (err instanceof ConnectionLost) return;
      this.logger.warn('终端接入会话服务失败，聊天区只写整条回复:', err);
      this.drop(conn);
      conn.close();
      return;
    }
    await this.subscribe();
  }

  private subscribe(): Promise<void> {
    const conn = this.conn;
    if (!conn) return Promise.resolve();
    const generation = ++this.generation;
    this.position = undefined;
    const done = new Promise<void>(settled => {
      const waiting: Waiting = {
        resolve: snapshot => {
          if (generation === this.generation) this.applySnapshot(snapshot as Snapshot);
          settled();
        },
        reject: err => {
          // 会话还没建档：第一条消息发出之前建档后再订
          if (generation === this.generation && !(err instanceof RequestFailed && err.reason === 'not-found')) {
            this.logger.warn(`终端订阅会话 ${this.sessionId} 失败，聊天区只写整条回复:`, err);
          }
          settled();
        },
      };
      this.send(conn, 'session/subscribe', { sessionId: this.sessionId }, waiting);
    }).finally(() => {
      if (this.subscribing === done) this.subscribing = undefined;
    });
    this.subscribing = done;
    return done;
  }

  private applySnapshot(snapshot: Snapshot): void {
    this.position = { epoch: snapshot.epoch, seq: snapshot.seq };
    const open = new Set(
      snapshot.items.flatMap(item => (item.kind === 'turn' && item.outcome === undefined ? [item.turnId] : [])),
    );
    for (const item of snapshot.items) {
      if (item.turnId !== undefined && open.has(item.turnId) && inTimeline(item)) this.sink.item(item);
    }
  }

  /** 在 conn 上发一个请求，回应到达的那一拍交给 waiting；它已不是当前的连接时以 ConnectionLost 失败 */
  private send<M extends SessionMethod>(
    conn: SessionConnection,
    method: M,
    params: SessionMethodParams<M>,
    waiting: Waiting,
  ): void {
    if (this.conn !== conn) {
      waiting.reject(new ConnectionLost());
      return;
    }
    const id = ++this.nextId;
    this.pending.set(id, waiting);
    void conn.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }

  /** {@link send} 的 Promise 写法：回应到达之后的下一拍落定 */
  private request<M extends SessionMethod>(
    conn: SessionConnection,
    method: M,
    params: SessionMethodParams<M>,
  ): Promise<Localized<SessionMethodResult<M>>> {
    return new Promise((resolve, reject) =>
      this.send(conn, method, params, {
        resolve: result => resolve(result as Localized<SessionMethodResult<M>>),
        reject,
      }),
    );
  }

  private receive(text: string): void {
    const frame = JSON.parse(text) as IncomingFrame;
    if ('method' in frame) {
      this.notify(frame.method, frame.params);
      return;
    }
    if (frame.id === null) {
      // id 为空的错误帧：会话服务认不出终端发的这一帧，只会是终端的缺陷
      this.logger.warn('会话服务拒收了终端发的一帧:', frame.error.message);
      return;
    }
    const waiting = this.pending.get(frame.id) as Waiting;
    this.pending.delete(frame.id);
    if ('error' in frame) waiting.reject(new RequestFailed(frame.error.message, frame.error.data?.code));
    else waiting.resolve(frame.result);
  }

  private notify(method: string, params: unknown): void {
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const push = params as Localized<SessionNotificationParams<'item/started'>>;
        if (this.accept(push) && inTimeline(push.item)) this.sink.item(push.item);
        return;
      }
      case 'item/delta': {
        const push = params as SessionNotificationParams<'item/delta'>;
        if (this.accept(push)) this.sink.delta(push.itemId, push.text);
        return;
      }
      case 'session/resync':
        if (this.accept(params as Push)) void this.subscribe();
        return;
      case 'background/changed': {
        const change = params as BackgroundChange;
        if (this.listing) this.listing.push(change);
        else {
          this.apply(change);
          this.sink.tasks();
        }
        return;
      }
    }
  }

  /** 推送是否该交给聊天区：快照之后、没见过的才交，epoch 变了（会话服务重启过）就重新订阅 */
  private accept({ sessionId, epoch, seq }: Push): boolean {
    const position = this.position;
    if (sessionId !== this.sessionId || !position) return false;
    if (epoch !== position.epoch) {
      void this.subscribe();
      return false;
    }
    if (seq <= position.seq) return false;
    position.seq = seq;
    return true;
  }

  private apply(change: BackgroundChange): void {
    for (const task of change.upserts) this.tasks.set(task.id, task.status);
    for (const id of change.removes) this.tasks.delete(id);
  }

  /** 连接断开（会话服务断开它，或这次挂载清理）：等着的请求失败，订阅作废 */
  private drop(conn: SessionConnection): void {
    if (this.conn !== conn) return;
    this.conn = undefined;
    this.position = undefined;
    this.generation++;
    this.listing = undefined;
    this.tasks.clear();
    for (const waiting of this.pending.values()) waiting.reject(new ConnectionLost());
    this.pending.clear();
  }
}
