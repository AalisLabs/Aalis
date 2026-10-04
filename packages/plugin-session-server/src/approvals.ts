// ════════════════════════════════════════════════════════════
// 审批（契约见 @aalis/api-approval）：发起、在场、排队、频率上限、应答核验、结算、回给模型的话与审计。
//
// 只有 owner 本人与 owner 链的延续发起的回合能产生审批，其余直接拒绝，不推给任何审批面。能产生的先看有没有人在场：
// 审批面上身份是 owner 的客户端上报活动，最近一次活动在 10 分钟内的算在场，发起时没人在场直接拒绝。同一会话的审批排队，
// 一次只推出一张卡，等待从推出那一刻算起；等满 300 秒、在场的客户端都离开且 30 秒内没有回来、回合结束或中止、服务停止时结算。
// 应答先答先得，核两项：应答人是 owner；id 由本服务签发且未结算，内容哈希一致。
// 请求与决定成对追加到家目录的 state/audit/approvals.jsonl，不进模型上下文；每个结算另记一行 info 日志（会话、工具、结局、原因）。
// ════════════════════════════════════════════════════════════

// biome-ignore lint/style/noRestrictedImports: 请求在发起的同一拍里定下去留与排队次序，内容哈希要同步算；异步的摘要会让并行的请求按完成先后乱序
import { createHash } from 'node:crypto';
// biome-ignore lint/style/noRestrictedImports: 审计是只追加的记录，存储网关没有追加写；位置取自 host-paths 给的家目录
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
  SettledState,
  SurfaceBinding,
} from '@aalis/api-approval';
import type { ToolDisplay } from '@aalis/api-tools';
import type { Events, Logger } from '@aalis/core';
import { createBoundedMap } from '@aalis/util-bounded-map';
import { failure, type MethodHandlers } from './connection.js';
import { resolveDisplay } from './display.js';
import type { IsOwner } from './history.js';

/** 推出之后等应答的时限 */
const APPROVAL_WAIT_MS = 300_000;
/** 客户端最近一次活动在这段时间内算在场 */
const PRESENCE_WINDOW_MS = 10 * 60_000;
/**
 * 等待中在场的客户端全部离开（断开或转为不在场）之后，再等这么久才按没人在场结算：手机切到别的应用、锁屏，
 * 桌面上切一下标签页，都会让连接挂起或页面转为不可见，回来时重连、重报在场，卡片照常等着。不延长总的等待时限
 */
const ABSENCE_GRACE_MS = 30_000;
/** 频率上限：同一会话在 RATE_WINDOW_MS 内最多 RATE_LIMIT 张卡 */
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT = 10;
/** 记住最近结算的这么多个 id：后到的应答回 approval-settled，更早的按不认识的 id 处理 */
const SETTLED_MEMORY = 1000;

/** 房间里的回合（发起类别 room）不论被什么拦下都只回这一句，不透露 owner 的文件布局与说明 */
const ROOM_DENIAL = '需要批准的操作在这里不能执行。';

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
  /** 在场到这个时刻为止；离开或从没上报过活动为 0 */
  until: number;
}

interface Pending {
  id: string;
  req: ApprovalRequest;
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
  /** 推给过的客户端，结算时通知它们 */
  delivered: Set<Attendee>;
}

/** 工具卡认审批用的几项：推出的审批对象，或发起时就结算、没有对象的请求 */
type ApprovalRef = Pick<Approval, 'id' | 'sessionId' | 'turnId' | 'callId'>;

interface ApprovalDeps {
  isOwner: IsOwner;
  events: Events;
  logger: Logger;
  /** 审计文件的绝对路径 */
  auditFile: string;
  /** 工具定义上声明的展示种类：卡片上的事实按它取 */
  displaySpec(tool: string): ToolDisplay | undefined;
  /** 一个审批推出或结算了（结算时带上怎样结算的，发起时就结算的也算）：会话列表与工具卡跟着变 */
  changed(approval: ApprovalRef, settlement?: ApprovalSettlement): void;
}

// ───────── 事实与哈希 ─────────

/** 疑似放密钥的文件：环境变量文件、包管理器与网络凭据、私钥与证书，以及密钥目录下的一切 */
const SECRET_PATH =
  /(?:^|[/:\\])(?:\.env(?:\.[^/\\]*)?|\.npmrc|\.netrc|\.pgpass|secrets?\.(?:ya?ml|json|toml)|id_(?:rsa|dsa|ecdsa|ed25519)|[^/\\]+\.(?:pem|key|p12|pfx))$|(?:^|[/:\\])(?:\.ssh|\.aws|\.gnupg|\.config[/\\]gh)[/\\]/i;
/** 疑似密钥的内容：私钥块、常见的令牌前缀、Bearer 凭据，以及「密钥名 = 值」 */
const SECRET_TEXT =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|(?:api[_-]?key|access[_-]?token|secret|password|passwd)["']?\s*[:=]\s*["']?[^\s"']{8,}/i;

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
  const secret = SECRET_PATH.test(path) || [removed, added].some(text => text !== undefined && SECRET_TEXT.test(text));
  const lines = (text: string | undefined, sign: '-' | '+') => text?.split('\n').map(line => sign + line) ?? [];
  const patch = [...lines(removed, '-'), ...lines(added, '+')].join('\n');
  return { diff: secret ? { path } : { path, patch }, params };
}

/** 请求内容的哈希：会话、回合、调用、工具与参数 */
function hashOf(req: ApprovalRequest): string {
  const content = [req.sessionId, req.turnId ?? null, req.callId ?? null, req.tool, req.args];
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// ───────── 回给模型的话 ─────────

/** 各结算来源：被什么拦下、能不能再申请（owner 的拒绝另附说明） */
const REASONS: Record<Exclude<ApprovalSource, 'owner'>, [reason: string, again: string]> = {
  absent: ['没人在场，没有人能批准', 'owner 在场时可以再申请；不要换别的办法绕过，先说明需要批准什么'],
  timeout: [`等了 ${APPROVAL_WAIT_MS / 1000} 秒没有人应答`, '可以再申请；不要换别的办法绕过'],
  ineligible: ['这一轮不是 owner 亲手发起的，不能产生审批', '不能；不要换别的办法绕过'],
  subtask: ['子任务里需要确认的操作不会转给 owner，请在发起它的会话里执行', '在子任务里不能'],
  'rate-limit': [
    `这个会话 ${RATE_WINDOW_MS / 60_000} 分钟内的审批已达 ${RATE_LIMIT} 张的上限`,
    '稍后可以；先停下来向 owner 说明在做什么',
  ],
  'turn-ended': ['发起它的回合已结束', '可以在新的一轮里再申请'],
  shutdown: ['审批服务已停止', '服务恢复后可以再申请'],
};

/** 日志里的结局 */
const OUTCOMES: Record<SettledState, string> = { approved: '批准', denied: '拒绝', expired: '过期', cancelled: '撤销' };

function denialFor(source: ApprovalSource, note: string | undefined): string {
  const [reason, again] =
    source === 'owner'
      ? [`owner 拒绝了${note ? `，说明：${note}` : ''}`, '不要原样再申请，按 owner 的意思调整']
      : REASONS[source];
  return `需要 owner 批准的操作没有执行。原因：${reason}。能否再申请：${again}。`;
}

// ───────── 服务 ─────────

export function createApprovals(deps: ApprovalDeps) {
  const surfaces = new Set<SurfaceRecord>();
  /** 每个会话的审批队列：队首推出了就有 approval，其余排着 */
  const queues = new Map<string, Pending[]>();
  /** 每个会话最近排进队的时刻，算频率上限：发起时就结算的不算，排着没推出就结算的退还 */
  const cards = new Map<string, number[]>();
  const settledIds = createBoundedMap<string, SettledState>({ max: SETTLED_MEMORY });
  let lapse: ReturnType<typeof setTimeout> | undefined;
  /** 在场的客户端全部离开之后的宽限：有推出的审批、又没人在场时才有 */
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

  /** 只有身份是 owner 的客户端算出席：别人答不了，推给它、算它在场都只会让审批白等 */
  const ownerAttends = (attendee: Attendee) => deps.isOwner(attendee.who.platform, attendee.who.userId);
  const present = (now = Date.now()) =>
    [...surfaces].flatMap(surface =>
      [...surface.attendees].filter(attendee => now < attendee.until && ownerAttends(attendee)),
    );
  /** 已推出、还没结的 */
  const shown = () => [...queues.values()].flatMap(queue => (queue[0]?.approval ? [queue[0]] : []));

  function deliver(pending: Pending, attendee: Attendee): void {
    const { approval } = pending;
    if (!approval || pending.delivered.has(attendee) || !ownerAttends(attendee)) return;
    pending.delivered.add(attendee);
    tell('推出', () => attendee.sink.requested(approval));
  }

  /** 推出之后在场的客户端都会在某个时刻失效：在那一刻再判一次 */
  function rearm(): void {
    clearTimeout(lapse);
    lapse = undefined;
    const now = Date.now();
    const live = present(now);
    if (live.length === 0 || shown().length === 0) return;
    lapse = setTimeout(recheck, Math.max(...live.map(attendee => attendee.until)) - now);
  }

  /** 在场或推出的审批有变：没人在场又有推出的审批时起宽限，有人回来或审批都结了就撤掉 */
  function recheck(): void {
    if (present().length > 0 || shown().length === 0) {
      clearTimeout(grace);
      grace = undefined;
    } else if (grace === undefined) {
      grace = setTimeout(() => {
        grace = undefined;
        for (const pending of shown()) settle(pending, 'expired', 'absent');
      }, ABSENCE_GRACE_MS);
    }
    rearm();
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
    const settlement: ApprovalSettlement = { state, source, at: now };
    const approval = pending.approval;
    if (approval) {
      approval.state = state;
      settledIds.set(approval.id, state);
      for (const attendee of pending.delivered) {
        if (attendee.surface.attendees.has(attendee))
          tell('结算', () => attendee.sink.settled(approval.id, settlement));
      }
      void deps.events.emit('approval:settled', approval);
    } else if (index >= 0) {
      // 排进过队、没推出就结算了：退还它占的频率额度
      const times = cards.get(sessionId) ?? [];
      const at = times.indexOf(pending.at);
      if (at >= 0) times.splice(at, 1);
    }
    // 没推出就结算的（发起时没人在场、发起者不能产生审批等）工具卡同样带上结算：历史里显示真实的结局，不是「失败」
    const { turnId, callId, tool } = pending.req;
    tell('结算', () => deps.changed({ id: pending.id, sessionId, turnId, callId }, settlement));
    // 每个结算一行 info，被拒的自主回合、超出频率上限的请求都在里面，运行状况的日志按提供审批服务的实例筛出它们
    const reason = source === 'owner' ? 'owner 应答' : REASONS[source][0];
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
      state === 'approved'
        ? { approvalId: pending.id, approved: true }
        : {
            approvalId: pending.id,
            approved: false,
            source,
            message: pending.req.origin.kind === 'room' ? ROOM_DENIAL : denialFor(source, by?.note),
          },
    );
    if (index === 0 && queue.length > 0) show(queue[0]);
    recheck();
  }

  /** 队首推给在场的客户端；排队期间回合中止了的、已经没人在场又不在宽限内的，直接结算 */
  function show(pending: Pending): void {
    if (pending.signal?.aborted) {
      settle(pending, 'cancelled', 'turn-ended');
      return;
    }
    const now = Date.now();
    const audience = present(now);
    if (audience.length === 0 && grace === undefined) {
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
      state: 'pending',
    };
    pending.approval = approval;
    pending.timer = setTimeout(() => settle(pending, 'expired', 'timeout'), APPROVAL_WAIT_MS);
    void deps.events.emit('approval:created', approval);
    tell('推出', () => deps.changed(approval));
    for (const attendee of audience) deliver(pending, attendee);
    recheck();
  }

  const recentCards = (sessionId: string, at: number) =>
    (cards.get(sessionId) ?? []).filter(t => at - t < RATE_WINDOW_MS);

  /** 发起时就结算的：服务已停、回合已中止、发起者不能产生审批、没人在场、超过频率上限 */
  function refusalOf(
    req: ApprovalRequest,
    signal: AbortSignal | undefined,
    at: number,
  ): [SettledState, ApprovalSource] | undefined {
    const { origin } = req;
    if (closed) return ['cancelled', 'shutdown'];
    if (signal?.aborted) return ['cancelled', 'turn-ended'];
    if (origin.kind === 'subtask') return ['denied', 'subtask'];
    const eligible = origin.kind === 'owner' || origin.kind === 'owner-chain';
    if (!eligible || !deps.isOwner(origin.platform, origin.userId)) return ['denied', 'ineligible'];
    if (present(at).length === 0) return ['expired', 'absent'];
    if (recentCards(req.sessionId, at).length >= RATE_LIMIT) return ['denied', 'rate-limit'];
    return undefined;
  }

  function request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    return new Promise(resolve => {
      const at = Date.now();
      const pending: Pending = {
        id: crypto.randomUUID(),
        req,
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
        tool,
        facts: pending.facts,
        contentHash: pending.contentHash,
        rule,
      });
      const refusal = refusalOf(req, signal, at);
      if (refusal) {
        settle(pending, ...refusal);
        return;
      }
      cards.set(sessionId, [...recentCards(sessionId, at), at]);

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
    const refuse = (refusal: ApprovalRefusal, message: string) => ({ ok: false as const, refusal, message });
    return {
      presence(active) {
        attendee.until = active ? Date.now() + PRESENCE_WINDOW_MS : 0;
        // 变为在场：补推还没结的审批
        if (active) for (const pending of shown()) deliver(pending, attendee);
        recheck();
      },
      respond(answer) {
        if (!deps.isOwner(attendee.who.platform, attendee.who.userId)) return refuse('forbidden', '应答人不是 owner');
        const pending = shown().find(p => p.id === answer.approvalId);
        if (!pending?.approval) {
          return settledIds.get(answer.approvalId)
            ? refuse('approval-settled', '这个审批已经结算')
            : refuse('not-found', `没有这个审批：${answer.approvalId}`);
        }
        if (answer.contentHash !== pending.approval.contentHash) return refuse('hash-mismatch', '内容哈希对不上');
        settle(pending, answer.decision === 'approve' ? 'approved' : 'denied', 'owner', {
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
      attend(who, sink) {
        const attendee: Attendee = { surface, who, sink, until: 0 };
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
      clearTimeout(lapse);
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
