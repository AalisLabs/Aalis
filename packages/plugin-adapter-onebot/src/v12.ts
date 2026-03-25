import type {
  OneBotProtocol,
  OneBotRawEvent,
  NormalizedMessageEvent,
  NormalizedMetaEvent,
  SendMessageParams,
} from './types.js';
import { extractText } from './types.js';

/**
 * OneBot v12 协议处理器
 *
 * v12 特点:
 * - 事件使用 type / detail_type
 * - ID 均为 string 类型
 * - 发送消息: send_message (统一)
 * - 获取自身信息: get_self_info
 * - 获取版本: get_version
 * - 元动作: get_supported_actions, get_status, get_version, get_latest_events
 */
export class OneBotV12 implements OneBotProtocol {
  readonly version = 'v12' as const;

  buildSendMessage(params: SendMessageParams): { action: string; params: Record<string, unknown> } {
    const actionParams: Record<string, unknown> = {
      detail_type: params.detailType,
      message: [{ type: 'text', data: { text: params.content } }],
    };

    if (params.detailType === 'private') {
      actionParams.user_id = params.targetId;
    } else if (params.detailType === 'group') {
      actionParams.group_id = params.targetId;
    } else if (params.detailType === 'channel') {
      const [guildId, channelId] = params.targetId.split(':');
      actionParams.guild_id = guildId;
      actionParams.channel_id = channelId;
    }

    return { action: 'send_message', params: actionParams };
  }

  getSelfInfoAction(): string {
    return 'get_self_info';
  }

  parseSelfInfo(data: unknown): string | undefined {
    const info = data as { user_id?: string | number };
    return info?.user_id != null ? String(info.user_id) : undefined;
  }

  parseEventType(raw: OneBotRawEvent): 'message' | 'meta' | 'other' {
    switch (raw.type) {
      case 'message': return 'message';
      case 'meta': return 'meta';
      default: return 'other';
    }
  }

  parseMessageEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedMessageEvent | null {
    const selfId = raw.self?.user_id ? String(raw.self.user_id) : fallbackSelfId;
    const detailType = (raw.detail_type ?? 'private') as string;
    const message = Array.isArray(raw.message) ? raw.message : [];
    const text = (raw.alt_message as string) ?? extractText(message);

    if (!text.trim()) return null;

    return {
      selfId,
      detailType,
      text,
      messageId: raw.message_id != null ? String(raw.message_id) : undefined,
      userId: raw.user_id != null ? String(raw.user_id) : undefined,
      groupId: raw.group_id != null ? String(raw.group_id) : undefined,
      guildId: raw.guild_id != null ? String(raw.guild_id) : undefined,
      channelId: raw.channel_id != null ? String(raw.channel_id) : undefined,
      message,
    };
  }

  parseMetaEvent(raw: OneBotRawEvent): NormalizedMetaEvent {
    const subType = (raw.detail_type ?? '') as string;
    const selfId = raw.self?.user_id ? String(raw.self.user_id) : undefined;

    const version = raw.version as Record<string, unknown> | undefined;

    return {
      subType,
      selfId,
      version: version ? {
        impl: version.impl as string | undefined,
        version: version.version as string | undefined,
        onebot_version: version.onebot_version as string | undefined,
      } : undefined,
      interval: raw.interval as number | undefined,
    };
  }
}
