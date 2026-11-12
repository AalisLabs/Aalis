// ════════════════════════════════════════════════════════════
// 聊天审批：IM 里的审批面（登记名 chat），两种接入：
// - owner 的 IM 私聊：每个（owner 的 IM 身份，机器人账号）一份，限定这个账号。她经这个账号亲手说话（私聊与群里，点没点名都算）
//   即在场；她经这个账号发起的、只有她能批的审批推到她与这个账号的私聊，卡上写来源；
// - 群窗口：每个（群窗口，发言者）一份，限定这个窗口（根会话）。他在这个群里亲手说话即在场；这个群发起的参与者审批（连同它的
//   子会话里的）、他能批的发在这个群里，同一张只发一条。
// 子会话里的审批另写一行是哪个子任务（审批对象的来源链）。
// 引用那条审批消息回复「同意」或「拒绝 原因」即结，回复不交给 agent。审批服务说接入已不在场时撤掉，再说话时重建。只经契约组合，
// 不认平台：owner 取权限服务的判定，一对一取出生平台的适配器的声明，群窗口取会话表记下的多方标记，引用取投递结果里的平台消息 id。
// ════════════════════════════════════════════════════════════

import {
  type Approval,
  type ApprovalAttendance,
  type ApprovalIdentity,
  type AttendScope,
  approvals,
  clipForCard,
  sanitizeForCard,
} from '@aalis/api-approval';
import { authority } from '@aalis/api-authority';
import { events } from '@aalis/api-events';
import { gateway, INBOUND_PHASE } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { getPlatformAdapters, platform } from '@aalis/api-platform';
import { oneToOneWith, rootSessionOf, type SessionInfo, sessionManager } from '@aalis/api-session-manager';
import { type BoundOf, definePlugin, lifecycle, logger, optional } from '@aalis/core';
import { type TextRef, textLines, toSource } from '@aalis/schema-i18n';
import { AT_SELF_PATTERN, awaitDelivery, type IncomingMessage, type OutgoingMessage } from '@aalis/schema-message';
import { createBoundedMap } from '@aalis/util-bounded-map';
import { t } from './texts.js';

// 权限服务、会话管理或平台缺席时认不出 owner 的私聊：不接入、不推；会话管理缺席时认不出群窗口
const uses = {
  approvals,
  events,
  gateway,
  hooks,
  lifecycle,
  logger,
  authority: optional(authority),
  sessionManager: optional(sessionManager),
  platform: optional(platform),
};
type Caps = BoundOf<typeof uses>;

/** 每项事实最多显示的字数，超出的保留首尾各一半 */
const FACT_LIMIT = 500;
/** 记住最近这么多条审批消息（引用回复据它认出回的是哪一张）与应答过的入站消息 */
const MEMORY = 1000;

/** 应答首尾不论的一个字：空白（含全角空格）与标点 */
const EDGE = /[\s。！!.~，,？?：:]/;
/**
 * 应答词，英文不分大小写：整条恰为「同意」「approve」为批准（「同意吗」「同意不了」不算）；「拒绝」「deny」开头为拒绝，后面可带
 * 原因（「denylist」不算）
 */
const APPROVE = /^(?:同意|approve)$/i;
const DENY = /^(?:拒绝|deny\b)/i;

type Answer = { decision: 'approve' } | { decision: 'deny'; note?: string };

/** 去掉开头的空白与标点（逐字扫描） */
function trimStartEdges(text: string): string {
  let start = 0;
  while (start < text.length && EDGE.test(text[start])) start++;
  return text.slice(start);
}

/**
 * 应答词交出应答，不是的交出 undefined。开头对她的 @（AT_SELF_PATTERN，只认开头：在群里引用她的消息回复时，QQ 客户端会自动在
 * 开头插一个）不算正文；拒绝的原因照原样转交，只去掉它与「拒绝」之间的空白、标点与末尾的空白
 */
function answerOf(content: string): Answer | undefined {
  const at = AT_SELF_PATTERN.exec(content);
  const text = trimStartEdges(at?.index === 0 ? content.slice(at[0].length) : content);
  let end = text.length;
  while (end > 0 && EDGE.test(text[end - 1])) end--;
  if (APPROVE.test(text.slice(0, end))) return { decision: 'approve' };
  const match = DENY.exec(text);
  if (!match) return undefined;
  const note = trimStartEdges(text.slice(match[0].length)).trimEnd();
  return note ? { decision: 'deny', note } : { decision: 'deny' };
}

/** 一项事实：清洗并截断，截掉的写明省略了多少字 */
function fact(value: string): string | TextRef {
  const { head, omitted, tail } = clipForCard(value, FACT_LIMIT);
  return omitted === 0 ? head : t('clipped', { head, count: omitted, tail });
}

/**
 * 会话名放进卡上的一行：换行与制表符换成空格，再与事实一样清洗并截断（群名、子任务名由别人或模型起，不能另起一行冒充来源或
 * 事实，也不能把消息撑长）
 */
const oneLine = (name: string) => fact(name.replace(/[\n\t]/g, ' '));

/**
 * 审批消息。推到私聊的（给了 source，来源一行）：工具，来源，子任务，命令、目录、文件、改动、参数各一行，末行是怎么回复；
 * 发在群里的（不给 source：就发在发起它的这个群里）：工具，子任务，各项事实，一行写这一轮里有人自己做不了，末行是能做的人怎么
 * 回复。子任务一行只在子会话里的审批有，写来源链的各级标题（默认名是文字对象，原样作参数）。末行写还剩几分钟（按审批的到期时刻
 * 算，不足一分钟按一分钟，墙钟已过到期时刻、等待的计时器还没到时也写一分钟）
 */
function requestText({ tool, facts, expiresAt, chain }: Approval, source: TextRef | undefined, now: number): TextRef {
  const { command, cwd, diff, params } = facts;
  const titles = (chain ?? []).map(({ title }) => (typeof title === 'string' ? oneLine(title) : title));
  const subtask =
    titles.length === 0 ? [] : [t('subtask', { chain: titles.reduce((head, tail) => t('chainStep', { head, tail })) })];
  const lines = [
    ...subtask,
    ...(command === undefined ? [] : [t('factCommand', { value: fact(command) })]),
    ...(cwd === undefined ? [] : [t('factCwd', { value: fact(cwd) })]),
    ...(diff ? [t('factFile', { value: fact(diff.path) }), t('factPatch', { value: fact(diff.patch) })] : []),
    ...(Object.keys(params).length > 0 ? [t('factParams', { value: fact(JSON.stringify(params)) })] : []),
  ];
  const named = { tool: sanitizeForCard(tool) };
  const left = { minutes: Math.max(1, Math.ceil((expiresAt - now) / 60_000)) };
  return textLines(
    source === undefined
      ? [t('windowRequest', named), ...lines, t('windowWhy'), t('windowHowToAnswer', left)]
      : [t('request', named), source, ...lines, t('howToAnswer', left)],
  );
}

export default definePlugin({
  name: '@aalis/plugin-chat-approval',
  displayName: t('displayName'),
  subsystem: 'authority',
  uses,
  apply: runChatApproval,
});

/**
 * 一条消息的投递：送达（带平台给的消息 id）、确定没送达，或结果未知（发出去了没等到平台确认，可能已经送达：不能当没送达，
 * 也不重发）
 */
type Delivery = { state: 'delivered'; messageIds: string[] } | { state: 'failed' | 'unknown' };

/** 推到一处、还没结的一张审批 */
interface Shown {
  approval: Approval;
  /** 投递的结果：还在发时没有 */
  sent?: Delivery['state'];
}

/** 一个身份在一处的接入 */
interface Attendee {
  attendance: ApprovalAttendance;
  /** 推给它、还没结的审批 id：哪张发不出去就对拿着它的接入报这一张没送到；不空时这份接入不撤 */
  held: Set<string>;
}

/** 发审批消息的一处：owner 与一个机器人账号的私聊，或一个群窗口 */
interface Place {
  /** 私聊的会话 id，或群窗口的根会话 id */
  sessionId: string;
  platform: string;
  /** 这里的接入的限定：私聊限定机器人账号，群窗口限定这个窗口 */
  scope: AttendScope;
  /** 推到这里、还没结的审批：同一张在这里只发一条 */
  shown: Map<string, Shown>;
  /** 这里的接入，按身份：私聊只有 owner 的一份，群窗口每个发言者一份 */
  attendees: Map<string, Attendee>;
}

function runChatApproval({
  approvals,
  events,
  gateway,
  hooks,
  lifecycle,
  logger,
  authority,
  sessionManager,
  platform,
}: Caps): void {
  const { signal } = lifecycle.use;
  const surface = approvals.use.registerSurface('chat');
  /** owner 的私聊，每个（身份，机器人账号）一处 */
  const chats = new Map<string, Place>();
  /** 群窗口，按根会话 id */
  const windows = new Map<string, Place>();
  /** 审批消息的平台消息 id（按私聊或群窗口）→ 那张审批的 id */
  const quoted = createBoundedMap<string, string>({ max: MEMORY });
  /** 应答过的入站消息 id（按私聊或群窗口） */
  const answered = createBoundedMap<string, true>({ max: MEMORY });
  const keyOf = (sessionId: string, messageId: string) => `${sessionId}\n${messageId}`;
  const whoKey = ({ platform, userId }: ApprovalIdentity) => `${platform}\n${userId}`;
  const placeOf = (sessionId: string, platform: string, scope: AttendScope): Place => ({
    sessionId,
    platform,
    scope,
    shown: new Map(),
    attendees: new Map(),
  });

  /**
   * 亲手发这条消息的人：不带 source 的消息的发言者。不带 source 的消息不带 actor（触发器不给没点名的话回填身份），按发言者认
   * 与权限服务判这一轮为 hand、参与者就是发言者等价
   */
  function handOf({ platform: from, userId, source }: IncomingMessage): ApprovalIdentity | undefined {
    return source === undefined && userId ? { platform: from, userId } : undefined;
  }

  const isOwner = (who: ApprovalIdentity) => authority.present && authority.use.isOwner(who.platform, who.userId);

  /**
   * 她与这个机器人账号的私聊：会话表里机器人账号相同、按 oneToOneWith 是她自己与她的私聊的根会话。出生平台就是身份的平台，
   * 出生平台的适配器（与会话管理建档时判一对一用的同一个）明确声明了这个窗口的类型为一对一（推断出的不算），对端就是她
   * （实现端上报了机器人自己发的消息、机器人账号又登记成 owner 时，那个身份没有这样的私聊）。WebUI 与终端的会话没有出生平台，
   * 找不到
   */
  function privateChatOf(owner: ApprovalIdentity, selfId: string | undefined): string | undefined {
    if (!sessionManager.present || !platform.present) return undefined;
    const adapters = getPlatformAdapters(platform);
    const declared = (root: SessionInfo) =>
      adapters
        .find(adapter => adapter.platform === root.originPlatform)
        ?.sessionTypes?.find(type => type.name === root.originChat?.type)?.multiParty === false;
    return sessionManager.use
      .listSessions({ parentId: null })
      .find(root => root.originChat?.selfId === selfId && oneToOneWith(root, owner, declared(root)))?.id;
  }

  /** 她与这个机器人账号的私聊这一处；她与这个账号还没有私聊时没有，等她来私聊 */
  function chatOf(owner: ApprovalIdentity, selfId: string | undefined): Place | undefined {
    const key = `${whoKey(owner)}\n${selfId ?? ''}`;
    const known = chats.get(key);
    if (known) return known;
    const sessionId = privateChatOf(owner, selfId);
    if (sessionId === undefined) return undefined;
    const chat = placeOf(sessionId, owner.platform, { selfId });
    chats.set(key, chat);
    return chat;
  }

  /**
   * 这条消息所在的群窗口这一处：会话是会话表里聊天窗口记成多方的根会话（只有 IM 房间的根会话记聊天窗口），消息从它的出生平台
   * 来（从 WebUI 往群里插话的不是在群里说的）。不是在群窗口里说的没有
   */
  function windowOf({ sessionId, platform: from }: IncomingMessage): Place | undefined {
    const room = sessionManager.present ? sessionManager.use.getSession(sessionId) : undefined;
    if (!room?.originChat?.multiParty || room.originPlatform !== from) return undefined;
    const known = windows.get(sessionId);
    if (known) return known;
    const place = placeOf(sessionId, from, { window: sessionId });
    windows.set(sessionId, place);
    return place;
  }

  /** 他说这条消息时接入的各处：owner 与这个机器人账号的私聊（她在私聊与群里说的都算），与这条消息所在的群窗口 */
  function placesOf(message: IncomingMessage, who: ApprovalIdentity): Place[] {
    const chat = isOwner(who) ? chatOf(who, message.selfId) : undefined;
    const room = windowOf(message);
    return [...(chat ? [chat] : []), ...(room ? [room] : [])];
  }

  /**
   * 卡上的来源：审批所在会话的根会话是群还是私聊（宿主写的固定字）与窗口 id，会话名只作附注（换行与制表符换成空格，群名
   * 由群管理员控制，不能另起一行冒充来源或事实）；判不出窗口的写会话 id
   */
  function sourceOf(sessionId: string): TextRef {
    const sm = sessionManager.present ? sessionManager.use : undefined;
    const root = sm && rootSessionOf(sm.getSession(sessionId), id => sm.getSession(id));
    const chatWindow = root?.originChat;
    return t('source', {
      kind: chatWindow ? (chatWindow.multiParty ? 'group' : 'private') : 'session',
      id: sanitizeForCard(chatWindow?.targetId ?? sessionId),
      name: root?.name === undefined ? '' : t('sourceName', { name: oneLine(root.name) }),
    });
  }

  /**
   * 发一句到这一处：宿主提示，正文按纯文字发，网关按会话的语言渲染；交回投递结果，不抛。停用之后不发；网关不在、没有适配器
   * 接手、发送或回执出错的是没送达；等满时限、等的时候停用了、适配器报结果未知的是结果未知
   */
  async function send(place: Place, text: TextRef): Promise<Delivery> {
    if (signal.aborted || !gateway.present) return { state: 'failed' };
    const message: OutgoingMessage = {
      content: toSource(text),
      text,
      sessionId: place.sessionId,
      platform: place.platform,
      source: 'system',
    };
    try {
      await gateway.use.dispatchOutbound(message);
      if (!message.delivery) return { state: 'failed' };
      const result = await awaitDelivery(message.delivery, signal);
      if (result?.ok) return { state: 'delivered', messageIds: result.messageIds ?? [] };
      return { state: result && !result.unconfirmed ? 'failed' : 'unknown' };
    } catch (err) {
      logger.use.warn('聊天审批发消息出错:', err);
      return { state: 'failed' };
    }
  }

  /**
   * 推一张审批：发到这一处（群窗口就是它的根会话，不按审批所在的会话找）。确定没送达时这里的人看不到它：这张还在等就对拿着它的
   * 接入报这一张没送到，审批服务只把这一张对它们算没收到（推给它们的别的照旧），他们再说话时补推。结果未知的可能已经送达：不报、
   * 不补推，只是认不出引用它的回复。送达且平台给了消息 id 才认得出引用它的回复；不给时补一句这里无法应答。送达之前已经结了的
   * 只记下消息 id（引用它的回复回「已经处理过」）
   */
  async function push(place: Place, shown: Shown): Promise<void> {
    const { approval } = shown;
    const source = place.scope.window === undefined ? sourceOf(approval.sessionId) : undefined;
    const delivery = await send(place, requestText(approval, source, Date.now()));
    shown.sent = delivery.state;
    const waiting = place.shown.get(approval.id) === shown;
    if (delivery.state === 'failed' && waiting) {
      for (const attendee of place.attendees.values()) {
        if (attendee.held.has(approval.id)) attendee.attendance.undelivered(approval.id);
      }
    }
    if (delivery.state !== 'delivered') return;
    for (const id of delivery.messageIds) quoted.set(keyOf(place.sessionId, id), approval.id);
    if (waiting && delivery.messageIds.length === 0) await send(place, t('answerElsewhere'));
  }

  /** 他在这一处的接入，没有就建 */
  function attendeeOf(place: Place, who: ApprovalIdentity): Attendee {
    const key = whoKey(who);
    const known = place.attendees.get(key);
    if (known) return known;
    const held = new Set<string>();
    const attendee: Attendee = {
      held,
      attendance: surface.attend(
        who,
        {
          requested: approval => {
            held.add(approval.id);
            // 同一张在这里只发一条：推给这里别的接入的与补推的同一张，送达过的、结果未知的与还在发的不再发，确定没送达的重发
            const posted = place.shown.get(approval.id);
            if (posted && posted.sent !== 'failed') return;
            const entry: Shown = { approval };
            place.shown.set(approval.id, entry);
            push(place, entry).catch(err => logger.use.warn('聊天审批推送审批出错:', err));
          },
          settled: (approvalId, { state }) => {
            held.delete(approvalId);
            const entry = place.shown.get(approvalId);
            place.shown.delete(approvalId);
            // 只给送达过的、只在过期与撤销时说一句（这里的每份接入都收到同一个结算，只说一次）：在这里回的与在别处处理的，
            // 回合自己的回复会说明结果；撤销的（回合被停下、会话被删、/clear）那一轮不一定有回复
            if (entry?.sent === 'delivered' && (state === 'expired' || state === 'cancelled'))
              void send(place, t(state, { tool: sanitizeForCard(entry.approval.tool) }));
          },
        },
        place.scope,
      ),
    };
    place.attendees.set(key, attendee);
    return attendee;
  }

  /**
   * 撤掉审批服务说已不在场的接入，他再说话时重建：接入不随说过话的人一直增多。推给它、还没结的照留：这不是在场规则（推给它的
   * 都没送到、最近又没说话时它已不在场），是撤了就收不到这些卡的结算，过期那一行发不出，这一处记着的卡也删不掉
   */
  function sweep(): void {
    for (const place of [...chats.values(), ...windows.values()]) {
      for (const [key, attendee] of place.attendees) {
        if (attendee.held.size > 0 || attendee.attendance.present()) continue;
        attendee.attendance.leave();
        place.attendees.delete(key);
      }
    }
  }

  /**
   * 有人亲手说了话：先撤掉不在场的接入，再对他接入的各处上报在场（还没有接入就建）。这条消息的会话还不在会话表里时（她第一次
   * 私聊这个账号、群里的第一条消息，会话与这条入站同拍建档），先等会话管理收录这条入站（同一条共用同一次）
   */
  async function spoke(message: IncomingMessage): Promise<void> {
    const who = handOf(message);
    if (!who) return;
    if (sessionManager.present && !sessionManager.use.getSession(message.sessionId)) {
      await sessionManager.use.recordInbound(message);
    }
    if (signal.aborted) return;
    sweep();
    for (const place of placesOf(message, who)) attendeeOf(place, who).attendance.presence(true);
  }

  // 在场：监听入站事件，没点名、在触发相位就被吞掉的群聊也算
  events.use.on('inbound:message', message => {
    spoke(message).catch(err => logger.use.warn('聊天审批记在场出错:', err));
  });

  // 应答：在私聊或群窗口里亲手发的、引用了那里的审批消息、正文是应答词的，在指令相位截下，不进指令解析、不交给 agent；别的
  // （没引用审批消息的、引用了但不是应答词的）照常往下，是交给这一轮的普通消息。按发言者找他在这一处的接入应答，还没有就先建
  hooks.use.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
    const { message } = data;
    const { replyTo } = message;
    const who = replyTo && handOf(message);
    const place = who && placesOf(message, who).find(p => p.sessionId === message.sessionId);
    const approvalId = replyTo && place && quoted.get(keyOf(place.sessionId, replyTo.messageId));
    const answer = approvalId && answerOf(message.content);
    if (!who || !place || !approvalId || !answer) return next();
    if (message.messageId !== undefined) {
      const key = keyOf(place.sessionId, message.messageId);
      if (answered.get(key)) return;
      answered.set(key, true);
    }
    const shown = place.shown.get(approvalId);
    if (!shown) {
      await send(place, t('alreadySettled'));
      return;
    }
    const response = attendeeOf(place, who).attendance.respond({
      approvalId,
      contentHash: shown.approval.contentHash,
      ...answer,
    });
    if (response.ok) return;
    // 审批服务不认得的 id（服务重启过）同样是已经不在等的；其余（应答人不能批这一张等）照审批服务给的原因回
    const settled = response.refusal === 'approval-settled' || response.refusal === 'not-found';
    await send(place, settled ? t('alreadySettled') : t('answerRefused', { reason: response.message }));
  });
}
