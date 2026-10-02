// ════════════════════════════════════════════════════════════
// 历史：存档里的消息归并成会话条目，以及分页。
//
// 她一轮的输出在存档里有两种格式：新格式是最后一条带时间线（segments）的回复，覆盖这一轮之前按旧格式落库的工具调用组；
// 旧格式是分条的 assistant（带 toolCalls）与 tool 结果。同一轮里相邻的 assistant 与 tool 消息成一组，两种格式都归并成
// 按时间顺序的思考、正文与工具调用条目；每次模型调用说的话各成一条（重试的各版不连在一起）。提问、通知与她发出的附件
// 各自单独成条。工具卡的审批结算与「已发到群」取自工具结果的元数据（会话服务在结果落库前写上）。
// 房间里她只把最后的回复发进群：工具调用之前说的话、重试丢掉的几版标「未发出」，平台没收下的回复按适配器记的投递失败
// 标出，与实时推送一致。
// ════════════════════════════════════════════════════════════

import type { MemoryService } from '@aalis/api-memory';
import { ApprovalSettlementSchema, type SessionItem } from '@aalis/api-session-protocol';
import { type ContentSegment, type Message, parseAttachmentRefs, WellKnownKinds } from '@aalis/schema-message';
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

type Attachment = { kind: 'image' | 'audio' | 'video' | 'file'; src?: string; name?: string };

const OUTBOUND_KINDS: Readonly<Record<string, Attachment['kind']>> = {
  [WellKnownKinds.OutboundImage]: 'image',
  [WellKnownKinds.OutboundVideo]: 'video',
  [WellKnownKinds.OutboundAudio]: 'audio',
  [WellKnownKinds.OutboundFile]: 'file',
};

/** 她发出的附件归档成 outbound-* 的 assistant 消息，正文是附件引用占位符；认不出引用的按普通回复，回 undefined */
function sentRefs(message: Message) {
  const kind = message.kind ? OUTBOUND_KINDS[message.kind] : undefined;
  if (message.role !== 'assistant' || !kind) return undefined;
  const refs = parseAttachmentRefs(message.content ?? '');
  return refs.length > 0 ? { kind, refs } : undefined;
}

/**
 * 她发出的附件还原成条目里的附件：图片、音频、视频的来源就是引用（存储地址或网址）；文件不给存储地址，给句柄。
 * 文件的地址与名字先取存档时 metadata 里原样记下的 ref、name（占位符里的地址遇到「]」会截断，描述位的「]」「|」
 * 换成了全角），没有时取占位符的引用与描述位，名字再没有就取地址的最后一段
 */
function sentAttachments(message: Message, signFile: SignFile): Attachment[] | undefined {
  const sent = sentRefs(message);
  return sent?.refs.map(({ ref: parsed, desc }) => {
    if (sent.kind !== 'file') return { kind: sent.kind, src: parsed };
    const ref = text(message.metadata?.ref) ?? parsed;
    const name = text(message.metadata?.name) ?? desc ?? ref.slice(ref.lastIndexOf('/') + 1);
    return { kind: 'file', name, src: signFile(ref, name) };
  });
}

/**
 * 从提问里剥掉文件内容块，留下用户自己写的话。文件读取插件把文件描述追加在提问后面，格式有这些：
 *   [文件: name (ID: id)]\n--- 文件内容 ---（…「--- 文件内容结束 N ---」…）\nTEXT\n--- 文件内容结束 N ---   小文件内联，N 是随机编号
 *   [文件: name (ID: id)]\n--- 文件内容 ---\nTEXT\n--- 文件内容结束 ---                                       小文件内联，较早的归档
 *   [文件: name]\n--- 文件内容 ---\nTEXT\n--- 文件内容结束 ---                                                 小文件内联，最早的归档
 *   [文件: name (ID: id，SIZE KB)\n说明：...]                                                                  大文件引用
 *   [文件: name (ID: id，大文件，使用 read_uploaded_file 工具读取内容)]                                          大文件引用，最早的单行格式
 *   [文件: name - 超过大小限制 (…MB > …MB)] / [文件: name - 处理失败]                                            超限 / 处理失败
 *   [文件: name (ID: id)]                                                                                    降级
 * 名字可以含任意非换行字符，前四步靠名字之后固定的收尾定界，第五步兜底其余形态。
 */
function stripFileBlocks(content: string): string {
  // 内联块：新格式按开头那行的随机编号认行首的结束标记，正文里伪造的结束标记属于正文
  let result = content.replace(
    /\n?\[文件: [^\n]+? \(ID: [0-9a-f]+\)\]\n--- 文件内容 ---[^\n]*?「--- 文件内容结束 ([0-9a-f]+) ---」[^\n]*\n[\s\S]*?\n--- 文件内容结束 \1 ---/g,
    '',
  );
  // 没有编号的旧格式：开头那行紧跟换行，文件头不要求带 ID，定界靠固定的「]\n--- 文件内容 ---\n」
  result = result.replace(/\n?\[文件: [^\n]+?\]\n--- 文件内容 ---\n[\s\S]*?--- 文件内容结束 ---/g, '');
  // 大文件引用：首行以「 (ID: <hex>，<SIZE> KB)」收尾，次行「说明：…]」
  result = result.replace(/\n?\[文件: [^\n]+? \(ID: [0-9a-f]+，[0-9.]+ KB\)\n说明：[^\n]*\]/g, '');
  // 超限与处理失败
  result = result.replace(/\n?\[文件: [^\n]+? - (?:超过大小限制 \([0-9.]+MB > [0-9.]+MB\)|处理失败)\]/g, '');
  // 降级引用与最早的单行大文件引用（最早的 ID 形如 file_xxx_1，不是 hex）
  result = result.replace(/\n?\[文件: [^\n]+? \(ID: \w+(?:，大文件，使用 read_uploaded_file 工具读取内容)?\)\]/g, '');
  // 兜底：其余形态的简单文件引用（名字不含「]」）
  result = result.replace(/\n?\[文件: ([^\]]+?)\s*(?:\(ID:[^)]+\))?\]/g, '');
  return result.trim();
}

/**
 * 存档消息的条目 id：时间戳加内容摘要。实时推送从同一条存档消息算出同一个 id，快照里的历史与之后的推送重叠时按 id 合并。
 * 成组归并的条目在这一组第一条消息的 id 后面加序号
 */
function archivedItemId(message: Message): string {
  const key = [message.role, message.kind ?? '', String(message.metadata?.userId ?? ''), message.content ?? ''].join(
    '\u0000',
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${message.timestamp ?? 0}-${(hash >>> 0).toString(36)}`;
}

/** 工具结果是带 error 的 JSON 对象（工具与 agent 报失败的约定）即为失败 */
export function toolFailed(result: string): boolean {
  try {
    const parsed: unknown = JSON.parse(result);
    return typeof parsed === 'object' && parsed !== null && 'error' in parsed;
  } catch {
    return false;
  }
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

function speakerOf(message: Message, isOwner: IsOwner) {
  const meta = message.metadata ?? {};
  const platform = text(meta.platform) ?? '';
  const userId = text(meta.userId);
  return {
    platform,
    userId,
    nickname: text(meta.nickname),
    source: text(meta.source),
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
    const names = message.metadata?.fileNames;
    return {
      kind: 'user-message',
      itemId,
      at,
      text: stripFileBlocks(message.content ?? ''),
      attachments: Array.isArray(names)
        ? names
            .filter((name): name is string => typeof name === 'string' && name !== '')
            .map(name => ({ kind: 'file', name }))
        : [],
      speaker: speakerOf(message, isOwner),
    };
  }
  if (message.role === 'notice' || (message.role === 'system' && message.kind === WellKnownKinds.EventMarker)) {
    return {
      kind: 'notice',
      itemId,
      at,
      topic: text(message.metadata?.hostNoticeKind) ?? message.kind ?? message.role,
      text: message.content ?? '',
      attachments: [],
    };
  }
  const sent = sentAttachments(message, signFile);
  return sent ? { kind: 'agent-message', itemId, at, text: '', attachments: sent } : undefined;
}

/** 成组的消息：她的回复（不是发出的附件）与带 toolCallId 的工具结果 */
const inGroup = (m: Message) => (m.role === 'assistant' && !sentRefs(m)) || (m.role === 'tool' && !!m.toolCallId);

/** cur 接着 prev 在同一组：都是成组的消息，且属于同一轮（旧数据没记回合的不分） */
function sameGroup(prev: Message, cur: Message): boolean {
  if (!inGroup(prev) || !inGroup(cur)) return false;
  const [a, b] = [text(prev.metadata?.turnId), text(cur.metadata?.turnId)];
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
  let model: { provider?: string; model?: string } | undefined;
  for (const [k, cur] of group.entries()) {
    if (cur.role === 'tool') {
      const callId = text(cur.metadata?.callId);
      if (callId && cur.metadata) results.set(callId, cur.metadata);
      const call = calls.get(cur.toolCallId as string);
      if (call) {
        call.result = cur.content ?? '';
        call.callId = callId;
      }
      continue;
    }
    const info = cur.metadata?.modelInfo as { provider?: string; model?: string } | undefined;
    if (info) model = { provider: info.provider, model: info.model };
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 一组归并成条目。工具卡以 callId 为 id（与实时推送相同），旧存档没有 callId 时按这一组第一条消息的 id 加序号；
 * 参数不是对象的（旧存档里模型给出的 null、数组等）按空参数显示。房间里以回复收尾的一组，最后一次工具调用之后的最后一条
 * 是回复，failures 里有这一轮的就标平台没收下；其余她说的话标未发出
 */
function mergeGroup(group: Message[], context: MergeContext, failures: ReadonlyMap<string, string>): SessionItem[] {
  const { ordered, lastAt, model, results, replied } = groupTimeline(group);
  const base = archivedItemId(group[0] as Message);
  const turnId = group.map(m => text(m.metadata?.turnId)).find(id => id !== undefined);
  const items: SessionItem[] = [];
  const id = () => `${base}/${items.length}`;
  for (const segment of ordered) {
    const last = items.at(-1);
    if (segment.type === 'tool_call') {
      const { result, startTime, endTime, callId } = segment;
      const metadata = callId === undefined ? undefined : results.get(callId);
      const approval = recordedApproval(metadata);
      const failed = result === undefined || toolFailed(result);
      const args = isRecord(segment.args) ? segment.args : {};
      const display = context.display(segment.name, args);
      items.push({
        kind: 'tool-call',
        itemId: callId ?? id(),
        turnId,
        at: startTime ?? lastAt,
        name: segment.name,
        args,
        status: approval && approval.settlement.state !== 'approved' ? 'denied' : failed ? 'failed' : 'completed',
        result,
        durationMs: startTime !== undefined && endTime !== undefined ? endTime - startTime : undefined,
        ...(display ? { display } : {}),
        ...(metadata?.sentToRoom === true ? { sentToRoom: true } : {}),
        ...approval,
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
    if (message.kind !== WellKnownKinds.OutboundDeliveryFailed || message.metadata?.callId !== undefined) continue;
    const turnId = text(message.metadata?.turnId);
    const error = text(message.metadata?.error);
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

/**
 * 读一页历史：before 是上一页第一条存档消息的 id，缺省从最新的读起；取 limit 条归并。页的开头落在一组回复与工具调用
 * 中间时往前扩到这一组的开头，免得一组拆在两页。skip 挑出不进历史的消息（在途回合落了库的那些），它们照样占位置，
 * 分页不受影响。before 指向的消息已不在存档里（被回滚删掉）时回 not-found。
 */
export async function readHistory(
  memory: MemoryService,
  sessionId: string,
  page: { before?: string; limit: number; skip: (message: Message) => boolean },
  context: MergeContext,
): Promise<{ items: SessionItem[]; before?: string }> {
  const read = (n: number) =>
    memory.getFullHistory ? memory.getFullHistory(sessionId, n) : memory.getHistory(sessionId, n);
  for (let want = page.limit + 1; ; want *= 2) {
    const raw = await read(want);
    const exhausted = raw.length < want;
    const end = page.before === undefined ? raw.length : raw.findIndex(m => archivedItemId(m) === page.before);
    if (end < 0) {
      if (exhausted) throw failure('not-found', `历史游标已失效：${page.before}`);
      continue;
    }
    let start = Math.max(0, end - page.limit);
    while (start > 0 && sameGroup(raw[start - 1] as Message, raw[start] as Message)) start--;
    if (start === 0 && !exhausted) continue;
    // 回复的投递失败记在回复之后，可能落在更新的一页：从这一页的开头往后全看
    const items = mergeArchive(
      raw.slice(start, end).filter(m => !page.skip(m)),
      context,
      replyFailures(raw.slice(start)),
    );
    return start > 0 ? { items, before: archivedItemId(raw[start] as Message) } : { items };
  }
}
