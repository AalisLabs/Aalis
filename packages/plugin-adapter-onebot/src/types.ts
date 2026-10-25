/** OneBot 连接配置 */
export interface OneBotConnectionConfig {
  /** WebSocket 地址 (如 ws://127.0.0.1:8080) */
  url: string;
  /** 鉴权 token (可选) */
  accessToken?: string;
  /** 机器人自身 ID (可选，连接后自动获取) */
  selfId?: string;
  /** 协议版本: 'v11' | 'v12' | 'auto' */
  protocol?: 'v11' | 'v12' | 'auto';
}

/** OneBot 事件（兼容 v11 & v12 的原始格式） */
export interface OneBotRawEvent {
  id?: string;
  time: number;
  /** v12: 'meta' | 'message' | 'notice' | 'request' */
  type?: string;
  /** v11: 'message' | 'notice' | 'request' | 'meta_event' */
  post_type?: string;
  /** v12 */
  detail_type?: string;
  /** v11 */
  message_type?: string;
  meta_event_type?: string;
  sub_type?: string;
  self?: { platform?: string; user_id: string };
  self_id?: number | string;
  [key: string]: unknown;
}

/** 标准化后的消息事件 */
export interface NormalizedMessageEvent {
  selfId: string;
  detailType: string; // 'private' | 'group' | 'channel'
  text: string;
  messageId?: string;
  userId?: string;
  /** 用户昵称 */
  nickname?: string;
  groupId?: string;
  guildId?: string;
  channelId?: string;
  message: OneBotMessageSegment[];
  /** 统一附件列表（image/record/video/file 等） */
  attachments?: Array<{
    kind: 'image' | 'audio' | 'video' | 'file';
    /** 来源（见 {@link segmentSource}），没有可用来源的为空串 */
    url: string;
    mimeType?: string;
    name?: string;
    /** 来源的消息段：落盘后按段把引用写回正文的这个位置 */
    segment: OneBotMessageSegment;
  }>;
  /** 引用回复的原消息 ID */
  replyToMessageId?: string;
  /** 群消息：发送者在群内的角色（owner/admin/member），从 sender.role 提取 */
  senderRole?: 'owner' | 'admin' | 'member';
  /** 群消息：发送者的专属头衔，从 sender.title 提取 */
  senderTitle?: string;
}

/** 标准化后的通知事件 */
export interface NormalizedNoticeEvent {
  selfId: string;
  /** 通知类型: poke, group_upload, group_increase, group_decrease, group_admin, group_recall 等 */
  noticeType: string;
  subType?: string;
  userId?: string;
  targetId?: string;
  groupId?: string;
  /** 附加数据（如上传文件的信息等） */
  data?: Record<string, unknown>;
}

interface NormalizedBaseRequestEvent {
  selfId: string;
  /** 发起请求的用户 ID */
  userId: string;
  /** 验证信息 */
  comment?: string;
  /** 请求 flag，调用处理 API 时必须传回 */
  flag: string;
}

/** 标准化后的请求事件（加好友 / 加群 / 邀请入群） */
export type NormalizedRequestEvent =
  | (NormalizedBaseRequestEvent & { requestType: 'friend' })
  | (NormalizedBaseRequestEvent & {
      requestType: 'group';
      /** 子类型: 'add' = 用户申请加群, 'invite' = 被邀请入群 */
      subType: 'add' | 'invite';
      /** 群 ID */
      groupId: string;
    });

/** 标准化后的元事件 */
export interface NormalizedMetaEvent {
  subType: string;
  selfId?: string;
  /** 实现端版本信息 (v12) */
  version?: { impl?: string; version?: string; onebot_version?: string };
}

/** OneBot 消息段 */
export interface OneBotMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

/** OneBot Action 响应 */
export interface OneBotActionResponse {
  status: 'ok' | 'failed';
  retcode: number;
  data: unknown;
  message?: string;
  echo?: string;
}

/** 协议层解析出的机器人自身账号信息 */
export interface OneBotSelfInfo {
  userId?: string;
  nickname?: string;
}

/** 发送消息参数 (标准化) */
export interface SendMessageParams {
  detailType: string;
  targetId: string;
  /** 要发的消息段，引用段在内 */
  segments: ParsedSegment[];
}

/** 协议处理器接口 */
export interface OneBotProtocol {
  readonly version: 'v11' | 'v12';

  /** 实现端回「不支持该动作」时的返回码：只有这个码算不支持，适配器据此给失败标 unsupported，别处不认数字 */
  readonly unsupportedRetcode: number;

  /** 构造发送消息的 action 名称和 params */
  buildSendMessage(params: SendMessageParams): { action: string; params: Record<string, unknown> };

  /** 获取自身信息的 action 名称 */
  getSelfInfoAction(): string;

  /** 解析自身信息响应 */
  parseSelfInfo(data: unknown): OneBotSelfInfo;

  /** 解析原始事件类型 */
  parseEventType(raw: OneBotRawEvent): 'message' | 'meta' | 'notice' | 'request' | 'other';

  /** 解析消息事件为标准化格式 */
  parseMessageEvent(
    raw: OneBotRawEvent,
    fallbackSelfId: string,
    nicknameMap?: Map<string, string>,
  ): NormalizedMessageEvent | null;

  /** 解析元事件为标准化格式 */
  parseMetaEvent(raw: OneBotRawEvent): NormalizedMetaEvent;

  /** 解析通知事件为标准化格式 */
  parseNoticeEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedNoticeEvent | null;

  /** 解析请求事件为标准化格式 */
  parseRequestEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedRequestEvent | null;
}

/**
 * 能拼成标记的起始字符与它的全角替身：at 与转发标记开头的 `<`，附件引用里 `| ref:` 的 `|`（与 formatAttachmentRef
 * 净化描述同一个换法）
 */
const MARKUP_STARTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<(?=(?:at|forward)[\s>])/g, '＜'],
  [/\|(?= ref:)/g, '丨'],
];

/**
 * 用户写的字（文字段、昵称、分享标题，通知里的文件名与验证信息）写进正文前过这张表：读的一方（@ 判定、存档的 Mentions、附件
 * 引用、转发信封的替换）只认适配器按消息段写下的标记，手打的因此不算标记。只换起始字符，其余照原样
 */
export function escapeMarkup(text: string): string {
  return MARKUP_STARTS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** 逐段渲染出的一段：适配器写下的照原样，文字段里用户写的字记成 { user }，由 {@link joinRendered} 连成串再转义 */
export type RenderedPart = string | { user: string };

/**
 * 拼出正文：相邻的用户文字（中间只隔着渲染成空串的段时也算相邻）先连成一串再过 escapeMarkup。按单段转义的话，分在两个文字段里
 * 的半个标记各自看不出来，拼起来就是真标记
 */
export function joinRendered(parts: RenderedPart[]): string {
  let out = '';
  let run = '';
  for (const part of parts) {
    if (typeof part !== 'string') run += part.user;
    else if (part) {
      out += escapeMarkup(run) + part;
      run = '';
    }
  }
  return out + escapeMarkup(run);
}

/**
 * 将 OneBot 消息段数组转换为富文本（含 XML 标记），供 LLM 消费。
 * @param segments 消息段数组
 * @param selfId 机器人自身 ID，用于标记 <at self>
 * @param nicknameMap 可选的 userId→昵称 映射，用于丰富 <at> 标签
 * @param media 图片、语音、视频与文件段写什么：给了就写给的（如落盘后带存储地址的引用），没给写占位
 */
export function segmentsToText(
  segments: OneBotMessageSegment[],
  selfId?: string,
  nicknameMap?: Map<string, string>,
  media?: (seg: OneBotMessageSegment) => string | undefined,
): string {
  return joinRendered(
    segments.map((seg): RenderedPart => {
      switch (seg.type) {
        case 'text':
          return { user: String(seg.data.text ?? '') };
        case 'at': {
          const qq = String(seg.data.qq ?? '');
          if (qq === 'all') return '<at>all</at>';
          const nick = escapeMarkup(nicknameMap?.get(qq) ?? qq);
          const selfAttr = selfId && qq === selfId ? ' self' : '';
          return `<at${selfAttr} id="${qq}">${nick}</at>`;
        }
        case 'mention': {
          const uid = String(seg.data.user_id ?? '');
          const nick = escapeMarkup(nicknameMap?.get(uid) ?? uid);
          const selfAttr = selfId && uid === selfId ? ' self' : '';
          return `<at${selfAttr} id="${uid}">${nick}</at>`;
        }
        case 'mention_all':
          return '<at>all</at>';
        case 'face':
          return `[表情:${seg.data.id ?? ''}]`;
        case 'image':
          return media?.(seg) ?? '[图片]';
        case 'reply':
          return ''; // 回复引用是元数据，不作为内联内容
        case 'forward': {
          const id = seg.data.id != null ? String(seg.data.id) : '';
          return id ? `<forward id="${id}">[合并转发消息]</forward>` : '[合并转发消息]';
        }
        case 'record':
        case 'voice':
        case 'audio':
          return media?.(seg) ?? '[语音]';
        case 'video':
          return media?.(seg) ?? '[视频]';
        case 'file':
          return media?.(seg) ?? '[文件]';
        case 'share':
          return `[分享: ${escapeMarkup(String(seg.data.title ?? ''))}]`;
        case 'json':
          return '[JSON卡片]';
        case 'xml':
          return '[XML卡片]';
        case 'poke':
          return '[戳一戳]';
        default:
          // 未识别段类型：保留类型名避免整条消息文本为空被静默丢弃
          return seg.type ? `[未知段:${seg.type}]` : '';
      }
    }),
  );
}

/** 网址，或 base64 的 data URL：`data:` 后面紧跟 MIME 类型（`data:/` 开头的是存储地址，带着「;base64,」也不算） */
const SEGMENT_SOURCE = /^(?:https?:\/\/|data:[\w.+-]+\/[\w.+-]+(?:;[^;,]*)*;base64,)/i;

/**
 * 消息段里能当来源读的地址：网址与 base64 的 data URL（{@link SEGMENT_SOURCE}），别的（本机路径、file://、存储地址）一律为空串。
 * file 字段是文件名或实现端的文件 id，只当名字、只交给 get_record 这类动作换地址：群友能给文件起名，按它读就是让她读本机的
 * 文件或 Aalis 的存储。没有可用来源的附件照留，由下游写取不到
 */
export function segmentSource(value: unknown): string {
  return typeof value === 'string' && SEGMENT_SOURCE.test(value) ? value : '';
}

/** 入群邀请卡片的应用名（群分享卡片是 com.tencent.troopsharecard，不算） */
const GROUP_INVITE_CARD_APP = 'com.tencent.qun.invite';

/**
 * 消息是不是一张入群邀请卡片：只有一个 json 段，卡片的 app 是 {@link GROUP_INVITE_CARD_APP}。邀请人在私聊里发来的这张卡片与
 * 入群邀请事件（request/group/invite）是同一件事，交给模型的是事件合成的系统通知；json 段只渲染成「[JSON卡片]」，丢掉它不丢内容
 */
export function isGroupInviteCard(segments: OneBotMessageSegment[]): boolean {
  if (segments.length !== 1 || segments[0].type !== 'json') return false;
  const card = segments[0].data.data;
  if (typeof card !== 'string') return false;
  try {
    return (JSON.parse(card) as { app?: unknown } | null)?.app === GROUP_INVITE_CARD_APP;
  } catch {
    return false;
  }
}

/**
 * CQ 转义还原（纯文本三项；参数值另含 `&#44;`，见 {@link parseCqParams}）。
 *
 * 顺序固定为 `&#91;` → `&#93;` → `&amp;`：`&amp;` 必须最后还原。否则原文里的字面量
 * `&amp;#91;`（发送方想表达的就是六个字符 `&#91;`）会先被还原成 `&#91;`，再被当成方括号
 * 转义还原成 `[`，凭空变出一个段边界字符。
 */
function unescapeCqText(s: string): string {
  return s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
}

/**
 * 解析 CQ 段参数体（`,k=v,k=v`），含 CQ 转义还原。
 *
 * 参数值沿用历史还原顺序（`&amp;` 先于方括号与 `&#44;`），不跟随 {@link unescapeCqText} 调整：
 * 参数体是先按字面 `,` 切分、后还原的，逗号转义本就只能近似处理，改顺序解决不了这一层，
 * 只会动到既有实现端上游已验过的参数解析结果。
 */
export function parseCqParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of body.replace(/^,/, '').split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    params[part.slice(0, eq)] = part
      .slice(eq + 1)
      .replace(/&amp;/g, '&')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&#44;/g, ',');
  }
  return params;
}

/**
 * 把字符串消息格式（`message` 为含 `[CQ:…]` 码的字符串）规范化为消息段数组。
 *
 * OneBot 实现端可把上报配成 `message_format=string`。入站在此统一成段数组，之后
 * 附件提取、回复提取、`segmentsToText()`（`<at self>` 标记与 selfId 判定）都只有
 * 数组这一条路径——CQ 码不会流到下游文本里。
 *
 * 段类型名与 data 键沿用 v11 段语义（`at.qq` / `image.url|file` / `face.id` /
 * `reply.id` 等），参数原样透传不重命名；未知 CQ 类型也照原样成段，由
 * `segmentsToText()` 的兜底分支渲染。
 */
export function parseCqMessageToSegments(raw: string): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];
  const pushText = (text: string): void => {
    if (text) segments.push({ type: 'text', data: { text: unescapeCqText(text) } });
  };
  const regex = /\[CQ:([A-Za-z_][A-Za-z0-9_-]*)((?:,[^\]]*)?)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(raw);
  while (match !== null) {
    pushText(raw.slice(lastIndex, match.index));
    segments.push({ type: match[1], data: parseCqParams(match[2] ?? '') });
    lastIndex = match.index + match[0].length;
    match = regex.exec(raw);
  }
  pushText(raw.slice(lastIndex));
  return segments;
}

/**
 * 把一份 OneBot 消息载荷规范化成消息段数组：`message` 可以是段数组、也可以是含 `[CQ:…]` 码的
 * 字符串（实现端 `message_format=string`）；两者都拿不到内容时回退到 `raw_message` 原文——
 * 它同样是 CQ 字符串，因此一并规范化。
 *
 * 入站事件（v11 `parseMessageEvent`）与 `get_msg` 回包（引用消息反查）共用这一条路径：
 * 附件提取、回复提取、`segmentsToText()`（`<at self>` 标记与 selfId 判定）之后都只面对段数组，
 * CQ 码不会流到下游文本里。
 */
export function normalizeOneBotMessage(message: unknown, rawMessage?: unknown): OneBotMessageSegment[] {
  const segments = Array.isArray(message)
    ? (message as OneBotMessageSegment[])
    : typeof message === 'string'
      ? parseCqMessageToSegments(message)
      : [];
  if (segments.length > 0) return segments;
  return typeof rawMessage === 'string' ? parseCqMessageToSegments(rawMessage) : [];
}

/** 抽象消息段（协议无关） */
export interface ParsedSegment {
  type: 'text' | 'at' | 'image' | 'audio' | 'reply' | 'video';
  data: Record<string, unknown>;
}

// ===== 合并转发（forward）解析与格式化 =====

/**
 * 从 get_forward_msg 返回的 data 或一个 forward 消息段的 data 中
 * 提取出节点数组。各家实现字段不一：messages / message / content。
 */
export function getForwardNodes(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.messages)) return obj.messages;
  if (Array.isArray(obj.message)) return obj.message;
  if (Array.isArray(obj.content)) return obj.content;
  return [];
}

/** 扫描消息段中的所有 forward 段，返回 {id, inlineNodes?} 列表 */
export function collectForwardSegments(segments: OneBotMessageSegment[]): Array<{
  id: string;
  inlineNodes?: unknown[];
}> {
  const out: Array<{ id: string; inlineNodes?: unknown[] }> = [];
  for (const seg of segments) {
    if (seg.type !== 'forward') continue;
    const data = seg.data ?? {};
    const id = data.id != null ? String(data.id) : '';
    if (!id) continue;
    const inline = getForwardNodes(data);
    out.push({ id, inlineNodes: inline.length > 0 ? inline : undefined });
  }
  return out;
}

/** 媒体标记的标签对应的消息段类型 */
const MARKER_KINDS: Record<string, 'image' | 'audio' | 'video'> = {
  image: 'image',
  record: 'audio',
  video: 'video',
};

/**
 * 解析内容字符串中的 XML 标记，拆分为抽象消息段列表。
 *
 * 支持的标记：
 * - `<at id="QQ">昵称</at>` / `<at self id="QQ">昵称</at>` → @提及（新格式）
 * - `<at>QQ</at>` / `<at self>QQ</at>` → @提及（旧格式/无昵称兼容）
 * - `<face …/>` → 丢弃（不产出消息段）
 * - `<image url="..."/>` → 图片
 * - `<record url="..."/>` → 语音
 * - `<video url="..."/>` → 视频
 * - `<reply id="..."/>` → 引用回复
 */
export function parseContentToSegments(content: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  // 匹配新旧两种 at 格式 + face/reply + 媒体标记
  const regex =
    /<at(?:\s+self)?(?:\s+id=["']([^"']*)["'])?\s*>([^<]*)<\/at>|<face\s+id=["']([^"']*)["']\s*\/>|<reply\s+id=["']([^"']*)["']\s*\/>|<(image|record|video)\s+url=["']([^"']*)["']\s*\/>/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(content);
  while (match !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index);
      if (text) segments.push({ type: 'text', data: { text } });
    }
    if (match[1] !== undefined || match[2] !== undefined) {
      // at 标签：优先用 id 属性（新格式），回退到标签内容（旧格式/纯ID）
      const id = (match[1] ?? match[2]).trim();
      segments.push({ type: 'at', data: { id } });
    } else if (match[3] !== undefined) {
      // face 标签：忽略，不转为消息段（防止 LLM 误发 QQ 表情，也兼容v12版本）
    } else if (match[4] !== undefined) {
      segments.push({ type: 'reply', data: { id: match[4] } });
    } else if (match[5] !== undefined) {
      segments.push({ type: MARKER_KINDS[match[5]], data: { url: match[6] } });
    }
    lastIndex = match.index + match[0].length;
    match = regex.exec(content);
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex);
    if (text) segments.push({ type: 'text', data: { text } });
  }

  return segments.length > 0 ? segments : [{ type: 'text', data: { text: content } }];
}

/** 出站正文切出的一条：原文（记发出记录、算分条延迟用）与解析出的消息段 */
export interface OutgoingPiece {
  text: string;
  segments: ParsedSegment[];
}

/** 有 replyTo 时在最前加引用段；段里已有引用（模型自己写的引用标记）的，以它为准，不加第二个 */
export function withReply(segments: ParsedSegment[], replyTo: string | undefined): ParsedSegment[] {
  if (replyTo === undefined || segments.some(seg => seg.type === 'reply')) return segments;
  return [{ type: 'reply', data: { id: replyTo } }, ...segments];
}

/** 将抽象消息段转为 OneBot v11 格式 */
export function toV11Segments(segments: ParsedSegment[]): OneBotMessageSegment[] {
  const result: OneBotMessageSegment[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        result.push({ type: 'text', data: { text: seg.data.text } });
        break;
      case 'at':
        result.push({ type: 'at', data: { qq: seg.data.id === 'all' ? 'all' : Number(seg.data.id) || seg.data.id } });
        break;
      case 'image':
        result.push({ type: 'image', data: { file: seg.data.url } });
        break;
      case 'audio':
        result.push({ type: 'record', data: { file: seg.data.url } });
        break;
      case 'video':
        result.push({ type: 'video', data: { file: seg.data.url } });
        break;
      case 'reply':
        result.push({ type: 'reply', data: { id: Number(seg.data.id) || seg.data.id } });
        break;
    }
  }
  return result;
}

/** 将抽象消息段转为 OneBot v12 格式 */
export function toV12Segments(segments: ParsedSegment[]): OneBotMessageSegment[] {
  const result: OneBotMessageSegment[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        result.push({ type: 'text', data: { text: seg.data.text } });
        break;
      case 'at':
        if (seg.data.id === 'all') {
          result.push({ type: 'mention_all', data: {} });
        } else {
          result.push({ type: 'mention', data: { user_id: String(seg.data.id) } });
        }
        break;
      case 'image':
        result.push({ type: 'image', data: { file_id: String(seg.data.url) } });
        break;
      case 'audio':
        result.push({ type: 'voice', data: { file_id: String(seg.data.url) } });
        break;
      case 'video':
        result.push({ type: 'video', data: { file_id: String(seg.data.url) } });
        break;
      case 'reply':
        result.push({ type: 'reply', data: { message_id: String(seg.data.id) } });
        break;
    }
  }
  return result;
}
