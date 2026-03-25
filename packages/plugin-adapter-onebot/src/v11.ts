import type {
  OneBotProtocol,
  OneBotRawEvent,
  NormalizedMessageEvent,
  NormalizedMetaEvent,
  SendMessageParams,
} from './types.js';
import { extractText } from './types.js';

/**
 * OneBot v11 协议处理器
 *
 * v11 特点:
 * - 事件使用 post_type / message_type / meta_event_type
 * - ID 均为 number 类型
 * - 发送消息: send_msg / send_private_msg / send_group_msg
 * - 获取自身信息: get_login_info
 * - 获取版本: get_version_info
 */
export class OneBotV11 implements OneBotProtocol {
  readonly version = 'v11' as const;

  buildSendMessage(params: SendMessageParams): { action: string; params: Record<string, unknown> } {
    const actionParams: Record<string, unknown> = {
      message: [{ type: 'text', data: { text: params.content } }],
    };

    if (params.detailType === 'private') {
      return {
        action: 'send_private_msg',
        params: { ...actionParams, user_id: Number(params.targetId) || params.targetId },
      };
    } else if (params.detailType === 'group') {
      return {
        action: 'send_group_msg',
        params: { ...actionParams, group_id: Number(params.targetId) || params.targetId },
      };
    }

    // fallback: 使用 send_msg
    return {
      action: 'send_msg',
      params: {
        ...actionParams,
        message_type: params.detailType,
        user_id: params.detailType === 'private' ? (Number(params.targetId) || params.targetId) : undefined,
        group_id: params.detailType === 'group' ? (Number(params.targetId) || params.targetId) : undefined,
      },
    };
  }

  getSelfInfoAction(): string {
    return 'get_login_info';
  }

  parseSelfInfo(data: unknown): string | undefined {
    const info = data as { user_id?: number | string; nickname?: string };
    return info?.user_id != null ? String(info.user_id) : undefined;
  }

  parseEventType(raw: OneBotRawEvent): 'message' | 'meta' | 'other' {
    switch (raw.post_type) {
      case 'message': return 'message';
      case 'meta_event': return 'meta';
      default: return 'other';
    }
  }

  parseMessageEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedMessageEvent | null {
    const selfId = raw.self_id != null ? String(raw.self_id) : fallbackSelfId;
    const detailType = (raw.message_type ?? 'private') as string;
    const message = Array.isArray(raw.message) ? raw.message : [];
    const text = (raw.raw_message as string) ?? extractText(message);

    if (!text.trim()) return null;

    return {
      selfId,
      detailType,
      text,
      messageId: raw.message_id != null ? String(raw.message_id) : undefined,
      userId: raw.user_id != null ? String(raw.user_id) : undefined,
      groupId: raw.group_id != null ? String(raw.group_id) : undefined,
      message,
    };
  }

  parseMetaEvent(raw: OneBotRawEvent): NormalizedMetaEvent {
    const subType = (raw.meta_event_type ?? '') as string;
    const selfId = raw.self_id != null ? String(raw.self_id) : undefined;
    const status = raw.status as Record<string, unknown> | undefined;

    return {
      subType,
      selfId,
      interval: (raw.interval as number) ?? (status?.interval as number) ?? undefined,
    };
  }
}
