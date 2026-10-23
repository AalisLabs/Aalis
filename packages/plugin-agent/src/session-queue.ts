// ============================================================
// session-queue.ts — 通道：每个会话同一时刻最多一轮在跑，新消息从不打断它
//
// 真人消息（不带 source）插进由真人消息开、还收输入的那一轮（这一轮在每次调用模型之前取走待插入的），插不进的排队；一轮结束
// 后取队首：队首是真人消息时队里的真人消息一起开下一轮，队首是带来源的注入时只开它。开下一轮的是这一批里入队最早那条的调用，
// 回合跑在它的异步上下文里（注入方据此认出自己那一轮），其余各条等这一轮结束。停一轮可以连同排队与待插入的一起放掉；放掉的
// 在这个会话在跑的一轮落定之后由 agent 按先后归档（要归档的才归档），agent 在一个会话里的写入因此不交错。一轮被停下即不再收
// 输入。会话删除时，删除之前开始逐条处理、之后才入队的输入以放掉落定；关闭（停机）之后入队的同样。按住的会话（清消息历史期间）
// 要交给通道的输入等放开再交。等候的集合（排队与待插入的）变了时报给 onWaiting。
// ============================================================

import type { IncomingMessage } from '@aalis/schema-message';

/** 一条已过逐条处理、等着落定的输入 */
interface Entry {
  readonly message: IncomingMessage;
  /** 入队序号：批内与插入都按它排 */
  readonly seq: number;
  /** 轮到它开轮时交出那一轮；它所在的一轮结束、或它被放掉时交出 undefined */
  readonly wake: (turn: Turn | undefined) => void;
}

/** 在跑的一轮 */
export interface Turn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly controller: AbortController;
  /** 由真人消息开：只有这样的一轮收插进来的真人消息 */
  readonly human: boolean;
  /** 由排着的输入开（它们是上一轮进行期间到的） */
  readonly queued: boolean;
  /** 开轮的这一批，按入队先后 */
  readonly batch: readonly IncomingMessage[];
  /** 停下它的原因，只给日志 */
  reason?: string;
}

/** 一条正在逐条处理、还没交给通道的输入：这期间它的会话被删，交给通道时放掉 */
interface Admission {
  readonly sessionId: string;
  deleted: boolean;
}

/** 通道里一轮的状态 */
interface Running {
  readonly turn: Turn;
  /** 进了这一轮的输入（开轮的与插进来的）：这一轮落定时一起落定 */
  readonly members: Entry[];
  /** 还收输入：最后一次模型调用返回最后的回复之后、被停下之后、或这一轮收尾时为假 */
  accepting: boolean;
  /** 这一轮已经收尾（不再停得下） */
  ended: boolean;
  /** 这一轮落定（release）时落定 */
  readonly done: Promise<void>;
  readonly resolve: () => void;
}

/** 一个会话的通道 */
interface Channel {
  running?: Running;
  /** 排队的，按入队先后（转为排队的待插入排在队首） */
  queue: Entry[];
  /** 待插入的：等在跑的一轮下一次调用模型之前取 */
  joining: Entry[];
  /** 放掉、等在跑的一轮落定之后由 agent 处理的 */
  dropped: Array<{ entry: Entry; archive: boolean }>;
}

/** 一条输入交给通道之后去哪：开轮、待插入、排队，或放掉（archive 为要不要归档） */
export type Placement =
  | { route: 'open'; turn: Turn }
  | { route: 'join' | 'queue'; ready: Promise<Turn | undefined> }
  | { route: 'drop'; archive: boolean };

const bySeq = (a: Entry, b: Entry) => a.seq - b.seq;

export class SessionQueues {
  readonly #channels = new Map<string, Channel>();
  /** 正在逐条处理的输入，按会话：只记在处理中的，处理完即删 */
  readonly #admitted = new Map<string, Set<Admission>>();
  /** 按住的范围：sessions 不给即全部会话，放开时 released 落定 */
  readonly #holds = new Set<{ readonly sessions?: ReadonlySet<string>; readonly released: Promise<void> }>();
  #seq = 0;
  #closed = false;

  constructor(private readonly onWaiting: (sessionId: string, waiting: readonly IncomingMessage[]) => void) {}

  /** 一条输入开始逐条处理：处理完（交给通道或被丢掉）时 {@link leave} */
  admit(sessionId: string): Admission {
    const admission: Admission = { sessionId, deleted: false };
    const admitted = this.#admitted.get(sessionId);
    if (admitted) admitted.add(admission);
    else this.#admitted.set(sessionId, new Set([admission]));
    return admission;
  }

  /** 这条输入处理完了 */
  leave(admission: Admission): void {
    const admitted = this.#admitted.get(admission.sessionId);
    admitted?.delete(admission);
    if (admitted?.size === 0) this.#admitted.delete(admission.sessionId);
  }

  /**
   * 按住这些会话（不给即全部会话），直到调用返回的函数：这期间要交给通道的输入在 {@link held} 等着，放开之后再交。清消息历史
   * 用它：停下在跑的一轮到清完之间到的输入不开轮、不被清掉，清完照常处理
   */
  hold(sessionIds?: readonly string[]): () => void {
    let release!: () => void;
    const hold = { sessions: sessionIds && new Set(sessionIds), released: new Promise<void>(r => (release = r)) };
    this.#holds.add(hold);
    return () => {
      this.#holds.delete(hold);
      release();
    };
  }

  /** 这个会话被按住时等到放开（几处同时按住的等到都放开）；没按住的立即落定 */
  async held(sessionId: string): Promise<void> {
    const covering = () => [...this.#holds].find(({ sessions }) => !sessions || sessions.has(sessionId));
    for (let hold = covering(); hold; hold = covering()) await hold.released;
  }

  /**
   * 交一条已过逐条处理的输入。已关闭或处理期间会话被删时放掉（关闭的要归档，删除的不归档）；会话空闲时由这次调用开轮；在跑的
   * 一轮由真人消息开、还收输入，这条也是真人消息时待插入；其余排队。待插入与排队的 ready 在它所在的一轮结束、或被放掉时
   * 交出 undefined，轮到它开轮时交出那一轮
   */
  place(message: IncomingMessage, admission: Admission): Placement {
    if (this.#closed) return { route: 'drop', archive: true };
    if (admission.deleted) return { route: 'drop', archive: false };
    const channel = this.#channelOf(message.sessionId);
    let wake!: Entry['wake'];
    const ready = new Promise<Turn | undefined>(resolve => (wake = resolve));
    const entry: Entry = { message, seq: ++this.#seq, wake };
    const { running } = channel;
    if (!running) return { route: 'open', turn: this.#open(channel, [entry], false) };
    const route = running.turn.human && running.accepting && !message.source ? 'join' : 'queue';
    (route === 'join' ? channel.joining : channel.queue).push(entry);
    this.#report(message.sessionId, channel);
    return { route, ready };
  }

  /** 取这一轮待插入的输入（按入队先后），它们随之进了这一轮；不收输入时为空 */
  take(turn: Turn): IncomingMessage[] {
    const channel = this.#channels.get(turn.sessionId);
    const running = channel?.running;
    if (!channel || running?.turn !== turn || !running.accepting || channel.joining.length === 0) return [];
    const taken = channel.joining.splice(0).sort(bySeq);
    running.members.push(...taken);
    this.#report(turn.sessionId, channel);
    return taken.map(entry => entry.message);
  }

  /** 这一轮不再收输入：还没插进去的转为排队，排在队首 */
  close(turn: Turn): void {
    const channel = this.#channels.get(turn.sessionId);
    const running = channel?.running;
    if (!channel || running?.turn !== turn || !running.accepting) return;
    running.accepting = false;
    channel.queue.unshift(...channel.joining.splice(0).sort(bySeq));
  }

  /**
   * 停下这个会话在跑的一轮（turnId 给了而对不上时什么也不停）：它不再收输入，待插入的转为排队、之后到的排队，开下一轮；queued
   * 为真时连同排队与待插入的一起放掉，archive 定放掉的要不要归档。返回是否停下了在跑的一轮
   */
  stop(
    sessionId: string,
    { turnId, queued, reason, archive }: { turnId?: string; queued?: boolean; reason?: string; archive: boolean },
  ): boolean {
    const channel = this.#channels.get(sessionId);
    const running = channel?.running;
    if (turnId !== undefined && running?.turn.turnId !== turnId) return false;
    const stopped = running !== undefined && !running.ended && !running.turn.controller.signal.aborted;
    if (stopped) {
      running.turn.reason = reason;
      running.turn.controller.abort();
      this.close(running.turn);
    }
    if (queued && channel && channel.queue.length + channel.joining.length > 0) {
      const waiting = [...channel.queue.splice(0), ...channel.joining.splice(0)].sort(bySeq);
      channel.dropped.push(...waiting.map(entry => ({ entry, archive })));
      this.#report(sessionId, channel);
    }
    return stopped;
  }

  /**
   * 这一轮收尾：不再收输入、不再停得下。返回这期间放掉的（按先后），agent 处理完一条（要归档的先归档）调它的 settle，处理
   * 期间又放掉的下一次再取，取空了再 {@link release}
   */
  drain(turn: Turn): Array<{ message: IncomingMessage; archive: boolean; settle: () => void }> {
    const channel = this.#channels.get(turn.sessionId);
    const running = channel?.running;
    if (!channel || running?.turn !== turn) return [];
    this.close(turn);
    running.ended = true;
    return channel.dropped
      .splice(0)
      .map(({ entry, archive }) => ({ message: entry.message, archive, settle: () => entry.wake(undefined) }));
  }

  /** 这一轮落定：进了这一轮的输入随之落定，取下一批开下一轮（交给这一批里入队最早那条的调用） */
  release(turn: Turn): void {
    const channel = this.#channels.get(turn.sessionId);
    const running = channel?.running;
    if (!channel || running?.turn !== turn) return;
    for (const entry of running.members) entry.wake(undefined);
    channel.running = undefined;
    running.resolve();
    const [head] = channel.queue;
    if (!head) {
      this.#channels.delete(turn.sessionId);
      return;
    }
    const batch = head.message.source ? [head] : channel.queue.filter(entry => !entry.message.source).sort(bySeq);
    channel.queue = channel.queue.filter(entry => !batch.includes(entry));
    const next = this.#open(channel, batch, true);
    this.#report(turn.sessionId, channel);
    batch[0].wake(next);
  }

  /** 这个会话此刻在跑的那一轮落定时落定；没有在跑的立即落定 */
  settled(sessionId: string): Promise<void> {
    return this.#channels.get(sessionId)?.running?.done ?? Promise.resolve();
  }

  /** 停下这些会话在跑的一轮、放掉排队与待插入的，返回它们都落定的 Promise */
  stopAll(sessionIds: readonly string[], options: { archive: boolean; reason: string }): Promise<void> {
    for (const sessionId of sessionIds) this.stop(sessionId, { ...options, queued: true });
    return Promise.all(sessionIds.map(sessionId => this.settled(sessionId))).then(() => undefined);
  }

  /**
   * 会话删除：正在逐条处理的输入之后放掉；停下在跑的一轮、放掉排队项（不归档），返回那一轮落定的 Promise。没有上限：不响应中止
   * 的工具会让它一直等到工具返回
   */
  delete(sessionId: string): Promise<void> {
    for (const admission of this.#admitted.get(sessionId) ?? []) admission.deleted = true;
    return this.stopAll([sessionId], { archive: false, reason: '会话删除' });
  }

  /** 关闭（停机）：之后入队的一律放掉；停下全部在跑的一轮、放掉全部排队项（都归档），返回它们都落定的 Promise */
  shutdown(): Promise<void> {
    this.#closed = true;
    return this.stopAll(this.sessions(), { archive: true, reason: '停机' });
  }

  /** 有在跑的一轮的会话（排着输入的会话一定有在跑的一轮：一轮落定时当场交出下一批） */
  sessions(): string[] {
    return [...this.#channels.keys()];
  }

  #channelOf(sessionId: string): Channel {
    let channel = this.#channels.get(sessionId);
    if (!channel) {
      channel = { queue: [], joining: [], dropped: [] };
      this.#channels.set(sessionId, channel);
    }
    return channel;
  }

  #open(channel: Channel, batch: Entry[], queued: boolean): Turn {
    const [first] = batch;
    const turn: Turn = {
      sessionId: first.message.sessionId,
      turnId: crypto.randomUUID(),
      controller: new AbortController(),
      human: !first.message.source,
      queued,
      batch: batch.map(entry => entry.message),
    };
    let resolve!: () => void;
    const done = new Promise<void>(r => (resolve = r));
    channel.running = { turn, members: [...batch], accepting: true, ended: false, done, resolve };
    return turn;
  }

  /** 报这个会话等候的集合：排队与待插入的，按入队先后 */
  #report(sessionId: string, channel: Channel): void {
    this.onWaiting(
      sessionId,
      [...channel.queue, ...channel.joining].sort(bySeq).map(entry => entry.message),
    );
  }
}
