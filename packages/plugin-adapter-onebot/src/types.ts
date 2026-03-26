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
  /** 图片 URL 列表（从 image 段提取） */
  images?: string[];
  /** 引用回复的原消息 ID */
  replyToMessageId?: string;
}

/** 标准化后的通知事件 */
export interface NormalizedNoticeEvent {
  selfId: string;
  /** 通知类型: poke, group_upload, group_increase, group_decrease, group_admin, group_recall 等 */
  noticeType: string;
  subType?: string;
  userId?: string;
  nickname?: string;
  targetId?: string;
  groupId?: string;
  /** 附加数据（如上传文件的信息等） */
  data?: Record<string, unknown>;
}

/** 标准化后的元事件 */
export interface NormalizedMetaEvent {
  subType: string;
  selfId?: string;
  /** 实现端版本信息 (v12) */
  version?: { impl?: string; version?: string; onebot_version?: string };
  /** 心跳间隔 */
  interval?: number;
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

/** 发送消息参数 (标准化) */
export interface SendMessageParams {
  detailType: string;
  targetId: string;
  content: string;
}

/** 协议处理器接口 */
export interface OneBotProtocol {
  readonly version: 'v11' | 'v12';

  /** 构造发送消息的 action 名称和 params */
  buildSendMessage(params: SendMessageParams): { action: string; params: Record<string, unknown> };

  /** 获取自身信息的 action 名称 */
  getSelfInfoAction(): string;

  /** 解析自身信息响应 */
  parseSelfInfo(data: unknown): string | undefined;

  /** 解析原始事件类型: 'message' | 'meta' | 'notice' | 'other' */
  parseEventType(raw: OneBotRawEvent): 'message' | 'meta' | 'notice' | 'other';

  /** 解析消息事件为标准化格式 */
  parseMessageEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedMessageEvent | null;

  /** 解析元事件为标准化格式 */
  parseMetaEvent(raw: OneBotRawEvent): NormalizedMetaEvent;

  /** 解析通知事件为标准化格式 */
  parseNoticeEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedNoticeEvent | null;
}

/** 从 OneBot 消息段数组中提取纯文本 */
export function extractText(segments: OneBotMessageSegment[]): string {
  return segments
    .filter(seg => seg.type === 'text')
    .map(seg => String(seg.data.text ?? ''))
    .join('');
}

/**
 * 将 OneBot 消息段数组转换为富文本（含 XML 标记），供 LLM 消费。
 * @param segments 消息段数组
 * @param selfId 机器人自身 ID，用于标记 <at self>
 */
export function segmentsToText(segments: OneBotMessageSegment[], selfId?: string): string {
  return segments.map(seg => {
    switch (seg.type) {
      case 'text':
        return String(seg.data.text ?? '');
      case 'at': {
        const qq = String(seg.data.qq ?? '');
        if (qq === 'all') return '<at>all</at>';
        return (selfId && qq === selfId) ? `<at self>${qq}</at>` : `<at>${qq}</at>`;
      }
      case 'mention': {
        const uid = String(seg.data.user_id ?? '');
        return (selfId && uid === selfId) ? `<at self>${uid}</at>` : `<at>${uid}</at>`;
      }
      case 'mention_all':
        return '<at>all</at>';
      case 'face':
        return `[表情:${seg.data.id ?? ''}]`;
      case 'image':
        return '[图片]';
      case 'reply':
        return ''; // 回复引用是元数据，不作为内联内容
      case 'forward':
        return '[转发消息]';
      case 'record':
        return '[语音]';
      case 'video':
        return '[视频]';
      case 'share':
        return `[分享: ${seg.data.title ?? ''}]`;
      case 'json':
        return '[JSON卡片]';
      case 'xml':
        return '[XML卡片]';
      case 'poke':
        return '[戳一戳]';
      default:
        return '';
    }
  }).join('');
}

/** 抽象消息段（协议无关） */
export interface ParsedSegment {
  type: 'text' | 'at' | 'face' | 'image' | 'reply';
  data: Record<string, unknown>;
}

/**
 * 解析内容字符串中的 XML 标记，拆分为抽象消息段列表。
 *
 * 支持的标记：
 * - `<at>id</at>` / `<at self>id</at>` → @提及
 * - `<face id="N"/>` → QQ 表情
 * - `<image url="..."/>` → 图片
 * - `<reply id="..."/>` → 引用回复
 */
export function parseContentToSegments(content: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const regex = /<at(?:\s+self)?\s*>([^<]*)<\/at>|<face\s+id=["']([^"']*)["']\s*\/>|<image\s+url=["']([^"']*)["']\s*\/>|<reply\s+id=["']([^"']*)["']\s*\/>/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index);
      if (text) segments.push({ type: 'text', data: { text } });
    }
    if (match[1] !== undefined) {
      segments.push({ type: 'at', data: { id: match[1].trim() } });
    } else if (match[2] !== undefined) {
      segments.push({ type: 'face', data: { id: match[2] } });
    } else if (match[3] !== undefined) {
      segments.push({ type: 'image', data: { url: match[3] } });
    } else if (match[4] !== undefined) {
      segments.push({ type: 'reply', data: { id: match[4] } });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex);
    if (text) segments.push({ type: 'text', data: { text } });
  }

  return segments.length > 0 ? segments : [{ type: 'text', data: { text: content } }];
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
        result.push({ type: 'at', data: { qq: seg.data.id === 'all' ? 'all' : (Number(seg.data.id) || seg.data.id) } });
        break;
      case 'face':
        result.push({ type: 'face', data: { id: Number(seg.data.id) || 0 } });
        break;
      case 'image':
        result.push({ type: 'image', data: { file: seg.data.url } });
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
      case 'face':
        // v12 无标准 face 类型，降级为文本
        result.push({ type: 'text', data: { text: `[表情:${seg.data.id}]` } });
        break;
      case 'image':
        result.push({ type: 'image', data: { file_id: String(seg.data.url) } });
        break;
      case 'reply':
        result.push({ type: 'reply', data: { message_id: String(seg.data.id) } });
        break;
    }
  }
  return result;
}
