// ════════════════════════════════════════════════════════════
// 历史：存档里的消息归并成会话条目，以及分页。
//
// 读回的存档先按 schema-message 的 groupToolCalls 归组（夹在工具调用与结果之间的别的消息挪到这组之后）。她一轮的输出在存档里
// 有两种格式：新格式是最后一条带时间线（segments）的回复，覆盖这一轮之前按旧格式落库的工具调用组；旧格式是分条的 assistant
// （带 toolCalls）与 tool 结果。同一轮里相邻的 assistant 与 tool 消息成一组，两种格式都归并成按时间顺序的思考、正文与工具调用
// 条目；每次模型调用说的话各成一条（重试的各版不连在一起）。提问、通知与发出的附件各自单独成条（她发的附件是只有附件的她的
// 消息，插件发的是带附件的通知）；提问的正文、附件与随附的转发取存档另记的发言人写的话（去掉转发的占位）、附件清单与转发，
// 宿主通知另带它的 id 与给界面的事实，通知与事件标记的文字先取存档另记的文字对象（没记的旧记录取正文）。进了一轮的输入（提问
// 与通知）带回合 id、进入方式与是否被点名；agent 写的回合记录在它之后还原成回合条目（结局与来源），只带记录的事件标记不另成条。
// 存档元数据只按 schema-message 登记的键读（WellKnownMetadataKeys），会话服务自己写进工具结果元数据的几个除外：工具卡的审批结算、「已发出」、回合停止时还没结束、命令的退出码与转到后台的
// 任务 id 取自工具结果的元数据（会话服务在结果落库前写上），没有结果的调用（重启或中断）同样算没结束。
// 房间里她只把最后的回复发进房间（api-agent 的约定）：工具调用之前说的话、重试丢掉的几版标「未发出」，平台没收下的回复
// 按适配器记的投递失败标出，与实时推送一致。
// ════════════════════════════════════════════════════════════

import type { MemoryService } from '@aalis/api-memory';
import { outboundAddress, unaddressedText } from '@aalis/api-message-archive';
import {
  ApprovalSettlementSchema,
  COMMAND_REPLY_TOPIC,
  type SessionItem,
  TurnOutcomeSchema,
} from '@aalis/api-session-protocol';
import { toolFailed } from '@aalis/api-tools';
import type { Logger } from '@aalis/core';
import { isTextRef, type TextRef } from '@aalis/schema-i18n';
import {
  type ArchivedAttachment,
  type ArchivedForward,
  CONTROL_KINDS,
  type ContentSegment,
  type ForwardFacts,
  groupToolCalls,
  type Message,
  type MessageAttachment,
  type OutgoingMessage,
  parseAttachmentRefs,
  WellKnownKinds,
  WellKnownMetadataKeys,
  withForwards,
} from '@aalis/schema-message';
import { failure } from './connection.js';
import type { DisplayOf } from './display.js';
import { t } from './texts.js';

/** 说话人是不是 owner */
export type IsOwner = (platform: string, userId?: string) => boolean;

/** 历史一页缺省归并的存档消息条数 */
export const HISTORY_PAGE = 100;

/** 房间里她在工具调用之前说的话：agent 只把最后的回复交给平台 */
export const BEFORE_TOOL_UNSENT = t('beforeToolUnsent');
/** 房间里重试丢掉的几版：最后一版才是回复 */
export const RETRIED = t('retried');
/**
 * 平台没收下她发出的消息，error 是投递结果给的原因原话：逐条发出停在中途的（sentPieces 是已发出的条数）写只发出了前几条，
 * 其余结果未知的（unconfirmed，可能已经送达）写可能已经发出，剩下的写没有发出
 */
export const notAccepted = (
  error: string | TextRef,
  { sentPieces, unconfirmed }: { sentPieces?: number; unconfirmed?: boolean } = {},
) =>
  sentPieces
    ? t('partlySent', { sent: sentPieces, error })
    : unconfirmed
      ? t('unconfirmed', { error })
      : t('notAccepted', { error });

/**
 * 事件标记还原成的通知的 topic：来源（出站消息的 source，存档记在 Source 键上）是 command 的是指令的回复，
 * 其余（宿主提示、压缩分隔线等）是事件标记。实时推送按出站消息的 source 取同一个
 */
export const markerTopic = (source: unknown) =>
  source === 'command' ? COMMAND_REPLY_TOPIC : WellKnownKinds.EventMarker;

/** 给会话里的文件签发下载句柄（绑定所在的会话）：存储地址与文件名 → 句柄；不签发的回 undefined */
export type SignFile = (uri: string, name: string) => string | undefined;

/** 归并一个会话的存档要的东西 */
export interface MergeContext {
  isOwner: IsOwner;
  /** 是房间的存档 */
  room: boolean;
  /** 会话所在的聊天窗口是多方的（根会话记下的 originChat.multiParty）：插话按它标出 */
  multiParty: boolean;
  signFile: SignFile;
  /** 工具卡的展示 */
  display: DisplayOf;
}

type Item<K extends SessionItem['kind']> = Extract<SessionItem, { kind: K }>;

type Attachment = { kind: ArchivedAttachment['kind']; src?: string; name?: string };

const OUTBOUND_KINDS: Readonly<Record<string, Attachment['kind']>> = {
  [WellKnownKinds.OutboundImage]: 'image',
  [WellKnownKinds.OutboundVideo]: 'video',
  [WellKnownKinds.OutboundAudio]: 'audio',
  [WellKnownKinds.OutboundFile]: 'file',
};

const ATTACHMENT_KINDS: ReadonlySet<string> = new Set(Object.values(OUTBOUND_KINDS));

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const isWebUrl = (value: string) => /^https?:\/\//i.test(value);
const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 发出的附件归档成 outbound-* 的消息（她发的 role assistant，插件发的 role notice），正文是附件引用占位符；认不出引用的
 * 回 undefined（她的按普通回复）
 */
function sentRefs(message: Message) {
  const kind = message.kind ? OUTBOUND_KINDS[message.kind] : undefined;
  if ((message.role !== 'assistant' && message.role !== 'notice') || !kind) return undefined;
  const refs = parseAttachmentRefs(message.content ?? '');
  return refs.length > 0 ? { kind, refs } : undefined;
}

/**
 * 一个附件还原成条目里的附件：图片、音频、视频的来源就是地址（存储地址或网址）；文件的地址是网址时直接给网址，存储地址不给，
 * 给句柄；名字没有时取地址的最后一段
 */
function restored(
  kind: Attachment['kind'],
  ref: string | undefined,
  name: string | undefined,
  signFile: SignFile,
): Attachment {
  if (kind !== 'file' || ref === undefined) {
    return { kind, ...(ref === undefined ? {} : { src: ref }), ...(name === undefined ? {} : { name }) };
  }
  const fileName = name ?? ref.slice(ref.lastIndexOf('/') + 1);
  return { kind, name: fileName, src: isWebUrl(ref) ? ref : signFile(ref, fileName) };
}

/**
 * 出站消息的一个附件推成的通知里的文字与附件，与存档记它的一样（api-message-archive 的 recordOutbound）：有地址的
 * （outboundAddress）带这个附件、文字为空，文件带名字；没有地址的是存档记的那一句（unaddressedText），不带附件
 */
export function outboundAttachmentPart(att: MessageAttachment, signFile: SignFile) {
  const address = outboundAddress(att);
  return address === undefined
    ? { text: unaddressedText(att), attachments: [] }
    : { text: '', attachments: [restored(att.kind, address, att.kind === 'file' ? att.name : undefined, signFile)] };
}

/**
 * 发出的附件还原成条目里的附件。文件的地址与名字先取存档时元数据里原样记下的（占位符里的地址遇到「]」会截断，
 * 描述位的「]」「|」换成了全角），没有时取占位符的引用与描述位
 */
function sentAttachments(message: Message, signFile: SignFile): Attachment[] | undefined {
  const sent = sentRefs(message);
  return sent?.refs.map(({ ref: parsed, desc }) =>
    sent.kind === 'file'
      ? restored(
          'file',
          text(message.metadata?.[WellKnownMetadataKeys.SentRef]) ?? parsed,
          text(message.metadata?.[WellKnownMetadataKeys.SentName]) ?? desc,
          signFile,
        )
      : restored(sent.kind, parsed, undefined, signFile),
  );
}

/** 存档里提问的附件清单：按类型取，不是数组、种类不认识的项不认，名字与地址不是字符串的当没有 */
function askedAttachments(value: unknown, signFile: SignFile): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry =>
    isRecord(entry) && typeof entry.kind === 'string' && ATTACHMENT_KINDS.has(entry.kind)
      ? [restored(entry.kind as Attachment['kind'], text(entry.ref), text(entry.name), signFile)]
      : [],
  );
}

/** 存档里提问随附的转发：按类型取，不是数组的不认，id 不是字符串的项不认，事实不合形状的当没有（见 {@link forwardFacts}） */
function archivedForwards(value: unknown): ArchivedForward[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return [];
    const facts = forwardFacts(entry.facts);
    return [facts ? { id: entry.id, facts } : { id: entry.id }];
  });
}

/**
 * 一段转发给界面的事实，按类型取：count 是有限数、participants 是字符串数组、text 是字符串，有一样不合就当没有事实；unlisted
 * 不是有限数、cutOff 不是 true 的当没有这一项（存储把 undefined 存成 null）
 */
function forwardFacts(value: unknown): ForwardFacts | undefined {
  if (!isRecord(value)) return undefined;
  const count = finite(value.count);
  const { participants, text: chat } = value;
  if (count === undefined || typeof chat !== 'string') return undefined;
  if (!Array.isArray(participants) || !participants.every(name => typeof name === 'string')) return undefined;
  const unlisted = finite(value.unlisted);
  return {
    count,
    participants,
    ...(unlisted === undefined ? {} : { unlisted }),
    text: chat,
    ...(value.cutOff === true ? { cutOff: true } : {}),
  };
}

/**
 * 发言人的话给人看的写法：随消息转发来的聊天记录另成一栏，文字里去掉它们的占位，连同占位留下的首尾空白；没有转发的原样
 */
export function spokenText(spoken: string, forwards: readonly { id: string }[] | undefined): string {
  if (!forwards?.length) return spoken;
  return withForwards(
    spoken,
    forwards.map(({ id }) => ({ id, content: '' })),
  ).trim();
}

/** 存档里宿主通知给界面的事实：只认字符串与有限数的项，不是对象或一项都不认时没有 */
function noticeFacts(value: unknown): Record<string, string | number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([, fact]) => typeof fact === 'string' || finite(fact) !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string | number>) : undefined;
}

/**
 * 存档消息的条目 id：时间戳加内容摘要。实时推送从同一条存档消息算出同一个 id，快照里的历史与之后的推送重叠时按 id 合并。
 * 成组归并的条目在这一组第一条消息的 id 后面加序号
 */
function archivedItemId(message: Message): string {
  const key = [
    message.role,
    message.kind ?? '',
    String(message.metadata?.[WellKnownMetadataKeys.UserId] ?? ''),
    message.content ?? '',
  ].join('\u0000');
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${message.timestamp ?? 0}-${(hash >>> 0).toString(36)}`;
}

type ReplyModel = NonNullable<Extract<SessionItem, { kind: 'agent-message' }>['model']>;

/**
 * 回复的模型与这一轮的 token，取 agent 记的 modelInfo：实时外发的消息与存档的元数据同一形状，实时与历史一致。
 * 存档是存储读回的（没有的项可能存成了 null），各项按类型取，不合的当没有
 */
export function replyModel(info: NonNullable<OutgoingMessage['modelInfo']>): ReplyModel {
  const { provider, model, promptTokens, completionTokens } = info;
  return {
    provider: text(provider),
    model: text(model),
    promptTokens: finite(promptTokens),
    completionTokens: finite(completionTokens),
  };
}

function speakerOf(message: Message, isOwner: IsOwner) {
  const meta = message.metadata ?? {};
  const platform = text(meta[WellKnownMetadataKeys.Platform]) ?? '';
  const userId = text(meta[WellKnownMetadataKeys.UserId]);
  return {
    platform,
    userId,
    nickname: text(meta[WellKnownMetadataKeys.Nickname]),
    source: text(meta[WellKnownMetadataKeys.Source]),
    owner: isOwner(platform, userId),
  };
}

/** 存档消息归进的回合：元数据记下的回合 id（进了一轮的输入、她这一轮的产出与回合里发出的记录都带） */
export const turnOf = (message: Message) => text(message.metadata?.[WellKnownMetadataKeys.TurnId]);

/**
 * 进了一轮的输入怎么进的，与是否被点名：进入方式取存档记的 TurnEntry；触发类型为 immediate 或 direct 的被点名，interval 的
 * 在多方的聊天窗口里是插话（false），其余（没经触发判定的、一对一窗口里过了频率闸的）没有。没进一轮的（存档没记进入方式）两样
 * 都没有
 */
function entryOf(message: Message, multiParty: boolean) {
  const meta = message.metadata;
  const recorded = meta?.[WellKnownMetadataKeys.TurnEntry];
  const entry = (['opened', 'joined'] as const).find(each => each === recorded);
  if (!entry) return {};
  const trigger = meta?.[WellKnownMetadataKeys.TriggerType];
  return {
    entry,
    addressed:
      trigger === 'immediate' || trigger === 'direct' ? true : trigger === 'interval' && multiParty ? false : undefined,
  };
}

/**
 * 回合记录（agent 记在一轮最后落库的那条上，见 schema-message 的 TurnRecord）还原成的回合条目，与实时推送的同一个 itemId；
 * 没记、记得不对或没记回合 id 的没有
 */
function recordedTurn(message: Message): Item<'turn'> | undefined {
  const turnId = turnOf(message);
  const record = message.metadata?.[WellKnownMetadataKeys.TurnRecord];
  if (!turnId || !isRecord(record)) return undefined;
  const outcome = TurnOutcomeSchema.safeParse(record.outcome);
  if (!outcome.success) return undefined;
  return {
    kind: 'turn',
    itemId: turnId,
    turnId,
    at: message.timestamp ?? 0,
    outcome: outcome.data,
    source: text(record.source),
  };
}

/**
 * 单独成条的存档消息：提问、通知（含压缩分隔线、指令的回复与平台事件合成的入站）、发出的附件（她发的是只有附件的她的消息，
 * 插件发的是带附件的通知，topic 同事件标记按来源取）。都带归进的回合 id（{@link turnOf}），与实时推送一样并进回合；进了一轮的
 * 提问与通知另带进入方式与是否被点名；随提问转发来的聊天记录另成 forwards（只带给界面的事实），文字里去掉它们的占位。她的回复
 * 与工具调用要成组归并，带回合记录的（只带记录的事件标记）、其余系统消息与组外的工具结果不显示，都回 undefined
 */
export function archivedItem(
  message: Message,
  { isOwner, multiParty, signFile }: MergeContext,
): SessionItem | undefined {
  const meta = message.metadata;
  if (meta?.[WellKnownMetadataKeys.TurnRecord] !== undefined) return undefined;
  const itemId = archivedItemId(message);
  const turnId = turnOf(message);
  const at = message.timestamp ?? 0;
  const recorded = meta?.[WellKnownMetadataKeys.Text];
  // 记了给人看的那句的入站是平台事件合成或转成的（如好友申请、戳一戳），不是谁的发言：画成通知，种类取存档记的子类或来源
  if (message.role === 'user' && !isTextRef(recorded)) {
    const spoken = meta?.[WellKnownMetadataKeys.SpokenContent];
    const forwards = archivedForwards(meta?.[WellKnownMetadataKeys.Forwards]);
    return {
      kind: 'user-message',
      itemId,
      turnId,
      ...entryOf(message, multiParty),
      at,
      text: spokenText(typeof spoken === 'string' ? spoken : (message.content ?? ''), forwards),
      attachments: askedAttachments(meta?.[WellKnownMetadataKeys.Attachments], signFile),
      ...(forwards.length > 0 ? { forwards: forwards.map(({ facts }) => (facts ? { facts } : {})) } : {}),
      speaker: speakerOf(message, isOwner),
    };
  }
  const sent = sentAttachments(message, signFile);
  if (sent) {
    return message.role === 'notice'
      ? {
          kind: 'notice',
          itemId,
          turnId,
          at,
          topic: markerTopic(meta?.[WellKnownMetadataKeys.Source]),
          text: '',
          attachments: sent,
        }
      : { kind: 'agent-message', itemId, turnId, at, text: '', attachments: sent };
  }
  if (
    message.role === 'user' ||
    message.role === 'notice' ||
    (message.role === 'system' && message.kind === WellKnownKinds.EventMarker)
  ) {
    return {
      kind: 'notice',
      itemId,
      turnId,
      ...entryOf(message, multiParty),
      at,
      topic:
        text(meta?.[WellKnownMetadataKeys.HostNoticeKind]) ??
        (message.kind === WellKnownKinds.EventMarker
          ? markerTopic(meta?.[WellKnownMetadataKeys.Source])
          : message.kind) ??
        text(meta?.[WellKnownMetadataKeys.Source]) ??
        message.role,
      text: isTextRef(recorded) ? recorded : (message.content ?? ''),
      attachments: [],
      noticeId: text(meta?.[WellKnownMetadataKeys.HostNoticeId]),
      facts: noticeFacts(meta?.[WellKnownMetadataKeys.HostNoticeFacts]),
    };
  }
  return undefined;
}

/** 成组的消息：她的回复（不是发出的附件）与带 toolCallId 的工具结果 */
const inGroup = (m: Message) => (m.role === 'assistant' && !sentRefs(m)) || (m.role === 'tool' && !!m.toolCallId);

/** cur 接着 prev 在同一组：都是成组的消息，且属于同一轮（旧数据没记回合的不分） */
function sameGroup(prev: Message, cur: Message): boolean {
  if (!inGroup(prev) || !inGroup(cur)) return false;
  const [a, b] = [turnOf(prev), turnOf(cur)];
  return a === undefined || b === undefined || a === b;
}

type ToolSegment = Extract<ContentSegment, { type: 'tool_call' }>;

/**
 * 一组回复与工具调用归并出的时间线：新格式取最后一条带时间线的回复；旧格式思考前置，正文与工具调用按序，
 * 工具结果按 toolCallId 对回它的调用（找不到调用的结果不显示）。另给出各次调用的工具结果元数据（按 callId），
 * 以及这一组是不是以回复收尾（最后一条是不带工具调用的回复）
 */
function groupTimeline(group: Message[]) {
  const segments: ContentSegment[] = [];
  const reasoning: ContentSegment[] = [];
  const calls = new Map<string, ToolSegment>();
  const results = new Map<string, Record<string, unknown>>();
  let timeline = false;
  let finalContent = '';
  let lastAt = group[0]?.timestamp ?? 0;
  let model: ReplyModel | undefined;
  for (const [k, cur] of group.entries()) {
    if (cur.role === 'tool') {
      const callId = text(cur.metadata?.[WellKnownMetadataKeys.CallId]);
      if (callId && cur.metadata) results.set(callId, cur.metadata);
      const call = calls.get(cur.toolCallId as string);
      if (call) {
        call.result = cur.content ?? '';
        call.callId = callId;
      }
      continue;
    }
    const info = cur.metadata?.[WellKnownMetadataKeys.ModelInfo] as OutgoingMessage['modelInfo'];
    if (info) model = replyModel(info);
    lastAt = cur.timestamp ?? lastAt;
    if (cur.segments?.length) {
      timeline = true;
      segments.length = 0;
      reasoning.length = 0;
      calls.clear();
      segments.push(...cur.segments.map(s => ({ ...s })));
      continue;
    }
    if (cur.reasoningContent) reasoning.push({ type: 'reasoning_text', content: cur.reasoningContent });
    if (cur.toolCalls?.length) {
      if (cur.content) segments.push({ type: 'text', content: cur.content });
      for (const call of cur.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          /* 坏参数显示成空参数 */
        }
        const segment: ToolSegment = { type: 'tool_call', name: call.function.name, args };
        segments.push(segment);
        calls.set(call.id, segment);
      }
    } else if (k === group.length - 1) {
      finalContent = cur.content ?? '';
    } else if (cur.content) {
      segments.push({ type: 'text', content: cur.content });
    }
  }
  const ordered = timeline
    ? segments
    : [...reasoning, ...segments, ...(finalContent ? [{ type: 'text' as const, content: finalContent }] : [])];
  const last = group.at(-1);
  const replied = last?.role === 'assistant' && !last.toolCalls?.length;
  return { ordered, lastAt, model, results, replied };
}

/** 工具结果元数据里记下的审批结算；没有或形状不对的不认 */
function recordedApproval(metadata: Record<string, unknown> | undefined) {
  const recorded = metadata?.approval;
  if (!isRecord(recorded) || typeof recorded.id !== 'string') return undefined;
  const settlement = ApprovalSettlementSchema.safeParse(recorded);
  return settlement.success ? { approvalId: recorded.id, settlement: settlement.data } : undefined;
}

/**
 * 一组归并成条目。工具卡以 callId 为 id（与实时推送相同），旧存档没有 callId 时按这一组第一条消息的 id 加序号；
 * 参数不是对象的（旧存档里模型给出的 null、数组等）按空参数显示。房间里以回复收尾的一组，最后一次工具调用之后的最后一条
 * 是回复，failures 里有这一轮的就标平台没收下；其余她说的话标未发出
 */
function mergeGroup(group: Message[], context: MergeContext, failures: ReadonlyMap<string, TextRef>): SessionItem[] {
  const { ordered, lastAt, model, results, replied } = groupTimeline(group);
  const base = archivedItemId(group[0] as Message);
  const turnId = group.map(turnOf).find(id => id !== undefined);
  const items: SessionItem[] = [];
  const id = () => `${base}/${items.length}`;
  for (const segment of ordered) {
    const last = items.at(-1);
    if (segment.type === 'tool_call') {
      const { result, startTime, endTime, callId } = segment;
      const metadata = callId === undefined ? undefined : results.get(callId);
      const approval = recordedApproval(metadata);
      const taskId = text(metadata?.backgroundTask);
      const args = isRecord(segment.args) ? segment.args : {};
      const resolved = context.display(segment.name, args, result);
      // 退出码以落库时记下的为准：结果过长时落库的是截断后的，从中取不到。没记下的（会话服务当时没在跑）从结果里取
      const exitCode = metadata?.exitCode;
      const display =
        resolved?.kind === 'command' && Number.isInteger(exitCode)
          ? { ...resolved, exitCode: exitCode as number }
          : resolved;
      items.push({
        kind: 'tool-call',
        itemId: callId ?? id(),
        turnId,
        at: startTime ?? lastAt,
        name: segment.name,
        args,
        status:
          result === undefined || metadata?.aborted === true
            ? 'aborted'
            : approval && approval.settlement.state !== 'approved'
              ? 'denied'
              : toolFailed(result, display?.kind === 'command' ? display.exitCode : undefined)
                ? 'failed'
                : 'completed',
        result,
        durationMs: startTime !== undefined && endTime !== undefined ? endTime - startTime : undefined,
        ...(display ? { display } : {}),
        ...(metadata?.sentToRoom === true ? { sentToRoom: true } : {}),
        ...approval,
        ...(taskId === undefined ? {} : { taskId }),
      });
    } else if (segment.type === 'reasoning_text') {
      if (last?.kind === 'reasoning') last.text += segment.content;
      else items.push({ kind: 'reasoning', itemId: id(), turnId, at: lastAt, text: segment.content });
    } else {
      items.push({ kind: 'agent-message', itemId: id(), turnId, at: lastAt, text: segment.content, attachments: [] });
    }
  }
  const shown = items.filter(i => !((i.kind === 'agent-message' || i.kind === 'reasoning') && i.text === ''));
  const lastCall = shown.map(i => i.kind).lastIndexOf('tool-call');
  const said = shown.flatMap((item, index) => (item.kind === 'agent-message' ? [{ item, index }] : []));
  const final = said.at(-1);
  const reply = replied && final && final.index > lastCall ? final.item : undefined;
  if (reply && model) reply.model = model;
  if (context.room) {
    for (const { item, index } of said) {
      if (item !== reply) item.undelivered = { reason: index < lastCall ? BEFORE_TOOL_UNSENT : RETRIED };
    }
    const failure = turnId === undefined ? undefined : failures.get(turnId);
    if (reply && failure !== undefined) reply.undelivered = { reason: failure };
  }
  return shown;
}

/**
 * 适配器记下的投递失败里，一轮回复没发出的：回合 id → 未发出的原因。适配器记的原因是字符串或文字对象（按形状认），逐条发出
 * 停在中途的另记已发出的条数，结果未知的另列名单；经工具发出的（带 callId）不算，那次调用的结果已写明；没记回合或原因的旧记录
 * 不认
 */
function replyFailures(raw: readonly Message[]): Map<string, TextRef> {
  const failures = new Map<string, TextRef>();
  for (const message of raw) {
    if (message.kind !== WellKnownKinds.OutboundDeliveryFailed) continue;
    if (message.metadata?.[WellKnownMetadataKeys.CallId] !== undefined) continue;
    const turnId = turnOf(message);
    const recorded = message.metadata?.[WellKnownMetadataKeys.DeliveryError];
    const error = isTextRef(recorded) ? recorded : text(recorded);
    const sentPieces = finite(message.metadata?.[WellKnownMetadataKeys.SentPieces]);
    const unconfirmed = message.metadata?.[WellKnownMetadataKeys.Unconfirmed];
    if (turnId && error) {
      failures.set(
        turnId,
        notAccepted(error, { sentPieces, unconfirmed: Array.isArray(unconfirmed) && unconfirmed.length > 0 }),
      );
    }
  }
  return failures;
}

/**
 * 一段存档消息（按 groupToolCalls 挪过的次序）归并成条目，顺序同它；记着回合记录的那条之后接这一轮的回合条目。failures 见
 * replyFailures
 */
export function mergeArchive(
  raw: readonly Message[],
  context: MergeContext,
  failures: ReadonlyMap<string, TextRef>,
): SessionItem[] {
  const items: SessionItem[] = [];
  for (let i = 0; i < raw.length; ) {
    const message = raw[i] as Message;
    let end = i + 1;
    if (message.role === 'assistant' && inGroup(message)) {
      while (end < raw.length && sameGroup(raw[end - 1] as Message, raw[end] as Message)) end++;
      items.push(...mergeGroup(raw.slice(i, end), context, failures));
    } else {
      const item = archivedItem(message, context);
      if (item) items.push(item);
    }
    items.push(...raw.slice(i, end).flatMap(m => recordedTurn(m) ?? []));
    i = end;
  }
  return items;
}

const absentOr = (value: unknown, valid: (value: unknown) => boolean) => value == null || valid(value);
const isText = (value: unknown) => typeof value === 'string';
const isTime = (value: unknown) => finite(value) !== undefined;

/** 时间线的一段：工具调用的参数不在这里核，不是对象的按空参数显示 */
function wellFormedSegment(segment: unknown): boolean {
  if (!isRecord(segment)) return false;
  if (segment.type === 'text' || segment.type === 'reasoning_text') return isText(segment.content);
  return (
    segment.type === 'tool_call' &&
    isText(segment.name) &&
    absentOr(segment.result, isText) &&
    absentOr(segment.callId, isText) &&
    absentOr(segment.startTime, isTime) &&
    absentOr(segment.endTime, isTime)
  );
}

const wellFormedCall = (call: unknown) =>
  isRecord(call) &&
  isText(call.id) &&
  isRecord(call.function) &&
  isText(call.function.name) &&
  isText(call.function.arguments);

/**
 * 存档读回的消息字段对不对。没有的字段存成 null 的（MongoDB 就是这样）算没有；不对的（旧数据、手改或别的插件写坏的）
 * 整条不进历史，前后的照常归并。元数据里的键按登记的类型逐个取，不在这里核
 */
function wellFormed(message: Message): boolean {
  const { role, content, kind, timestamp, toolCallId, reasoningContent, toolCalls, segments, metadata } =
    message as unknown as Record<string, unknown>;
  return (
    isText(role) &&
    absentOr(content, isText) &&
    absentOr(kind, isText) &&
    absentOr(timestamp, isTime) &&
    absentOr(toolCallId, isText) &&
    absentOr(reasoningContent, isText) &&
    absentOr(toolCalls, value => Array.isArray(value) && value.every(wellFormedCall)) &&
    absentOr(segments, value => Array.isArray(value) && value.every(wellFormedSegment)) &&
    absentOr(metadata, isRecord)
  );
}

/**
 * 读一页历史：before 是上一页第一条存档消息的 id，缺省从最新的读起；读回的一段按 groupToolCalls 挪过次序之后取 limit 条归并。
 * 页的开头落在一组回复与工具调用中间，或落在组外的工具结果上（读的这一段把它的组切开了，调用在更早的存档里）时往前扩，免得一组
 * 拆在两页。skip 挑出不进历史的消息（在途回合落了库的那些），它们照样占位置，分页不受影响；字段不对的消息（{@link wellFormed}）
 * 不进历史，也不占位置，读到了就记一条 warn。before 指向的消息已不在存档里（被回滚删掉）时回 not-found。
 */
export async function readHistory(
  memory: MemoryService,
  sessionId: string,
  page: { before?: string; limit: number; skip: (message: Message) => boolean },
  context: MergeContext,
  logger: Pick<Logger, 'warn'>,
): Promise<{ items: SessionItem[]; before?: string }> {
  const read = (n: number) =>
    memory.getFullHistory ? memory.getFullHistory(sessionId, n) : memory.getHistory(sessionId, n);
  // 读回的条数按读法的口径数：getFullHistory 事件标记也占条数，兜底的 getHistory 只数对话消息（夹在其间的标记一并带回）
  const counted = (stored: Message[]) =>
    memory.getFullHistory ? stored.length : stored.filter(m => !CONTROL_KINDS.includes(m.kind ?? '')).length;
  for (let want = page.limit + 1; ; want *= 2) {
    const stored = await read(want);
    const exhausted = counted(stored) < want;
    const kept = stored.filter(wellFormed);
    const units = groupToolCalls(kept);
    const raw = units.flatMap(({ at }) => at.map(i => kept[i] as Message));
    const loose = new Set(units.flatMap(({ at, shape }) => (shape === 'loose' ? at.map(i => kept[i]) : [])));
    const end = page.before === undefined ? raw.length : raw.findIndex(m => archivedItemId(m) === page.before);
    if (end < 0) {
      if (exhausted) throw failure('not-found', t('historyCursorExpired', { before: String(page.before) }));
      continue;
    }
    let start = Math.max(0, end - page.limit);
    while (start > 0 && (loose.has(raw[start]) || sameGroup(raw[start - 1] as Message, raw[start] as Message))) start--;
    if (start === 0 && !exhausted) continue;
    const dropped = stored.length - raw.length;
    if (dropped > 0) logger.warn(`会话 ${sessionId} 的存档里读到 ${dropped} 条字段不对的消息，没进历史`);
    // 回复的投递失败记在回复之后，可能落在更新的一页：从这一页的开头往后全看
    const items = mergeArchive(
      raw.slice(start, end).filter(m => !page.skip(m)),
      context,
      replyFailures(raw.slice(start)),
    );
    return start > 0 ? { items, before: archivedItemId(raw[start] as Message) } : { items };
  }
}
