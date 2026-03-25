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
  groupId?: string;
  guildId?: string;
  channelId?: string;
  message: OneBotMessageSegment[];
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

  /** 解析原始事件类型: 'message' | 'meta' | 'other' */
  parseEventType(raw: OneBotRawEvent): 'message' | 'meta' | 'other';

  /** 解析消息事件为标准化格式 */
  parseMessageEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedMessageEvent | null;

  /** 解析元事件为标准化格式 */
  parseMetaEvent(raw: OneBotRawEvent): NormalizedMetaEvent;
}

/** 从 OneBot 消息段数组中提取纯文本 */
export function extractText(segments: OneBotMessageSegment[]): string {
  return segments
    .filter(seg => seg.type === 'text')
    .map(seg => String(seg.data.text ?? ''))
    .join('');
}
