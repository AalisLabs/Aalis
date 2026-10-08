// ════════════════════════════════════════════════════════════
// 历史：存档里的消息归并成会话条目，以及分页。
//
// 她一轮的输出在存档里有两种格式：新格式是最后一条带时间线（segments）的回复，覆盖这一轮之前按旧格式落库的工具调用组；
// 旧格式是分条的 assistant（带 toolCalls）与 tool 结果。同一轮里相邻的 assistant 与 tool 消息成一组，两种格式都归并成
// 按时间顺序的思考、正文与工具调用条目；每次模型调用说的话各成一条（重试的各版不连在一起）。提问、通知与她发出的附件
// 各自单独成条；提问的正文与附件取存档另记的发言人写的话与附件清单，宿主通知另带它的 id 与给界面的事实。存档元数据
// 只按 schema-message 登记的键读（WellKnownMetadataKeys），会话服务自己写进工具结果元数据的几个除外：工具卡的审批结算、
// 「已发到群」、回合停止时还没结束、命令的退出码与转到后台的任务 id 取自工具结果的元数据（会话服务在结果落库前写上），
// 没有结果的调用（重启或中断）同样算没结束。
// 房间里她只把最后的回复发进群（api-agent 的约定）：工具调用之前说的话、重试丢掉的几版标「未发出」，平台没收下的回复
// 按适配器记的投递失败标出，与实时推送一致。
// ════════════════════════════════════════════════════════════

import type { MemoryService } from '@aalis/api-memory';
import { ApprovalSettlementSchema, type SessionItem } from '@aalis/api-session-protocol';
import { toolFailed } from '@aalis/api-tools';
import type { Logger } from '@aalis/core';
import {
  type ArchivedAttachment,
  type ContentSegment,
  type Message,
  type OutgoingMessage,
  parseAttachmentRefs,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '@aalis/schema-message';
import { failure } from './connection.js';
import type { DisplayOf } from './display.js';

/** 说话人是不是 owner */
export type IsOwner = (platform: string, userId?: string) => boolean;

/** 历史一页缺省归并的存档消息条数 */
export const HISTORY_PAGE = 100;

/** 房间里她在工具调用之前说的话：agent 只把最后的回复交给平台 */
export const BEFORE_TOOL_UNSENT = '没有发出：调用工具之前说的话不发到群里';
/** 房间里重试丢掉的几版：最后一版才是回复 */
export const RETRIED = '没有发出：格式校验没通过，已重试';
/** 平台没收下她发出的消息，error 是投递结果给的原因 */
export const notAccepted = (error: string) => `没有发出：平台没收下（${error}）`;

/** 给她发出的文件签发下载句柄（绑定所在的会话）：存储地址与文件名 → 句柄；不签发的回 undefined */
export type SignFile = (uri: string, name: string) => string | undefined;

/** 归并一个会话的存档要的东西 */
export interface MergeContext {
  isOwner: IsOwner;
  /** 是房间的存档 */
  room: boolean;
  signFile: SignFile;
  /** 工具卡的展示 */
  display: DisplayOf;
}

type Attachment = { kind: ArchivedAttachment['kind']; src?: string; name?: string };

const OUTBOUND_KINDS: Readonly<Record<string, Attachment['kind']>> = {
  [WellKnownKinds.OutboundImage]: 'image',
  [WellKnownKinds.OutboundVideo]: 'video',
  [WellKnownKinds.OutboundAudio]: 'audio',
  [WellKnownKinds.OutboundFile]: 'file',
};

const ATTACHMENT_KINDS: ReadonlySet<string> = new Set(Object.values(OUTBOUND_KINDS));

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 她发出的附件归档成 outbound-* 的 assistant 消息，正文是附件引用占位符；认不出引用的按普通回复，回 undefined */
function sentRefs(message: Message) {
  const kind = message.kind ? OUTBOUND_KINDS[message.kind] : undefined;
  if (message.role !== 'assistant' || !kind) return undefined;
  const refs = parseAttachmentRefs(message.content ?? '');
  return refs.length > 0 ? { kind, refs } : undefined;
}

/**
 * 一个附件还原成条目里的附件：图片、音频、视频的来源就是地址（存储地址或网址）；文件不给存储地址，有地址时给句柄，
 * 名字没有时取地址的最后一段
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
  return { kind, name: fileName, src: signFile(ref, fileName) };
}

/**
 * 她发出的附件还原成条目里的附件。文件的地址与名字先取存档时元数据里原样记下的（占位符里的地址遇到「]」会截断，
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

/**
 * 单独成条的存档消息：提问、通知（含压缩分隔线）、她发出的附件。她的回复与工具调用要成组归并，
 * 其余系统消息与组外的工具结果不显示，都回 undefined
 */
export function archivedItem(message: Message, isOwner: IsOwner, signFile: SignFile): SessionItem | undefined {
  const itemId = archivedItemId(message);
  const at = message.timestamp ?? 0;
  if (message.role === 'user') {
    const spoken = message.metadata?.[WellKnownMetadataKeys.SpokenContent];
    return {
      kind: 'user-message',
      itemId,
      at,
      text: typeof spoken === 'string' ? spoken : (message.content ?? ''),
      attachments: askedAttachments(message.metadata?.[WellKnownMetadataKeys.Attachments], signFile),
      speaker: speakerOf(message, isOwner),
    };
  }
  if (message.role === 'notice' || (message.role === 'system' && message.kind === WellKnownKinds.EventMarker)) {
    return {
      kind: 'notice',
      itemId,
      at,
      topic: text(message.metadata?.[WellKnownMetadataKeys.HostNoticeKind]) ?? message.kind ?? message.role,
      text: message.content ?? '',
      attachments: [],
      noticeId: text(message.metadata?.[WellKnownMetadataKeys.HostNoticeId]),
      facts: noticeFacts(message.metadata?.[WellKnownMetadataKeys.HostNoticeFacts]),
    };
  }
  const sent = sentAttachments(message, signFile);
  return sent ? { kind: 'agent-message', itemId, at, text: '', attachments: sent } : undefined;
}

/** 成组的消息：她的回复（不是发出的附件）与带 toolCallId 的工具结果 */
const inGroup = (m: Message) => (m.role === 'assistant' && !sentRefs(m)) || (m.role === 'tool' && !!m.toolCallId);

const turnOf = (message: Message) => text(message.metadata?.[WellKnownMetadataKeys.TurnId]);

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
function mergeGroup(group: Message[], context: MergeContext, failures: ReadonlyMap<string, string>): SessionItem[] {
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
 * 适配器记下的投递失败里，一轮回复没发出的：回合 id → 未发出的原因。经工具发出的（带 callId）不算，
 * 那次调用的结果已写明；没记回合或原因的旧记录不认
 */
function replyFailures(raw: readonly Message[]): Map<string, string> {
  const failures = new Map<string, string>();
  for (const message of raw) {
    if (message.kind !== WellKnownKinds.OutboundDeliveryFailed) continue;
    if (message.metadata?.[WellKnownMetadataKeys.CallId] !== undefined) continue;
    const turnId = turnOf(message);
    const error = text(message.metadata?.[WellKnownMetadataKeys.DeliveryError]);
    if (turnId && error) failures.set(turnId, notAccepted(error));
  }
  return failures;
}

/** 一段存档消息归并成条目，顺序同存档；failures 见 replyFailures */
export function mergeArchive(
  raw: readonly Message[],
  context: MergeContext,
  failures: ReadonlyMap<string, string>,
): SessionItem[] {
  const items: SessionItem[] = [];
  for (let i = 0; i < raw.length; ) {
    const message = raw[i] as Message;
    if (message.role === 'assistant' && inGroup(message)) {
      let end = i + 1;
      while (end < raw.length && sameGroup(raw[end - 1] as Message, raw[end] as Message)) end++;
      items.push(...mergeGroup(raw.slice(i, end), context, failures));
      i = end;
      continue;
    }
    const item = archivedItem(message, context.isOwner, context.signFile);
    if (item) items.push(item);
    i++;
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
 * 读一页历史：before 是上一页第一条存档消息的 id，缺省从最新的读起；取 limit 条归并。页的开头落在一组回复与工具调用
 * 中间时往前扩到这一组的开头，免得一组拆在两页。skip 挑出不进历史的消息（在途回合落了库的那些），它们照样占位置，
 * 分页不受影响；字段不对的消息（{@link wellFormed}）不进历史，也不占位置，读到了就记一条 warn。before 指向的消息
 * 已不在存档里（被回滚删掉）时回 not-found。
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
  for (let want = page.limit + 1; ; want *= 2) {
    const stored = await read(want);
    const exhausted = stored.length < want;
    const raw = stored.filter(wellFormed);
    const end = page.before === undefined ? raw.length : raw.findIndex(m => archivedItemId(m) === page.before);
    if (end < 0) {
      if (exhausted) throw failure('not-found', `历史游标已失效：${page.before}`);
      continue;
    }
    let start = Math.max(0, end - page.limit);
    while (start > 0 && sameGroup(raw[start - 1] as Message, raw[start] as Message)) start--;
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
