// ════════════════════════════════════════════════════════════
// 审批（契约见 @aalis/api-approval）：发起、在场、排队、频率上限、应答核验、结算、回给模型的话与审计。
//
// 审批只有一种，发起方给出这一张谁能批（canAnswer）并标出只有 owner 能批的。人亲手发起的一轮（含它的续做与它派出的子任务，
// 类别沿发起它的那一轮读，不论在哪个会话）、参与者里有人能批才能产生审批，其余直接拒绝，不推给任何审批面。
// 推给谁、算谁在场、认谁的应答是一条规则：客户端的身份能批这一张，且它的接入覆盖这张审批：没限定的（WebUI、终端）全部覆盖；
// 限定了群窗口的覆盖根会话是这个窗口的（连同它的子会话）、不是只有 owner 能批的；IM 私聊只覆盖只有 owner 能批的、这一轮的
// 参与者里有它、审批所在会话的根会话经这个机器人账号的。最近一次活动在 10 分钟内、或推给它的卡还没结的算在场；上报离开时推给
// 它、还没结的卡对它算没收到，报某一张没送到时只这一张对它算没收到，变为在场时补推。发起时没人在场直接拒绝。同一会话的审批
// 排队，一次只推出一张卡，等待从推出那一刻算起；频率上限按根会话连同它的子会话合计，只有 owner 能批的与参与者审批各算各的。
// 子会话里的审批对象带来源链（根会话以下的各级子会话）。等满 300 秒、覆盖它的在场客户端都离开且 30 秒内没有回来、回合结束或
// 中止、服务停止时结算。
// 应答先答先得：已结算的一律回已结算；还在等的，id 由本服务签发、归这个接入覆盖（否则不认识），应答人能批这一张，内容哈希一致。
// 请求与决定成对追加到数据目录的 state/audit/approvals.jsonl，不进模型上下文；每个结算另记一行 info 日志（会话、工具、结局、原因）。
// ════════════════════════════════════════════════════════════

// biome-ignore lint/style/noRestrictedImports: 请求在发起的同一拍里定下去留与排队次序，内容哈希要同步算；异步的摘要会让并行的请求按完成先后乱序
import { createHash } from 'node:crypto';
// biome-ignore lint/style/noRestrictedImports: 审计是只追加的记录，存储服务没有追加写；位置取自 host-paths 给的数据目录
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  Approval,
  ApprovalAttendance,
  ApprovalFacts,
  ApprovalIdentity,
  ApprovalOutcome,
  ApprovalRefusal,
  ApprovalRequest,
  ApprovalService,
  ApprovalSettlement,
  ApprovalSink,
  ApprovalSource,
  AttendScope,
  SettledState,
  SurfaceBinding,
} from '@aalis/api-approval';
import type { ToolDisplay } from '@aalis/api-tools';
import type { Events, Logger } from '@aalis/core';
import type { TextRef } from '@aalis/schema-i18n';
import { createBoundedMap } from '@aalis/util-bounded-map';
import { failure, type MethodHandlers } from './connection.js';
import { resolveDisplay } from './display.js';
import { t } from './texts.js';

/** 推出之后等应答的时限 */
const APPROVAL_WAIT_MS = 300_000;
/** 客户端最近一次活动在这段时间内算在场 */
const PRESENCE_WINDOW_MS = 10 * 60_000;
/**
 * 等待中在场的客户端全部离开（断开或转为不在场）之后，再等这么久才按没人在场结算：手机切到别的应用、锁屏，
 * 桌面上切一下标签页，都会让连接挂起或页面转为不可见，回来时重连、重报在场，卡片照常等着。不延长总的等待时限
 */
const ABSENCE_GRACE_MS = 30_000;
/** 频率上限：同一会话树（根会话连同各级子会话）的同一种审批在 RATE_WINDOW_MS 内最多 RATE_LIMIT 张卡 */
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT = 10;
/** 记住最近结算的这么多个 id：后到的应答回 approval-settled，更早的按不认识的 id 处理 */
const SETTLED_MEMORY = 1000;

interface SurfaceRecord {
  name: string;
  /** 登记它的插件实例 */
  registrant: string;
  attendees: Set<Attendee>;
}

interface Attendee {
  surface: SurfaceRecord;
  who: ApprovalIdentity;
  sink: ApprovalSink;
  /** 接入时的限定：只覆盖限定的那些审批；没有即覆盖全部 */
  scope?: AttendScope;
  /** 在场到这个时刻为止；离开或从没上报过活动为 0 */
  until: number;
  /** 推给它、还没结、它也没上报过离开或没送到的：有就算它在场 */
  held: Set<Pending>;
  /** 推给它、它报了没送到的：它不因这些算在场，变为在场时补推 */
  missed: Set<Pending>;
}

interface Pending {
  id: string;
  req: ApprovalRequest;
  /** 所在会话的根会话：限定了群窗口的接入按它的 id 认，限定了机器人账号的按它的机器人账号认，频率上限按它的 id 算 */
  root?: SessionRoot;
  signal?: AbortSignal;
  /** 发起的时刻，等待时长从这里算 */
  at: number;
  facts: ApprovalFacts;
  contentHash: string;
  resolve(outcome: ApprovalOutcome): void;
  offAbort?: () => void;
  /** 推出之后才有 */
  approval?: Approval;
  timer?: ReturnType<typeof setTimeout>;
  /** 推给过的客户端（含之后上报过离开的），结算时通知它们 */
  delivered: Set<Attendee>;
}

/** 工具卡认审批用的几项：推出的审批对象，或发起时就结算、没有对象的请求 */
type ApprovalRef = Pick<Approval, 'id' | 'sessionId' | 'turnId' | 'callId'>;

/** 会话的根会话：id 与机器人账号（`originChat.selfId`）；会话在它以下时另带来源链（审批对象的 chain） */
interface SessionRoot {
  id: string;
  bot?: string;
  chain?: Approval['chain'];
}

interface ApprovalDeps {
  events: Events;
  logger: Logger;
  /** 审计文件的绝对路径 */
  auditFile: string;
  /** 工具定义上声明的展示种类：卡片上的事实按它取 */
  displaySpec(tool: string): ToolDisplay | undefined;
  /** 会话的根会话；会话或某一级父会话不在会话表里时为 undefined */
  rootOf(sessionId: string): SessionRoot | undefined;
  /** 一个审批推出或结算了（结算时带上怎样结算的，发起时就结算的也算）：会话列表与工具卡跟着变 */
  changed(approval: ApprovalRef, settlement?: ApprovalSettlement): void;
}

// ───────── 事实与哈希 ─────────

/**
 * 卡片上的事实：按工具声明的展示种类从参数里取，各项逐字；用掉的参数不在 params 里重复。没声明（或解析不出）的，
 * 全部参数都在 params 里
 */
function factsOf(spec: ToolDisplay | undefined, args: Record<string, unknown>): ApprovalFacts {
  const params: Record<string, unknown> = { ...args };
  const display = resolveDisplay(spec, args);
  if (!spec || !display) return { params };
  for (const key of Object.values(spec.fields))
    if (key !== undefined && typeof args[key] === 'string') delete params[key];
  if (display.kind === 'command') {
    return { command: display.command, ...(display.cwd === undefined ? {} : { cwd: display.cwd }), params };
  }
  const { path, removed, added } = display;
  const lines = (text: string | undefined, sign: '-' | '+') => text?.split('\n').map(line => sign + line) ?? [];
  return { diff: { path, patch: [...lines(removed, '-'), ...lines(added, '+')].join('\n') }, params };
}

/** 请求内容的哈希：会话、回合、调用、工具与参数 */
function hashOf(req: ApprovalRequest): string {
  const content = [req.sessionId, req.turnId ?? null, req.callId ?? null, req.tool, req.args];
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// ───────── 回给模型的话 ─────────

/** 各结算来源：被什么拦下、能不能再申请（拒绝另附说明）。不指名应答人，点到 owner 的只有不能产生审批的那句 */
const REASONS: Record<Exclude<ApprovalSource, 'answer'>, [reason: string, again: string]> = {
  absent: ['没人在场，没有人能批准', '有能批的人在场时可以再申请；不要换别的办法绕过，先说明需要批准什么'],
  timeout: [`等了 ${APPROVAL_WAIT_MS / 1000} 秒没有人应答`, '可以再申请；不要换别的办法绕过'],
  ineligible: ['这一轮里没有 owner 的话，要 owner 确认的操作不能执行', '不能；不要换别的办法绕过'],
  'rate-limit': [
    `这个会话树（根会话连同各级子会话）${RATE_WINDOW_MS / 60_000} 分钟内的同一种审批已达 ${RATE_LIMIT} 张的上限`,
    '稍后可以；先停下来说明在做什么',
  ],
  'turn-ended': ['发起它的回合已结束', '可以在新的一轮里再申请'],
  shutdown: ['审批服务已停止', '服务恢复后可以再申请'],
};

/** 日志里的结局 */
const OUTCOMES: Record<SettledState, string> = { approved: '批准', denied: '拒绝', expired: '过期', cancelled: '撤销' };

function denialFor(source: ApprovalSource, note: string | undefined): string {
  const [reason, again] =
    source === 'answer'
      ? [`被拒绝了${note ? `，说明：「${note}」` : ''}`, '不要原样再申请，按拒绝的意思调整']
      : REASONS[source];
  return `需要批准的操作没有执行。原因：${reason}。能否再申请：${again}。`;
}

// ───────── 服务 ─────────

export function createApprovals(deps: ApprovalDeps) {
  const surfaces = new Set<SurfaceRecord>();
  /** 每个会话的审批队列：队首推出了就有 approval，其余排着 */
  const queues = new Map<string, Pending[]>();
  /** 每份频率额度（见 rateKey）最近排进队的时刻：发起时就结算的不算，排着没推出就结算的退还 */
  const cards = new Map<string, number[]>();
  /** 最近结算的审批 id */
  const settledIds = createBoundedMap<string, true>({ max: SETTLED_MEMORY });
  /** 每个会话从什么时候起推出的审批没有覆盖它的在场客户端：这个会话的重连宽限从这一刻算 */
  const uncoveredSince = new Map<string, number>();
  /** 定在最早到期的那个会话的宽限上：有没了覆盖的会话时才有 */
  let grace: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  // 写入排队：请求总在它的决定之前落盘
  let writing: Promise<void> = Promise.resolve();
  function audit(record: Record<string, unknown>): void {
    const line = `${JSON.stringify(record)}\n`;
    writing = writing
      .then(async () => {
        await mkdir(dirname(deps.auditFile), { recursive: true });
        await appendFile(deps.auditFile, line);
      })
      .catch(err => deps.logger.warn(`审批审计追加失败 (${deps.auditFile}):`, err));
  }

  /** 通知审批面与会话列表：哪个接收方出错只告警，不影响结算、排队与别的接收方 */
  function tell(what: string, notify: () => void): void {
    try {
      notify();
    } catch (err) {
      deps.logger.warn(`审批${what}的通知出错:`, err);
    }
  }

  /**
   * 接入覆盖这张：没限定的全部覆盖；限定了群窗口的覆盖这个窗口发起的、不是只有 owner 能批的（群窗口是公开的面）；IM 私聊只覆盖
   * 只有 owner 能批的、这一轮的参与者里有它、所在会话的根会话经这个机器人账号的
   */
  const covers = ({ who, scope }: Attendee, { req, root }: Pending) => {
    if (scope === undefined) return true;
    if (scope.window !== undefined) return !req.ownerOnly && root?.id === scope.window;
    return (
      req.ownerOnly &&
      req.origin.participants.some(p => p.platform === who.platform && p.userId === who.userId) &&
      root?.bot === scope.selfId
    );
  };
  /**
   * 推给谁、算谁在场、认谁的应答都看这一条：接入覆盖这张，且客户端的身份能批（不能批的，推给它、算它在场都只会让审批空等）
   */
  const attends = (attendee: Attendee, pending: Pending) =>
    covers(attendee, pending) && pending.req.canAnswer(attendee.who);
  /** 它此刻在场：最近一次活动在时限内，或推给它的卡还没结 */
  const isPresent = (attendee: Attendee, now: number) => now < attendee.until || attendee.held.size > 0;
  /** 此刻在场、覆盖这张、没报过这张没送到的客户端 */
  const present = (now: number, pending: Pending) =>
    [...surfaces].flatMap(surface =>
      [...surface.attendees].filter(
        attendee => isPresent(attendee, now) && !attendee.missed.has(pending) && attends(attendee, pending),
      ),
    );
  /** 已推出、还没结的 */
  const shown = () => [...queues.values()].flatMap(queue => (queue[0]?.approval ? [queue[0]] : []));
  /** 这个会话此刻在它的重连宽限里 */
  const inGrace = (sessionId: string, now: number) => {
    const since = uncoveredSince.get(sessionId);
    return since !== undefined && now - since < ABSENCE_GRACE_MS;
  };

  /** 推给它：它此刻拿着这张，结算时通知它；已经拿着的不重推 */
  function deliver(pending: Pending, attendee: Attendee): void {
    const { approval } = pending;
    if (!approval || attendee.held.has(pending) || !attends(attendee, pending)) return;
    attendee.held.add(pending);
    pending.delivered.add(attendee);
    tell('推出', () => attendee.sink.requested(approval));
  }

  /**
   * 在场或推出的审批有变：按会话记下推出的审批从什么时候起没有覆盖它的在场客户端，有了覆盖或队列空了即撤（队首刚结、下一张
   * 还没推出的那一拍照旧记着）；宽限的计时器定在最早到期的会话上。覆盖推出的审批的在场客户端都拿着它，不会到时失效，
   * 只在离开、断开、登记撤回与报没送到（undelivered）时变
   */
  function recheck(): void {
    const now = Date.now();
    for (const sessionId of uncoveredSince.keys()) if (!queues.has(sessionId)) uncoveredSince.delete(sessionId);
    for (const pending of shown()) {
      const { sessionId } = pending.req;
      if (present(now, pending).length > 0) uncoveredSince.delete(sessionId);
      else if (!uncoveredSince.has(sessionId)) uncoveredSince.set(sessionId, now);
    }
    clearTimeout(grace);
    grace =
      uncoveredSince.size === 0
        ? undefined
        : setTimeout(lapseGrace, Math.min(...uncoveredSince.values()) + ABSENCE_GRACE_MS - now);
  }

  /** 宽限到期：宽限已过的会话里推出的审批按没人在场结算 */
  function lapseGrace(): void {
    grace = undefined;
    const now = Date.now();
    for (const pending of shown()) {
      const { sessionId } = pending.req;
      if (uncoveredSince.has(sessionId) && !inGrace(sessionId, now)) settle(pending, 'expired', 'absent');
    }
    recheck();
  }

  function settle(
    pending: Pending,
    state: SettledState,
    source: ApprovalSource,
    by?: { attendee: Attendee; note?: string },
  ): void {
    pending.offAbort?.();
    clearTimeout(pending.timer);
    const { sessionId } = pending.req;
    const queue = queues.get(sessionId) ?? [];
    const index = queue.indexOf(pending);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) queues.delete(sessionId);
    const now = Date.now();
    const settlement: ApprovalSettlement = { state, source, at: now, ...(by && { by: by.attendee.who }) };
    const approval = pending.approval;
    if (approval) {
      approval.state = state;
      settledIds.set(approval.id, true);
      for (const attendee of pending.delivered) {
        attendee.held.delete(pending);
        attendee.missed.delete(pending);
        if (attendee.surface.attendees.has(attendee))
          tell('结算', () => attendee.sink.settled(approval.id, settlement));
      }
      void deps.events.emit('approval:settled', approval);
    } else if (index >= 0) {
      // 排进过队、没推出就结算了：退还它占的频率额度
      const times = cards.get(rateKey(pending)) ?? [];
      const at = times.indexOf(pending.at);
      if (at >= 0) times.splice(at, 1);
    }
    // 没推出就结算的（发起时没人在场、发起者不能产生审批等）工具卡同样带上结算：历史里显示真实的结局，不是「失败」
    const { turnId, callId, tool } = pending.req;
    tell('结算', () => deps.changed({ id: pending.id, sessionId, turnId, callId }, settlement));
    // 每个结算一行 info，被拒的自主回合、超出频率上限的请求都在里面，运行状况的日志按提供审批服务的实例筛出它们
    const reason = source === 'answer' ? '有人应答' : REASONS[source][0];
    deps.logger.info(`审批结算：会话 ${sessionId}，工具 ${tool}，${OUTCOMES[state]}（${reason}）`);
    audit({
      type: 'decision',
      id: pending.id,
      at: now,
      state,
      source,
      ...(by && {
        responder: by.attendee.who,
        surface: { name: by.attendee.surface.name, plugin: by.attendee.surface.registrant },
        note: by.note,
      }),
      waitedMs: now - pending.at,
    });
    pending.resolve(
      state === 'approved' && by
        ? { approvalId: pending.id, approved: true, by: by.attendee.who }
        : {
            approvalId: pending.id,
            approved: false,
            source,
            message: denialFor(source, by?.note),
          },
    );
    if (index === 0 && queue.length > 0) show(queue[0]);
    recheck();
  }

  /** 队首推给覆盖它的在场客户端；排队期间回合中止了的、已经没有这样的客户端又不在这个会话的宽限内的，直接结算 */
  function show(pending: Pending): void {
    if (pending.signal?.aborted) {
      settle(pending, 'cancelled', 'turn-ended');
      return;
    }
    const now = Date.now();
    const audience = present(now, pending);
    if (audience.length === 0 && !inGrace(pending.req.sessionId, now)) {
      settle(pending, 'expired', 'absent');
      return;
    }
    const { req } = pending;
    const approval: Approval = {
      id: pending.id,
      sessionId: req.sessionId,
      turnId: req.turnId,
      callId: req.callId,
      origin: req.origin,
      target: 'tool',
      tool: req.tool,
      facts: pending.facts,
      options: ['approve', 'deny'],
      contentHash: pending.contentHash,
      expiresAt: now + APPROVAL_WAIT_MS,
      state: 'pending',
      ...(pending.root?.chain && { chain: pending.root.chain }),
    };
    pending.approval = approval;
    pending.timer = setTimeout(() => settle(pending, 'expired', 'timeout'), APPROVAL_WAIT_MS);
    void deps.events.emit('approval:created', approval);
    tell('推出', () => deps.changed(approval));
    for (const attendee of audience) deliver(pending, attendee);
    recheck();
  }

  /**
   * 频率额度记在哪：所在会话的根会话（根会话不在会话表里时退回会话自己），只有 owner 能批的与参与者审批各一份：群里别人的
   * 参与者审批用满了，owner 在这里要她确认的照常推出
   */
  const rateKey = ({ root, req }: Pending) => `${req.ownerOnly ? 'owner' : 'participant'}:${root?.id ?? req.sessionId}`;
  const recentCards = (key: string, at: number) => (cards.get(key) ?? []).filter(t => at - t < RATE_WINDOW_MS);

  /** 发起时就结算的：服务已停、回合已中止、发起者不能产生审批、没人在场、超过频率上限 */
  function refusalOf(pending: Pending): [SettledState, ApprovalSource] | undefined {
    const { req, signal, at } = pending;
    const { origin } = req;
    if (closed) return ['cancelled', 'shutdown'];
    if (signal?.aborted) return ['cancelled', 'turn-ended'];
    if (origin.kind !== 'hand' || !origin.participants.some(who => req.canAnswer(who))) return ['denied', 'ineligible'];
    if (present(at, pending).length === 0) return ['expired', 'absent'];
    if (recentCards(rateKey(pending), at).length >= RATE_LIMIT) return ['denied', 'rate-limit'];
    return undefined;
  }

  function request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    return new Promise(resolve => {
      const at = Date.now();
      const pending: Pending = {
        id: crypto.randomUUID(),
        req,
        root: deps.rootOf(req.sessionId),
        signal,
        at,
        facts: factsOf(deps.displaySpec(req.tool), req.args),
        contentHash: hashOf(req),
        resolve,
        delivered: new Set(),
      };
      const { sessionId, turnId, callId, origin, tool, rule } = req;
      audit({
        type: 'request',
        id: pending.id,
        at,
        sessionId,
        turnId,
        callId,
        origin,
        ...(pending.root?.chain && { chain: pending.root.chain }),
        tool,
        facts: pending.facts,
        contentHash: pending.contentHash,
        rule,
      });
      const refusal = refusalOf(pending);
      if (refusal) {
        settle(pending, ...refusal);
        return;
      }
      const key = rateKey(pending);
      cards.set(key, [...recentCards(key, at), at]);

      if (signal) {
        const onAbort = () => settle(pending, 'cancelled', 'turn-ended');
        signal.addEventListener('abort', onAbort, { once: true });
        pending.offAbort = () => signal.removeEventListener('abort', onAbort);
      }
      const queue = queues.get(sessionId) ?? [];
      queues.set(sessionId, queue);
      queue.push(pending);
      if (queue.length === 1) show(pending);
    });
  }

  function attendance(attendee: Attendee): ApprovalAttendance {
    const refuse = (refusal: ApprovalRefusal, message: TextRef) => ({ ok: false as const, refusal, message });
    return {
      presence(active) {
        attendee.until = active ? Date.now() + PRESENCE_WINDOW_MS : 0;
        // 变为在场：补推它覆盖的、还没结、它没拿着的审批（含报过没送到的）；离开：推给它、还没结的对它算没收到
        if (active) {
          attendee.missed.clear();
          for (const pending of shown()) deliver(pending, attendee);
        } else attendee.held.clear();
        recheck();
      },
      undelivered(approvalId) {
        const pending = [...attendee.held].find(p => p.id === approvalId);
        if (!pending) return;
        attendee.held.delete(pending);
        attendee.missed.add(pending);
        recheck();
      },
      present: () => isPresent(attendee, Date.now()),
      respond(answer) {
        const pending = shown().find(p => p.id === answer.approvalId && covers(attendee, p));
        if (!pending?.approval) {
          // 已经结了的一律回已结算，不看覆盖：id 是本服务签发的随机串，接入只拿得到推给它的，回已结算不泄露什么
          return settledIds.get(answer.approvalId)
            ? refuse('approval-settled', t('approvalSettled'))
            : refuse('not-found', t('noSuchApproval', { id: answer.approvalId }));
        }
        if (!pending.req.canAnswer(attendee.who)) return refuse('forbidden', t('responderCannotAnswer'));
        if (answer.contentHash !== pending.approval.contentHash)
          return refuse('hash-mismatch', t('contentHashMismatch'));
        settle(pending, answer.decision === 'approve' ? 'approved' : 'denied', 'answer', {
          attendee,
          note: answer.note,
        });
        return { ok: true };
      },
      leave() {
        attendee.surface.attendees.delete(attendee);
        recheck();
      },
    };
  }

  function attachSurface(name: string, registrant: string): SurfaceBinding {
    const surface: SurfaceRecord = { name, registrant, attendees: new Set() };
    surfaces.add(surface);
    return {
      attend(who, sink, scope) {
        const attendee: Attendee = { surface, who, sink, scope, until: 0, held: new Set(), missed: new Set() };
        surface.attendees.add(attendee);
        return attendance(attendee);
      },
      detach() {
        surfaces.delete(surface);
        surface.attendees.clear();
        recheck();
      },
    };
  }

  /** 结算一批：从队尾往前，队首最后结，免得排在后面的同批审批先被推出来 */
  function settleAll(match: (pending: Pending) => boolean, source: 'turn-ended' | 'shutdown'): void {
    for (const queue of [...queues.values()]) {
      for (const pending of queue.filter(match).reverse()) settle(pending, 'cancelled', source);
    }
  }

  const service: ApprovalService = {
    request,
    list: filter =>
      shown().flatMap(({ approval }) =>
        approval && (filter?.sessionId === undefined || approval.sessionId === filter.sessionId) ? [approval] : [],
      ),
    attachSurface,
  };

  return {
    service,
    /** 这个会话有推出、还没结的审批 */
    pendingIn: (sessionId: string) => queues.get(sessionId)?.[0]?.approval !== undefined,
    /** 回合结束：它发起的、还没结的审批按 cancelled 结算 */
    turnEnded: (turnId: string) => settleAll(pending => pending.req.turnId === turnId, 'turn-ended'),
    /** 服务停止：没结的全部按 cancelled 结算，之后的请求直接拒绝 */
    close() {
      closed = true;
      settleAll(() => true, 'shutdown');
      clearTimeout(grace);
    },
    /** 已排进写入队列的审计都写完（写失败的已告警） */
    flushed: () => writing,
  };
}

/** 连接上的在场上报与应答：都经这条连接所在审批面的句柄，记在它的登记身份名下 */
export const approvalHandlers: Pick<MethodHandlers, 'presence/update' | 'approval/respond'> = {
  'presence/update': ({ active }, conn) => {
    conn.attendance.presence(active);
    return {};
  },
  'approval/respond': (answer, conn) => {
    const response = conn.attendance.respond(answer);
    if (!response.ok) {
      throw failure(response.refusal === 'unavailable' ? 'unsupported' : response.refusal, response.message);
    }
    return {};
  },
};
