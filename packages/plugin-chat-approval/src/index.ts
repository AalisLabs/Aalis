// ════════════════════════════════════════════════════════════
// 聊天审批：受众只有 owner 的 IM 私聊作审批面（登记名 chat）。owner 在私聊里亲手发言即在场，每个私聊一份限定在它的接入，
// 只收这个私聊里发起的审批；审批推回这里，owner 引用那条审批消息回复「同意」或「拒绝 原因」即结，回复不交给 agent。
// 只经契约组合，不认平台：owner 取权限服务的发起类别，一对一取出生平台的适配器的声明，引用取投递结果里的平台消息 id。
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
import { rootSessionOf, sessionManager } from '@aalis/api-session-manager';
import { type BoundOf, definePlugin, optional } from '@aalis/core';
import { type TextRef, textLines, toSource } from '@aalis/schema-i18n';
import { awaitDelivery, type IncomingMessage, type OutgoingMessage } from '@aalis/schema-message';
import { createBoundedMap } from '@aalis/util-bounded-map';
import { t } from './texts.js';

// 权限服务、会话管理或平台缺席时认不出 owner 的私聊：不接入、不推
const uses = {
  approvals,
  gateway,
  hooks,
  authority: optional(authority),
  sessionManager: optional(sessionManager),
  platform: optional(platform),
};
type Caps = BoundOf<typeof uses>;

/** 每项事实最多显示的字数，超出的保留首尾各一半 */
const FACT_LIMIT = 500;
/** 记住最近这么多条审批消息（引用回复据它认出回的是哪一张）与应答过的入站消息 */
const MEMORY = 1000;

/** 应答首尾不论的空白（含全角空格）与标点 */
const EDGES = /^[\s。！!.~，,？?：:]+|[\s。！!.~，,？?：:]+$/g;
/**
 * 应答词，英文不分大小写：整条恰为「同意」「approve」为批准（「同意吗」「同意不了」与以问号收尾的「同意？」不算）；「拒绝」「deny」开头为拒绝，
 * 后面可带原因。不收 y、n：指令插件的意图确认在等时会把下一条消息当作对它的回答，词表避开它的词，免得回意图确认的那条
 * 被当成应答
 */
const APPROVE = /^(?:同意|approve)$/i;
/** 以问号收尾的是在问，不算批准 */
const QUESTION = /[？?]\s*$/;
const DENY = /^(?:拒绝|deny)/i;

type Answer = { decision: 'approve' } | { decision: 'deny'; note?: string };

function answerOf(content: string): Answer | undefined {
  const text = content.replace(EDGES, '');
  if (APPROVE.test(text) && !QUESTION.test(content)) return { decision: 'approve' };
  const match = DENY.exec(text);
  if (!match) return undefined;
  const note = text.slice(match[0].length).replace(EDGES, '');
  return note ? { decision: 'deny', note } : { decision: 'deny' };
}

/** 一项事实：清洗并截断，截掉的写明省略了多少字 */
function fact(value: string): string | TextRef {
  const { head, omitted, tail } = clipForCard(value, FACT_LIMIT);
  return omitted === 0 ? head : t('clipped', { head, count: omitted, tail });
}

/**
 * 推到私聊的审批消息：工具，命令、目录、文件、改动、参数各一行，末行是怎么回复与还剩几分钟（按审批的到期时刻算，
 * 不足一分钟按一分钟）
 */
function requestText({ tool, facts, expiresAt }: Approval, now: number): TextRef {
  const { command, cwd, diff, params } = facts;
  return textLines([
    t('request', { tool: sanitizeForCard(tool) }),
    ...(command === undefined ? [] : [t('factCommand', { value: fact(command) })]),
    ...(cwd === undefined ? [] : [t('factCwd', { value: fact(cwd) })]),
    ...(diff
      ? [
          t('factFile', { value: fact(diff.path) }),
          t('factPatch', { value: diff.patch === undefined ? t('patchHidden') : fact(diff.patch) }),
        ]
      : []),
    ...(Object.keys(params).length > 0 ? [t('factParams', { value: fact(JSON.stringify(params)) })] : []),
    t('howToAnswer', { minutes: Math.ceil((expiresAt - now) / 60_000) }),
  ]);
}

export default definePlugin({
  name: '@aalis/plugin-chat-approval',
  displayName: t('displayName'),
  subsystem: 'authority',
  uses,
  apply: runChatApproval,
});

/** 推到一个私聊、还没结的一张审批 */
interface Shown {
  approval: Approval;
  /** 送达时平台给了消息 id：认得出引用它的回复 */
  quotable: boolean;
  /** 推出时延续了在场、owner 之后还没在这里亲手说过话：结算时对这个接入上报离开 */
  unheard: boolean;
}

/** 一个 owner 私聊的接入 */
interface Chat {
  sessionId: string;
  platform: string;
  attendance: ApprovalAttendance;
  /** 推到这里、还没结的审批 */
  pending: Map<string, Shown>;
}

function runChatApproval({ approvals, gateway, hooks, authority, sessionManager, platform }: Caps): void {
  const surface = approvals.use.registerSurface('chat');
  const chats = new Map<string, Chat>();
  /** 审批消息的平台消息 id（按会话）→ 那张审批 */
  const quoted = createBoundedMap<string, Approval>({ max: MEMORY });
  /** 应答过的入站消息 id（按会话） */
  const answered = createBoundedMap<string, true>({ max: MEMORY });
  const keyOf = (sessionId: string, messageId: string) => `${sessionId}\n${messageId}`;

  /**
   * 这条消息是 owner 在与她的一对一窗口里亲手发的，就交出 owner 的身份：发起类别为 owner（与执行守卫判发起类别同一份定义），
   * 根会话有出生平台且就是消息的平台（WebUI 往这个私聊插话不算），出生平台的适配器（与会话管理建档时判一对一用的同一个）
   * 明确声明了它的窗口类型为一对一（推断出的一对一不算）
   */
  function ownerOf(message: IncomingMessage): ApprovalIdentity | undefined {
    if (!authority.present || !sessionManager.present || !platform.present) return undefined;
    const { sessionId, platform: from, userId, actor, source } = message;
    const turn = { sessionId, platform: from, userId, actor, inbound: { source } };
    if (userId === undefined || authority.use.originOf(turn) !== 'owner') return undefined;
    const lookup = (id: string) => sessionManager.use.getSession(id);
    const root = rootSessionOf(lookup(sessionId), lookup);
    const origin = root?.originChat;
    const born = root?.originPlatform;
    if (!root || !origin || born !== from) return undefined;
    const adapter = getPlatformAdapters(platform).find(entry => entry.platform === born);
    return adapter?.sessionTypes?.find(type => type.name === origin.type)?.multiParty === false
      ? { platform: from, userId }
      : undefined;
  }

  /** 发一句到这个私聊：宿主提示，正文按纯文字发，网关按会话的语言渲染；交回平台的投递结果 */
  async function send(chat: Chat, text: TextRef) {
    const message: OutgoingMessage = {
      content: toSource(text),
      text,
      sessionId: chat.sessionId,
      platform: chat.platform,
      source: 'system',
    };
    await gateway.use.dispatchOutbound(message);
    return message.delivery && (await awaitDelivery(message.delivery));
  }

  /**
   * 推一张审批。没送达时 owner 在这里看不到它：对这个接入上报离开，不让它白等。送达且平台给了消息 id 才认得出引用它的
   * 回复，这时算 owner 会在这里看到，在场重新计时，只延续到这张结算；平台不给 id 时补一句这里无法应答。送达之前已经结了的
   * 只记下消息 id（引用它的回复回「已经处理过」）
   */
  async function push(chat: Chat, approval: Approval): Promise<void> {
    const result = await send(chat, requestText(approval, Date.now()));
    if (!result?.ok) {
      chat.attendance.presence(false);
      return;
    }
    const ids = result.messageIds ?? [];
    for (const id of ids) quoted.set(keyOf(chat.sessionId, id), approval);
    const shown = chat.pending.get(approval.id);
    if (!shown) return;
    if (ids.length === 0) {
      await send(chat, t('answerElsewhere'));
      return;
    }
    shown.quotable = true;
    shown.unheard = true;
    chat.attendance.presence(true);
  }

  /** owner 在这个私聊里亲手说了话：推出时延续的在场不再在结算时收回 */
  function heard(chat: Chat): void {
    for (const shown of chat.pending.values()) shown.unheard = false;
  }

  /** 这个私聊的接入，首次即建 */
  function chatOf(sessionId: string, owner: ApprovalIdentity): Chat {
    const existing = chats.get(sessionId);
    if (existing) return existing;
    const pending = new Map<string, Shown>();
    const chat: Chat = {
      sessionId,
      platform: owner.platform,
      pending,
      attendance: surface.attend(
        owner,
        {
          requested: approval => {
            pending.set(approval.id, { approval, quotable: false, unheard: false });
            void push(chat, approval);
          },
          settled: (approvalId, { state }) => {
            const shown = pending.get(approvalId);
            pending.delete(approvalId);
            if (!shown) return;
            // 推出时延续的在场到这里为止：owner 自推出以来没在这里说过话，就不再算他在这里
            if (shown.unheard) chat.attendance.presence(false);
            // 只在过期时说一句：在这里回的、在别处处理的与撤销的，回合自己的回复会说明结果
            if (state === 'expired') void send(chat, t('expired', { tool: sanitizeForCard(shown.approval.tool) }));
          },
        },
        sessionId,
      ),
    };
    chats.set(sessionId, chat);
    return chat;
  }

  // 在场：在派发相位记（与网关判受众的时机一致：IM 私聊的第一条消息与入站同拍建档，判早了可能还没建档）
  hooks.use.middleware(INBOUND_PHASE.DISPATCH, async (data, next) => {
    const owner = ownerOf(data.message);
    if (owner) {
      const chat = chatOf(data.message.sessionId, owner);
      heard(chat);
      chat.attendance.presence(true);
    }
    await next();
  });

  // 应答：在指令相位截下，回审批的消息不进指令解析、不交给 agent，也就不会起新的一轮把在跑的那一轮中止
  hooks.use.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
    const { message } = data;
    const chat = chats.get(message.sessionId);
    const answer = chat && answerOf(message.content);
    if (!chat || !answer) return next();
    const approval = message.replyTo && quoted.get(keyOf(chat.sessionId, message.replyTo.messageId));
    if ((!approval && chat.pending.size === 0) || !ownerOf(message)) return next();
    if (message.messageId !== undefined) {
      const key = keyOf(chat.sessionId, message.messageId);
      if (answered.get(key)) return;
      answered.set(key, true);
    }
    heard(chat);
    if (!approval) {
      // 推着的审批都没有消息 id 时，引用了也认不出
      const quotable = [...chat.pending.values()].some(shown => shown.quotable);
      await send(chat, t(quotable ? 'quoteToAnswer' : 'answerElsewhere'));
      return;
    }
    const response = chat.attendance.respond({ approvalId: approval.id, contentHash: approval.contentHash, ...answer });
    if (response.ok) return;
    // 审批服务不认得的 id（服务重启过）同样是已经不在等的
    const settled = response.refusal === 'approval-settled' || response.refusal === 'not-found';
    await send(chat, settled ? t('alreadySettled') : t('answerRefused', { reason: response.message }));
  });
}
