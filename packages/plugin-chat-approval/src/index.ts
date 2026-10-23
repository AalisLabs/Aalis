// ════════════════════════════════════════════════════════════
// 聊天审批：owner 与她的 IM 私聊作审批面（登记名 chat）。每个（owner 的 IM 身份，机器人账号）一份接入，她第一次经这个账号
// 亲手说话时建，建时定下她与这个账号的私聊；她经这个账号亲手说话（私聊与群里，点没点名都算）即在场，她经这个账号发起的审批
// 推到这个私聊，卡上写来源。她在这个私聊里引用那条审批消息回复「同意」或「拒绝 原因」即结，回复不交给 agent。
// 只经契约组合，不认平台：owner 取权限服务的判定，一对一取出生平台的适配器的声明，引用取投递结果里的平台消息 id。
// ════════════════════════════════════════════════════════════

import {
  type Approval,
  type ApprovalAttendance,
  type ApprovalIdentity,
  approvals,
  clipForCard,
  sanitizeForCard,
} from '@aalis/api-approval';
import { authority } from '@aalis/api-authority';
import { gateway, INBOUND_PHASE } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { getPlatformAdapters, platform } from '@aalis/api-platform';
import { oneToOneWith, rootSessionOf, type SessionInfo, sessionManager } from '@aalis/api-session-manager';
import { type BoundOf, definePlugin, events, lifecycle, logger, optional } from '@aalis/core';
import { type TextRef, textLines, toSource } from '@aalis/schema-i18n';
import { awaitDelivery, type IncomingMessage, type OutgoingMessage } from '@aalis/schema-message';
import { createBoundedMap } from '@aalis/util-bounded-map';
import { t } from './texts.js';

// 权限服务、会话管理或平台缺席时认不出 owner 的私聊：不接入、不推
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

/** 超过这么多字的不是应答 */
const ANSWER_LIMIT = 200;
/** 应答首尾不论的一个字：空白（含全角空格）与标点 */
const EDGE = /[\s。！!.~，,？?：:]/;
/** 尾部去掉的标点里有问号：是在问，不是应答 */
const ASKING = /[？?]/;
/**
 * 应答词，英文不分大小写：整条恰为「同意」「approve」为批准（「同意吗」「同意不了」不算）；「拒绝」「deny」开头为拒绝，后面可带
 * 原因（「denylist」不算）。不收 y、n：指令插件的意图确认在等时会把下一条消息当作对它的回答，词表避开它的词，免得回意图确认
 * 的那条被当成应答
 */
const APPROVE = /^(?:同意|approve)$/i;
const DENY = /^(?:拒绝|deny\b)/i;

type Answer = { decision: 'approve' } | { decision: 'deny'; note?: string };

/** 去掉首尾的空白与标点，逐字扫描：交出中间的正文与尾部去掉的那段 */
function trimEdges(text: string): { body: string; tail: string } {
  let start = 0;
  let end = text.length;
  while (start < end && EDGE.test(text[start])) start++;
  while (end > start && EDGE.test(text[end - 1])) end--;
  return { body: text.slice(start, end), tail: text.slice(end) };
}

function answerOf(content: string): Answer | undefined {
  if (content.length > ANSWER_LIMIT) return undefined;
  const { body, tail } = trimEdges(content);
  if (ASKING.test(tail)) return undefined;
  if (APPROVE.test(body)) return { decision: 'approve' };
  const match = DENY.exec(body);
  if (!match) return undefined;
  const note = trimEdges(body.slice(match[0].length)).body;
  return note ? { decision: 'deny', note } : { decision: 'deny' };
}

/** 一项事实：清洗并截断，截掉的写明省略了多少字 */
function fact(value: string): string | TextRef {
  const { head, omitted, tail } = clipForCard(value, FACT_LIMIT);
  return omitted === 0 ? head : t('clipped', { head, count: omitted, tail });
}

/**
 * 推到私聊的审批消息：工具，来源，命令、目录、文件、改动、参数各一行，末行是怎么回复与还剩几分钟（按审批的到期时刻算，
 * 不足一分钟按一分钟，墙钟已过到期时刻、等待的计时器还没到时也写一分钟）
 */
function requestText({ tool, facts, expiresAt }: Approval, source: TextRef, now: number): TextRef {
  const { command, cwd, diff, params } = facts;
  return textLines([
    t('request', { tool: sanitizeForCard(tool) }),
    source,
    ...(command === undefined ? [] : [t('factCommand', { value: fact(command) })]),
    ...(cwd === undefined ? [] : [t('factCwd', { value: fact(cwd) })]),
    ...(diff ? [t('factFile', { value: fact(diff.path) }), t('factPatch', { value: fact(diff.patch) })] : []),
    ...(Object.keys(params).length > 0 ? [t('factParams', { value: fact(JSON.stringify(params)) })] : []),
    t('howToAnswer', { minutes: Math.max(1, Math.ceil((expiresAt - now) / 60_000)) }),
  ]);
}

export default definePlugin({
  name: '@aalis/plugin-chat-approval',
  displayName: t('displayName'),
  subsystem: 'authority',
  uses,
  apply: runChatApproval,
});

/** 推到私聊、还没结的一张审批 */
interface Shown {
  approval: Approval;
  /** 投递的结果：还在发时没有 */
  sent?: 'delivered' | 'failed';
  /** 送达时平台给了消息 id：认得出引用它的回复 */
  quotable: boolean;
}

/** owner 的一个 IM 身份经一个机器人账号的接入 */
interface Chat {
  /** 建时定下的、她与这个账号的私聊 */
  sessionId: string;
  platform: string;
  attendance: ApprovalAttendance;
  /** 推到这里、还没结的审批 */
  shown: Map<string, Shown>;
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
  /** 每个（身份，机器人账号）一份 */
  const chats = new Map<string, Chat>();
  /** 审批消息的平台消息 id（按私聊）→ 那张审批的 id */
  const quoted = createBoundedMap<string, string>({ max: MEMORY });
  /** 应答过的入站消息 id（按私聊） */
  const answered = createBoundedMap<string, true>({ max: MEMORY });
  const keyOf = (sessionId: string, messageId: string) => `${sessionId}\n${messageId}`;
  const chatKey = ({ platform, userId }: ApprovalIdentity, selfId: string | undefined) =>
    `${platform}\n${userId}\n${selfId ?? ''}`;

  /**
   * 这条消息是 owner 亲手发的，就交出她的身份：不带 source、发言者是 owner。不带 source 的消息不带 actor（触发器不给没点名的
   * 话回填身份），这与权限服务判这一轮为 hand 且参与者是 owner 等价
   */
  function handOf({ platform: from, userId, source }: IncomingMessage): ApprovalIdentity | undefined {
    if (!authority.present || source !== undefined || userId === undefined) return undefined;
    return authority.use.isOwner(from, userId) ? { platform: from, userId } : undefined;
  }

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
      name:
        root?.name === undefined ? '' : t('sourceName', { name: sanitizeForCard(root.name.replace(/[\n\t]/g, ' ')) }),
    });
  }

  /**
   * 发一句到这个私聊：宿主提示，正文按纯文字发，网关按会话的语言渲染；交回平台的投递结果。停用之后不发、不等回执；
   * 发不出或等不到回执时交回 undefined，不抛
   */
  async function send(chat: Chat, text: TextRef) {
    if (signal.aborted || !gateway.present) return undefined;
    const message: OutgoingMessage = {
      content: toSource(text),
      text,
      sessionId: chat.sessionId,
      platform: chat.platform,
      source: 'system',
    };
    try {
      await gateway.use.dispatchOutbound(message);
      return message.delivery && (await awaitDelivery(message.delivery, signal));
    } catch (err) {
      logger.use.warn('聊天审批往私聊发消息出错:', err);
      return undefined;
    }
  }

  /**
   * 推一张审批。没送达时她在这里看不到它：这张还在等就对这份接入上报离开，审批服务把推给它、还没结的都算没收到，她再说话时
   * 补推。送达且平台给了消息 id 才认得出引用它的回复；不给时补一句这里无法应答。送达之前已经结了的只记下消息 id（引用它的
   * 回复回「已经处理过」）
   */
  async function push(chat: Chat, shown: Shown): Promise<void> {
    const { approval } = shown;
    const result = await send(chat, requestText(approval, sourceOf(approval.sessionId), Date.now()));
    const waiting = chat.shown.get(approval.id) === shown;
    if (!result?.ok) {
      shown.sent = 'failed';
      if (waiting) chat.attendance.presence(false);
      return;
    }
    shown.sent = 'delivered';
    const ids = result.messageIds ?? [];
    for (const id of ids) quoted.set(keyOf(chat.sessionId, id), approval.id);
    if (!waiting) return;
    if (ids.length === 0) {
      await send(chat, t('answerElsewhere'));
      return;
    }
    shown.quotable = true;
  }

  /** 建一份接入：她与这个账号没有私聊时不建，等她来私聊 */
  function open(key: string, owner: ApprovalIdentity, selfId: string | undefined): Chat | undefined {
    const sessionId = privateChatOf(owner, selfId);
    if (sessionId === undefined) return undefined;
    const shown = new Map<string, Shown>();
    const chat: Chat = {
      sessionId,
      platform: owner.platform,
      shown,
      attendance: surface.attend(
        owner,
        {
          requested: approval => {
            // 补推的同一张：送达过的与还在发的不再发，没送达的重发
            const known = shown.get(approval.id);
            if (known && known.sent !== 'failed') return;
            const entry: Shown = { approval, quotable: false };
            shown.set(approval.id, entry);
            push(chat, entry).catch(err => logger.use.warn('聊天审批推送审批出错:', err));
          },
          settled: (approvalId, { state }) => {
            const entry = shown.get(approvalId);
            shown.delete(approvalId);
            // 只给送达过的、只在过期时说一句：在这里回的、在别处处理的与撤销的，回合自己的回复会说明结果
            if (entry?.sent === 'delivered' && state === 'expired')
              void send(chat, t('expired', { tool: sanitizeForCard(entry.approval.tool) }));
          },
        },
        { selfId },
      ),
    };
    chats.set(key, chat);
    return chat;
  }

  /**
   * 她经这个账号亲手说了话：有接入就上报在场，没有就试着建。建之前等会话管理收录这条入站（同一条共用同一次）：她第一次私聊
   * 这个账号时，私聊与这条入站同拍建档
   */
  async function spoke(message: IncomingMessage): Promise<void> {
    const owner = handOf(message);
    if (!owner) return;
    const key = chatKey(owner, message.selfId);
    if (!chats.has(key) && sessionManager.present) await sessionManager.use.recordInbound(message);
    if (signal.aborted) return;
    (chats.get(key) ?? open(key, owner, message.selfId))?.attendance.presence(true);
  }

  /** 这条消息是她在一份接入的私聊里亲手发的，就交出这份接入 */
  function chatAt(message: IncomingMessage): Chat | undefined {
    const owner = handOf(message);
    const chat = owner && chats.get(chatKey(owner, message.selfId));
    return chat?.sessionId === message.sessionId ? chat : undefined;
  }

  // 在场：监听入站事件，没点名、在触发相位就被吞掉的群聊也算
  events.use.on('inbound:message', message => {
    spoke(message).catch(err => logger.use.warn('聊天审批记在场出错:', err));
  });

  // 应答：在指令相位截下，回审批的消息不进指令解析、不交给 agent，也就不会起新的一轮把在跑的那一轮中止
  hooks.use.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
    const { message } = data;
    const chat = chatAt(message);
    const answer = chat && answerOf(message.content);
    if (!chat || !answer) return next();
    const approvalId = message.replyTo && quoted.get(keyOf(chat.sessionId, message.replyTo.messageId));
    if (!approvalId && chat.shown.size === 0) return next();
    if (message.messageId !== undefined) {
      const key = keyOf(chat.sessionId, message.messageId);
      if (answered.get(key)) return;
      answered.set(key, true);
    }
    if (!approvalId) {
      // 推着的审批都没有消息 id 时，引用了也认不出
      const quotable = [...chat.shown.values()].some(shown => shown.quotable);
      await send(chat, t(quotable ? 'quoteToAnswer' : 'answerElsewhere'));
      return;
    }
    const shown = chat.shown.get(approvalId);
    if (!shown) {
      await send(chat, t('alreadySettled'));
      return;
    }
    const response = chat.attendance.respond({ approvalId, contentHash: shown.approval.contentHash, ...answer });
    if (response.ok) return;
    // 审批服务不认得的 id（服务重启过）同样是已经不在等的
    const settled = response.refusal === 'approval-settled' || response.refusal === 'not-found';
    await send(chat, settled ? t('alreadySettled') : t('answerRefused', { reason: response.message }));
  });
}
