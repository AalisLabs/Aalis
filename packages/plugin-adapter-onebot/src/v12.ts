import type {
  NormalizedMessageEvent,
  NormalizedMetaEvent,
  NormalizedNoticeEvent,
  NormalizedRequestEvent,
  OneBotProtocol,
  OneBotRawEvent,
  SendMessageParams,
} from './types.js';
import { parseContentToSegments, segmentsToText, toV12Segments } from './types.js';

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
    const segments = parseContentToSegments(params.content);
    const actionParams: Record<string, unknown> = {
      detail_type: params.detailType,
      message: toV12Segments(segments),
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

  parseSelfInfo(data: unknown) {
    const info = data as { user_id?: string | number; user_name?: string; nickname?: string };
    return {
      userId: info?.user_id != null ? String(info.user_id) : undefined,
      nickname: info?.nickname ? String(info.nickname) : info?.user_name ? String(info.user_name) : undefined,
    };
  }

  parseEventType(raw: OneBotRawEvent): 'message' | 'meta' | 'notice' | 'request' | 'other' {
    switch (raw.type) {
      case 'message':
        return 'message';
      case 'meta':
        return 'meta';
      case 'notice':
        return 'notice';
      case 'request':
        return 'request';
      default:
        return 'other';
    }
  }

  parseMessageEvent(
    raw: OneBotRawEvent,
    fallbackSelfId: string,
    nicknameMap?: Map<string, string>,
  ): NormalizedMessageEvent | null {
    const selfId = raw.self?.user_id ? String(raw.self.user_id) : fallbackSelfId;
    const detailType = (raw.detail_type ?? 'private') as string;
    const message = Array.isArray(raw.message) ? raw.message : [];
    // 优先使用消息段生成富文本，回退到 alt_message
    const text =
      message.length > 0 ? segmentsToText(message, selfId, nicknameMap) : ((raw.alt_message as string) ?? '');

    if (!text.trim()) return null;

    // 提取图片 URL / file_id（老字段保留）+ 统一附件
    const attachments: NonNullable<NormalizedMessageEvent['attachments']> = [];
    for (const seg of message) {
      const data = seg.data as Record<string, unknown>;
      const url = (data.url ?? data.file_id) as string | undefined;
      if (seg.type === 'image') {
        if (!url) continue;
        attachments.push({ kind: 'image', url: String(url) });
      } else if (seg.type === 'voice' || seg.type === 'audio') {
        if (!url) continue;
        attachments.push({ kind: 'audio', url: String(url) });
      } else if (seg.type === 'video') {
        // 放宽 URL 约束：保留 attachment 避免静默丢失
        attachments.push({ kind: 'video', url: url ? String(url) : '' });
      } else if (seg.type === 'file') {
        if (!url) continue;
        attachments.push({ kind: 'file', url: String(url) });
      }
    }

    // 提取引用回复的消息 ID
    let replyToMessageId: string | undefined;
    for (const seg of message) {
      if (seg.type === 'reply' && (seg.data.message_id ?? seg.data.id) != null) {
        replyToMessageId = String(seg.data.message_id ?? seg.data.id);
        break;
      }
    }

    // 提取发送者昵称
    const sender = raw.sender as Record<string, unknown> | undefined;
    const nickname =
      (sender?.card as string) || (sender?.nickname as string) || (sender?.user_name as string) || undefined;

    return {
      selfId,
      detailType,
      text,
      messageId: raw.message_id != null ? String(raw.message_id) : undefined,
      userId: raw.user_id != null ? String(raw.user_id) : undefined,
      nickname,
      groupId: raw.group_id != null ? String(raw.group_id) : undefined,
      guildId: raw.guild_id != null ? String(raw.guild_id) : undefined,
      channelId: raw.channel_id != null ? String(raw.channel_id) : undefined,
      message,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyToMessageId,
    };
  }

  parseMetaEvent(raw: OneBotRawEvent): NormalizedMetaEvent {
    const subType = (raw.detail_type ?? '') as string;
    const selfId = raw.self?.user_id ? String(raw.self.user_id) : undefined;

    const version = raw.version as Record<string, unknown> | undefined;

    return {
      subType,
      selfId,
      version: version
        ? {
            impl: version.impl as string | undefined,
            version: version.version as string | undefined,
            onebot_version: version.onebot_version as string | undefined,
          }
        : undefined,
      interval: raw.interval as number | undefined,
    };
  }

  parseNoticeEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedNoticeEvent | null {
    const selfId = raw.self?.user_id ? String(raw.self.user_id) : fallbackSelfId;
    const detailType = (raw.detail_type ?? '') as string;
    const subType = (raw.sub_type ?? '') as string;

    // v12 uses detail_type for notice classification
    return {
      selfId,
      noticeType: detailType || 'unknown',
      subType: subType || undefined,
      userId: raw.user_id != null ? String(raw.user_id) : undefined,
      targetId: raw.target_id != null ? String(raw.target_id) : undefined,
      groupId: raw.group_id != null ? String(raw.group_id) : undefined,
      data: {
        operatorId: raw.operator_id != null ? String(raw.operator_id) : undefined,
        duration: raw.duration != null ? Number(raw.duration) : undefined,
      },
    };
  }

  parseRequestEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedRequestEvent | null {
    const selfId = raw.self?.user_id ? String(raw.self.user_id) : fallbackSelfId;
    // v12 中 request 事件的字段与 v11 基本相同
    const requestType = (raw.request_type ?? raw.detail_type ?? '') as string;
    const userId = raw.user_id != null ? String(raw.user_id) : '';
    const flag = raw.flag != null ? String(raw.flag) : '';
    const comment = raw.comment != null ? String(raw.comment) : undefined;

    if (!userId || !flag) return null;

    if (requestType === 'friend') {
      return { selfId, requestType: 'friend', userId, flag, comment };
    }

    if (requestType === 'group') {
      const subType = raw.sub_type === 'add' || raw.sub_type === 'invite' ? raw.sub_type : undefined;
      const groupId = raw.group_id != null ? String(raw.group_id) : undefined;
      if (!subType || !groupId) return null;
      return { selfId, requestType: 'group', subType, userId, groupId, flag, comment };
    }

    return null;
  }
}
