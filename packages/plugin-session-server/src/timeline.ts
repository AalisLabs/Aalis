// ════════════════════════════════════════════════════════════
// 会话的时间线：订阅与快照、条目推送、历史。
//
// 在途回合的条目由 agent 的事件实时拼出：回合开始与结束、流式的思考与正文、工具调用与它的输出、她的回复。
// 落了库才有的条目（提问、通知、她发出的附件）按存档推送，与历史归并出同一个 itemId。
// 快照 = 已收尾回合的历史 + 还没收尾的回合已产出的条目 + 会话当前的计划与用量 + 未结的审批。推送带 epoch（每次启动换一个）
// 与 seq（这次启动内递增），客户端丢掉 seq 不大于快照的推送。审批本身经连接级推送送达，工具卡上只挂它的 id。
//
// 回合结束之后还在等平台送达结果的，也算没收尾：迟到的结果按实时条目的 itemId 推出，这段时间里订阅的快照
// 照样给出实时条目，两边对得上。送达结果只在实时推送里，存档不记。
//
// 快照的历史要等读存档，读的同时回合照常推进。在途回合落了库的消息带 turnId：取快照那一刻还没收尾的回合、
// 之后才结束或开始的回合，它们落库的消息都不进这份快照的历史，由在途条目与之后的推送给出，两边不重复。
// ════════════════════════════════════════════════════════════

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TokenUsageEvent } from '@aalis/api-agent';
import type { Approval } from '@aalis/api-approval';
import type { HookContextMap } from '@aalis/api-hooks';
import type { MemoryService } from '@aalis/api-memory';
import type { SessionInfo } from '@aalis/api-session-manager';
import type {
  SessionItem,
  SessionMethodResult,
  SessionNotification,
  SessionNotificationParams,
  SessionSummary,
} from '@aalis/api-session-protocol';
import type { TodoItem, TodoListService } from '@aalis/api-todo-list';
import type { ToolExecuteMessage, ToolOutputMessage } from '@aalis/api-tools';
import type { ServiceRef } from '@aalis/core';
import {
  awaitDelivery,
  type IncomingMessage,
  type Message,
  type OutboundDeliveryResult,
  type OutgoingMessage,
  type StreamChunkMessage,
} from '@aalis/schema-message';
import type { MethodHandlers, ServerConnection } from './connection.js';
import {
  archivedItem,
  BEFORE_TOOL_UNSENT,
  HISTORY_PAGE,
  type IsOwner,
  readHistory,
  type SignFile,
  toolFailed,
} from './history.js';

type Outcome = HookContextMap['agent:turn:after']['outcome'];
type Item<K extends SessionItem['kind']> = Extract<SessionItem, { kind: K }>;
type Streamed = Item<'agent-message'> | Item<'reasoning'>;

/** 房间里她没回复就收尾的一轮，说过的话按怎么收的尾写原因 */
const UNSENT: Record<Exclude<Outcome, 'replied'>, string> = {
  silent: '没有发出：这一轮静默结束',
  aborted: '没有发出：回合已中止',
  error: '没有发出：回合出错',
};
const RETRIED = '没有发出：格式校验没通过，已重试';

interface Turn {
  turnId: string;
  sessionId: string;
  /** 房间里的回合：她没发出去的话要标出来，经工具发进房间的消息要等平台收下 */
  room: boolean;
  /** 回合结束时的 seq，快照据此判断这一轮落库的消息算不算进历史 */
  end?: number;
  /** 还在等的送达结果数：不为 0 时这一轮结束了也不算收尾 */
  receipts: number;
  /** 回合条目：开始时带发起方，收尾时带结局 */
  item: Item<'turn'>;
  /** 这一轮已推出的条目，按出现的顺序 */
  items: Map<string, SessionItem>;
  next: number;
  /** 正在流式输出的思考或正文 */
  streaming?: Streamed;
  /** 最近一次工具调用之后她说的话：最后一版是回复，之前的是重试丢掉的 */
  candidates: Item<'agent-message'>[];
  outcome?: Outcome;
  /** 房间里她的回复，回合结束时看平台收没收下 */
  replies: Array<{ message: OutgoingMessage; item: Item<'agent-message'> }>;
  /** 工具调用发出的消息：callId → 消息 */
  sent: Map<string, OutgoingMessage>;
}

interface TimelineDeps {
  memory: ServiceRef<MemoryService>;
  todoList: ServiceRef<TodoListService>;
  isOwner: IsOwner;
  /** 给某个会话里她发出的文件签发下载句柄 */
  signFile(sessionId: string, uri: string, name: string): string | undefined;
  requireSession(id: string): SessionInfo;
  summarize(info: SessionInfo): SessionSummary;
  isRoom(sessionId: string): boolean;
  /** 推一条通知给订阅了这个会话的连接 */
  notify<N extends SessionNotification>(sessionId: string, method: N, params: SessionNotificationParams<N>): void;
  /** 请 agent 重发某会话的用量 */
  requestUsage(sessionId: string, platform: string): void;
  /** 这个会话已推出、还没结的审批 */
  approvalsOf(sessionId: string): Approval[];
  /** 插件停用时中止：不再等平台的送达结果 */
  signal: AbortSignal;
}

export function createTimeline(deps: TimelineDeps) {
  const epoch = crypto.randomUUID();
  let seq = 0;
  /** 在途的回合；已结束的留到不再有快照需要据它判断为止 */
  const turns = new Map<string, Turn>();
  /** 正在读历史的快照各自的 seq */
  const pending: number[] = [];
  /** 每个会话最近一次的用量 */
  const usages = new Map<string, Item<'usage'>>();
  /** 每个会话进行中的压缩 */
  const compressions = new Map<string, Item<'notice'>>();
  /** 回合的异步上下文：她的回复与定稿校验经它认出属于哪一轮 */
  const scope = new AsyncLocalStorage<Turn>();

  const emit = (sessionId: string, method: 'item/started' | 'item/completed', item: SessionItem) =>
    deps.notify(sessionId, method, { sessionId, epoch, seq: ++seq, item });
  const emitDelta = (sessionId: string, itemId: string, text: string) =>
    deps.notify(sessionId, 'item/delta', { sessionId, epoch, seq: ++seq, itemId, text });
  const complete = (turn: Turn, item: SessionItem) => emit(turn.sessionId, 'item/completed', item);
  const signerOf =
    (sessionId: string): SignFile =>
    (uri, name) =>
      deps.signFile(sessionId, uri, name);

  const live = (turnId: string) => {
    const turn = turns.get(turnId);
    return turn?.end === undefined ? turn : undefined;
  };
  const current = () => {
    const turn = scope.getStore();
    return turn?.end === undefined ? turn : undefined;
  };

  function speaker(message: IncomingMessage) {
    const { platform, userId, nickname, source } = message;
    return { platform, userId, nickname, source, owner: deps.isOwner(platform, userId) };
  }

  /**
   * 这一轮的回合条目在她第一次有动静时才推出：提问在回合开头落库，这样实时推送与快照里提问都排在回合条目前面。
   * 一直没动静的一轮在收尾时推出
   */
  function show(turn: Turn): void {
    if (turn.items.size > 0) return;
    turn.items.set(turn.turnId, turn.item);
    emit(turn.sessionId, 'item/started', turn.item);
  }

  function add<T extends SessionItem>(turn: Turn, item: T): T {
    show(turn);
    turn.items.set(item.itemId, item);
    return item;
  }

  function closeStream(turn: Turn): void {
    const open = turn.streaming;
    if (!open) return;
    turn.streaming = undefined;
    complete(turn, open);
  }

  /** 收起最近一次工具调用之后说的话：流式中的那条收尾；给了 reason（房间里没发出去）时每条标出原因再推 */
  function dropCandidates(turn: Turn, reason?: string): void {
    const open = turn.streaming;
    if (reason) for (const said of turn.candidates) said.undelivered = { reason };
    closeStream(turn);
    if (reason) for (const said of turn.candidates) if (said !== open) complete(turn, said);
    turn.candidates = [];
  }

  function append(turn: Turn, kind: Streamed['kind'], delta: string): void {
    const open = turn.streaming;
    if (open?.kind === kind) {
      open.text += delta;
      emitDelta(turn.sessionId, open.itemId, delta);
      return;
    }
    closeStream(turn);
    const base = { itemId: `${turn.turnId}/${++turn.next}`, turnId: turn.turnId, at: Date.now(), text: delta };
    const item: Streamed =
      kind === 'reasoning'
        ? { kind, ...base }
        : { kind, ...base, attachments: [] as Item<'agent-message'>['attachments'] };
    add(turn, item);
    turn.streaming = item;
    if (item.kind === 'agent-message') turn.candidates.push(item);
    emit(turn.sessionId, 'item/started', item);
  }

  function message(turn: Turn, text: string): Item<'agent-message'> {
    return add(turn, {
      kind: 'agent-message',
      itemId: `${turn.turnId}/${++turn.next}`,
      turnId: turn.turnId,
      at: Date.now(),
      text,
      attachments: [],
    });
  }

  /** 她这一轮的回复：最后一版流式正文就是它（没有流式输出时新起一条），之前的几版在房间里是重试丢掉的 */
  function reply(turn: Turn, out: OutgoingMessage): void {
    const open = turn.streaming;
    turn.streaming = undefined;
    const candidates = turn.candidates;
    turn.candidates = [];
    const item = candidates.at(-1) ?? message(turn, out.content);
    if (out.modelInfo) item.model = { provider: out.modelInfo.provider, model: out.modelInfo.model };
    if (open && open !== item) complete(turn, open);
    if (turn.room) {
      for (const discarded of candidates.slice(0, -1)) {
        discarded.undelivered = { reason: RETRIED };
        complete(turn, discarded);
      }
    }
    complete(turn, item);
    if (turn.room) turn.replies.push({ message: out, item });
  }

  /** 平台的送达结果：收下了为 true，没收下（或没有适配器接手、发送出错）回原因；停用前或等满时限还没结果为 undefined */
  async function receipt(out: OutgoingMessage): Promise<true | string | undefined> {
    if (!out.delivery) return '没有发出：没有平台适配器接手这条消息';
    let result: OutboundDeliveryResult | undefined;
    try {
      result = await awaitDelivery(out.delivery, deps.signal);
    } catch (err) {
      // 契约要求送达结果一律以 resolve 给出；不守约的适配器以拒绝结算时按没发出处理
      return `没有发出：发送出错（${err instanceof Error ? err.message : String(err)}）`;
    }
    if (!result) return undefined;
    return result.ok || `没有发出：平台没收下（${result.error}）`;
  }

  /** 等这条消息的送达结果，交给 settle。等着的时候这一轮不算收尾 */
  function awaitReceipt(turn: Turn, out: OutgoingMessage, settle: (result: true | string | undefined) => void): void {
    turn.receipts++;
    void receipt(out).then(result => {
      turn.receipts--;
      settle(result);
      prune();
    });
  }

  /** 已收尾、且没有在读历史的快照还要据它判断的回合，不再留着 */
  function prune(): void {
    const floor = Math.min(...pending);
    for (const [turnId, turn] of turns) {
      if (turn.end !== undefined && turn.receipts === 0 && turn.end <= floor) turns.delete(turnId);
    }
  }

  /**
   * 不进历史的存档消息：属于 shown 里的回合（取快照时还没收尾，由在途条目给出），或取快照（seq 为 at）之后才结束、
   * 才开始的回合（由推送给出）
   */
  const skipFor = (at: number, shown: ReadonlySet<string>) => (stored: Message) => {
    const turnId = stored.metadata?.turnId;
    if (typeof turnId !== 'string') return false;
    const turn = turns.get(turnId);
    return shown.has(turnId) || (turn !== undefined && (turn.end === undefined || turn.end > at));
  };

  /** 这个会话还没收尾的回合：在跑，或已结束、还在等平台的送达结果 */
  const unsettledOf = (sessionId: string) =>
    [...turns.values()].filter(turn => turn.sessionId === sessionId && (turn.end === undefined || turn.receipts > 0));

  const planItem = (entries: TodoItem[]): Item<'plan'> => ({
    kind: 'plan',
    itemId: 'plan',
    turnId: current()?.turnId,
    at: Date.now(),
    entries,
  });

  // ───────── 回合 ─────────

  /** agent:input:before：回合开始。回的 run 在这一轮的异步上下文里跑回合（其中的回复与定稿校验归到这一轮），end 收尾 */
  function begin(turnId: string, incoming: IncomingMessage) {
    const { sessionId } = incoming;
    const turn: Turn = {
      turnId,
      sessionId,
      room: deps.isRoom(sessionId),
      receipts: 0,
      item: { kind: 'turn', itemId: turnId, turnId, at: Date.now(), by: speaker(incoming) },
      items: new Map(),
      next: 0,
      candidates: [],
      replies: [],
      sent: new Map(),
    };
    turns.set(turnId, turn);
    return {
      run: <T>(fn: () => Promise<T>) => scope.run(turn, fn),
      end: () => end(turn),
    };
  }

  /** 回合结束：房间里没回复就收尾的，说过的话标出原因；推回合的结局；房间里的回复等平台的送达结果 */
  function end(turn: Turn): void {
    // 被下游拦下的一轮没有结局：她没开口
    const outcome = turn.outcome ?? 'silent';
    dropCandidates(turn, turn.room && outcome !== 'replied' ? UNSENT[outcome] : undefined);
    if (turn.items.size === 0) turn.items.set(turn.turnId, turn.item);
    turn.item.outcome = outcome;
    complete(turn, turn.item);
    turn.end = seq;
    for (const { message: out, item: replyItem } of turn.replies) {
      awaitReceipt(turn, out, result => {
        if (typeof result !== 'string') return;
        replyItem.undelivered = { reason: result };
        complete(turn, replyItem);
      });
    }
    prune();
  }

  // ───────── 事件 ─────────

  function stream(chunk: StreamChunkMessage): void {
    const turn = live(chunk.turnId);
    if (!turn) return;
    if (chunk.reasoningDelta) append(turn, 'reasoning', chunk.reasoningDelta);
    if (chunk.contentDelta) append(turn, 'agent-message', chunk.contentDelta);
    if (!chunk.done) return;
    closeStream(turn);
    if (chunk.toolLimitReached) {
      const notice = add(turn, {
        kind: 'notice',
        itemId: `${turn.turnId}/${++turn.next}`,
        turnId: turn.turnId,
        at: Date.now(),
        topic: 'tool-limit',
        text: '工具调用达到这一轮的上限，可以让她继续',
        attachments: [],
        canContinue: true,
      });
      complete(turn, notice);
    }
  }

  function tool(info: ToolExecuteMessage): void {
    const turn = live(info.turnId);
    if (!turn) return;
    if (info.phase === 'start') {
      // 工具调用之前说的话不是回复：agent 只把最后的回复交给平台，房间里它们没有发进群
      dropCandidates(turn, turn.room ? BEFORE_TOOL_UNSENT : undefined);
      const item = add(turn, {
        kind: 'tool-call',
        itemId: info.callId,
        turnId: turn.turnId,
        at: Date.now(),
        name: info.toolName,
        args: info.args,
        status: 'running',
      });
      emit(turn.sessionId, 'item/started', item);
      return;
    }
    const item = turn.items.get(info.callId);
    if (item?.kind !== 'tool-call') return;
    if (item.status !== 'denied') item.status = toolFailed(info.result ?? '') ? 'failed' : 'completed';
    item.result = info.result;
    item.durationMs = Date.now() - item.at;
    complete(turn, item);
    const sent = turn.room ? turn.sent.get(info.callId) : undefined;
    if (!sent) return;
    awaitReceipt(turn, sent, result => {
      if (result !== true) return;
      item.sentToRoom = true;
      complete(turn, item);
    });
  }

  function toolOutput(chunk: ToolOutputMessage): void {
    const turn = live(chunk.turnId);
    const item = turn?.items.get(chunk.callId);
    if (!turn || item?.kind !== 'tool-call' || item.status !== 'running') return;
    item.output = (item.output ?? '') + chunk.text;
    emitDelta(turn.sessionId, item.itemId, chunk.text);
  }

  /** 审批推出或结算：推出时工具卡挂上它的 id 再推一次；没批准就结算的，工具卡收尾时状态是 denied */
  function approval(card: Approval): void {
    const turn = card.turnId === undefined ? undefined : live(card.turnId);
    const item = card.callId === undefined ? undefined : turn?.items.get(card.callId);
    if (!turn || item?.kind !== 'tool-call') return;
    if (card.state === 'pending') {
      item.approvalId = card.id;
      emit(turn.sessionId, 'item/started', item);
    } else if (card.state !== 'approved') {
      item.status = 'denied';
    }
  }

  /** agent:reply:before：一版回复定稿校验。之后若重试，新的一版另起一条 */
  function replyCheck(): void {
    const turn = current();
    if (turn) closeStream(turn);
  }

  function outbound(out: OutgoingMessage): void {
    const turn = current();
    if (turn && turn.sessionId === out.sessionId) {
      if (out.callId) turn.sent.set(out.callId, out);
      // 只有附件的消息落库后按存档推送
      if (!out.content.trim()) return;
      if (out.source === 'agent') reply(turn, out);
      else complete(turn, message(turn, out.content));
      return;
    }
    if (!out.content.trim()) return;
    emit(out.sessionId, 'item/completed', {
      kind: 'agent-message',
      itemId: `out/${crypto.randomUUID()}`,
      at: Date.now(),
      text: out.content,
      attachments: [],
    });
  }

  /** 落了库的提问、通知与她发出的附件 */
  function archived(sessionId: string, stored: Message): void {
    const item = archivedItem(stored, deps.isOwner, signerOf(sessionId));
    if (item) emit(sessionId, 'item/completed', item);
  }

  function plan(sessionId: string, entries: TodoItem[]): void {
    emit(sessionId, 'item/completed', planItem(entries));
  }

  function usage(event: TokenUsageEvent): void {
    const { injectors, ...breakdown } = event.breakdown;
    const item: Item<'usage'> = {
      kind: 'usage',
      itemId: 'usage',
      turnId: event.turnId,
      at: Date.now(),
      contextWindow: event.contextWindow,
      maxTokens: event.maxTokens,
      tokenBudget: event.tokenBudget,
      used: event.used,
      usageRatio: event.usageRatio,
      breakdown,
      injectors,
    };
    usages.set(event.sessionId, item);
    emit(event.sessionId, 'item/completed', item);
  }

  function compressing(sessionId: string, status: 'start' | 'done' | 'error'): void {
    if (status === 'start') {
      const item: Item<'notice'> = {
        kind: 'notice',
        itemId: `compress/${crypto.randomUUID()}`,
        at: Date.now(),
        topic: 'compress',
        text: '正在压缩对话',
        attachments: [],
      };
      compressions.set(sessionId, item);
      emit(sessionId, 'item/started', item);
      return;
    }
    const item = compressions.get(sessionId);
    if (!item) return;
    compressions.delete(sessionId);
    item.text = status === 'done' ? '对话已压缩' : '压缩失败';
    emit(sessionId, 'item/completed', item);
  }

  function resync(sessionId: string): void {
    deps.notify(sessionId, 'session/resync', { sessionId, epoch, seq: ++seq });
  }

  function forget(sessionId: string): void {
    usages.delete(sessionId);
    compressions.delete(sessionId);
  }

  const isRunning = (sessionId: string) =>
    [...turns.values()].some(turn => turn.sessionId === sessionId && turn.end === undefined);

  // ───────── 方法 ─────────

  async function subscribe(
    sessionId: string,
    conn: ServerConnection,
    afterReply: (action: () => void) => void,
  ): Promise<SessionMethodResult<'session/subscribe'>> {
    const info = deps.requireSession(sessionId);
    // 同一拍取定 seq、抄下还没收尾的回合的条目、登记订阅：之后的推送都排在快照后面
    const at = seq;
    const usage = usages.get(sessionId);
    const open = unsettledOf(sessionId);
    const ongoing = structuredClone([
      ...open.flatMap(turn => [...turn.items.values()]),
      ...[compressions.get(sessionId), usage].filter(item => item !== undefined),
    ]);
    const approvals = structuredClone(deps.approvalsOf(sessionId));
    // 读历史期间这些回合可能收尾、被清掉，按此刻抄下的回合排除它们的存档
    const shown = new Set(open.map(turn => turn.turnId));
    const { release, cancel } = conn.subscribe(sessionId);
    pending.push(at);
    try {
      const history = await readHistory(
        deps.memory.require(),
        sessionId,
        { limit: HISTORY_PAGE, skip: skipFor(at, shown) },
        deps.isOwner,
        deps.isRoom(sessionId),
        signerOf(sessionId),
      );
      const entries = (await deps.todoList.current?.get(sessionId)) ?? [];
      afterReply(() => {
        release();
        if (!usage) deps.requestUsage(sessionId, conn.peer.identity.platform);
      });
      return {
        epoch,
        seq: at,
        session: deps.summarize(info),
        items: [...history.items, ...ongoing, ...(entries.length > 0 ? [planItem(entries)] : [])],
        approvals,
        before: history.before,
      };
    } catch (err) {
      cancel();
      throw err;
    } finally {
      pending.splice(pending.indexOf(at), 1);
      prune();
    }
  }

  const handlers: Pick<MethodHandlers, 'session/subscribe' | 'session/unsubscribe' | 'session/history'> = {
    'session/subscribe': ({ sessionId }, conn, request) => subscribe(sessionId, conn, request.afterReply),
    'session/unsubscribe': ({ sessionId }, conn) => {
      conn.unsubscribe(sessionId);
      return {};
    },
    'session/history': ({ sessionId, before, limit }) => {
      deps.requireSession(sessionId);
      const shown = new Set(unsettledOf(sessionId).map(turn => turn.turnId));
      return readHistory(
        deps.memory.require(),
        sessionId,
        { before, limit: limit ?? HISTORY_PAGE, skip: skipFor(seq, shown) },
        deps.isOwner,
        deps.isRoom(sessionId),
        signerOf(sessionId),
      );
    },
  };

  return {
    handlers,
    isRunning,
    begin,
    /** agent:turn:after：记下这一轮的结局，收尾时用 */
    outcome: (turnId: string, outcome: Outcome) => {
      const turn = live(turnId);
      if (turn) turn.outcome = outcome;
    },
    stream,
    tool,
    toolOutput,
    approval,
    replyCheck,
    outbound,
    archived,
    plan,
    usage,
    compressing,
    resync,
    forget,
  };
}
