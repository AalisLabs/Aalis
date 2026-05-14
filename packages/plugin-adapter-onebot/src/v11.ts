import type {
  NormalizedMessageEvent,
  NormalizedMetaEvent,
  NormalizedNoticeEvent,
  NormalizedRequestEvent,
  OneBotProtocol,
  OneBotRawEvent,
  SendMessageParams,
} from './types.js';
import { parseContentToSegments, segmentsToText, toV11Segments } from './types.js';

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
    const segments = parseContentToSegments(params.content);
    const actionParams: Record<string, unknown> = {
      message: toV11Segments(segments),
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
        user_id: params.detailType === 'private' ? Number(params.targetId) || params.targetId : undefined,
        group_id: params.detailType === 'group' ? Number(params.targetId) || params.targetId : undefined,
      },
    };
  }

  getSelfInfoAction(): string {
    return 'get_login_info';
  }

  parseSelfInfo(data: unknown) {
    const info = data as { user_id?: number | string; nickname?: string };
    return {
      userId: info?.user_id != null ? String(info.user_id) : undefined,
      nickname: info?.nickname ? String(info.nickname) : undefined,
    };
  }

  parseEventType(raw: OneBotRawEvent): 'message' | 'meta' | 'notice' | 'request' | 'other' {
    switch (raw.post_type) {
      case 'message':
        return 'message';
      case 'meta_event':
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
    const selfId = raw.self_id != null ? String(raw.self_id) : fallbackSelfId;
    const detailType = (raw.message_type ?? 'private') as string;
    const message = Array.isArray(raw.message) ? raw.message : [];
    // 优先使用消息段生成富文本（含 <at> 等标记），回退到 raw_message
    const text =
      message.length > 0 ? segmentsToText(message, selfId, nicknameMap) : ((raw.raw_message as string) ?? '');

    if (!text.trim()) return null;

    // 提取图片 URL（老字段保留兼容）
    // 提取统一附件列表（image/record/video/file）
    const attachments: NonNullable<NormalizedMessageEvent['attachments']> = [];
    for (const seg of message) {
      if (seg.type === 'image' && seg.data.url) {
        const url = String(seg.data.url);
        attachments.push({ kind: 'image', url, name: seg.data.file ? String(seg.data.file) : undefined });
      } else if (seg.type === 'record' && (seg.data.url || seg.data.file)) {
        // OneBot v11: 'record' = 语音段
        const url = String(seg.data.url ?? seg.data.file);
        attachments.push({ kind: 'audio', url, name: seg.data.file ? String(seg.data.file) : undefined });
      } else if (seg.type === 'video' && (seg.data.url || seg.data.file)) {
        const url = String(seg.data.url ?? seg.data.file);
        attachments.push({ kind: 'video', url, name: seg.data.file ? String(seg.data.file) : undefined });
      } else if (seg.type === 'file' && (seg.data.url || seg.data.file)) {
        const url = String(seg.data.url ?? seg.data.file);
        attachments.push({ kind: 'file', url, name: seg.data.file ? String(seg.data.file) : undefined });
      }
    }

    // 提取引用回复的消息 ID
    let replyToMessageId: string | undefined;
    for (const seg of message) {
      if (seg.type === 'reply' && seg.data.id != null) {
        replyToMessageId = String(seg.data.id);
        break;
      }
    }

    // 提取发送者昵称（优先群名片，回退到昵称）
    const sender = raw.sender as Record<string, unknown> | undefined;
    const nickname = (sender?.card as string) || (sender?.nickname as string) || undefined;

    return {
      selfId,
      detailType,
      text,
      messageId: raw.message_id != null ? String(raw.message_id) : undefined,
      userId: raw.user_id != null ? String(raw.user_id) : undefined,
      nickname,
      groupId: raw.group_id != null ? String(raw.group_id) : undefined,
      message,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyToMessageId,
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

  parseNoticeEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedNoticeEvent | null {
    const selfId = raw.self_id != null ? String(raw.self_id) : fallbackSelfId;
    const noticeType = (raw.notice_type ?? '') as string;
    const subType = (raw.sub_type ?? '') as string;

    // v11 poke: notice_type='notify', sub_type='poke'
    if (noticeType === 'notify' && subType === 'poke') {
      return {
        selfId,
        noticeType: 'poke',
        userId: raw.user_id != null ? String(raw.user_id) : undefined,
        targetId: raw.target_id != null ? String(raw.target_id) : undefined,
        groupId: raw.group_id != null ? String(raw.group_id) : undefined,
      };
    }

    // 群文件上传: notice_type='group_upload'
    if (noticeType === 'group_upload') {
      const file = raw.file as Record<string, unknown> | undefined;
      return {
        selfId,
        noticeType: 'group_upload',
        userId: raw.user_id != null ? String(raw.user_id) : undefined,
        groupId: raw.group_id != null ? String(raw.group_id) : undefined,
        data: file
          ? {
              fileId: file.id,
              fileName: file.name,
              fileSize: file.size,
              busid: file.busid,
            }
          : undefined,
      };
    }

    // 群成员增减: notice_type='group_increase' / 'group_decrease'
    if (noticeType === 'group_increase' || noticeType === 'group_decrease') {
      return {
        selfId,
        noticeType,
        subType,
        userId: raw.user_id != null ? String(raw.user_id) : undefined,
        groupId: raw.group_id != null ? String(raw.group_id) : undefined,
        data: {
          operatorId: raw.operator_id != null ? String(raw.operator_id) : undefined,
        },
      };
    }

    // 群管理员变动: notice_type='group_admin'
    if (noticeType === 'group_admin') {
      return {
        selfId,
        noticeType: 'group_admin',
        subType,
        userId: raw.user_id != null ? String(raw.user_id) : undefined,
        groupId: raw.group_id != null ? String(raw.group_id) : undefined,
      };
    }

    // 群禁言: notice_type='group_ban', sub_type='ban' | 'lift_ban'
    if (noticeType === 'group_ban') {
      return {
        selfId,
        noticeType: 'group_ban',
        subType: subType || undefined,
        userId: raw.user_id != null ? String(raw.user_id) : undefined,
        groupId: raw.group_id != null ? String(raw.group_id) : undefined,
        data: {
          operatorId: raw.operator_id != null ? String(raw.operator_id) : undefined,
          duration: raw.duration != null ? Number(raw.duration) : undefined,
        },
      };
    }

    // 消息撤回: notice_type='group_recall' / 'friend_recall'
    if (noticeType === 'group_recall' || noticeType === 'friend_recall') {
      return {
        selfId,
        noticeType,
        userId: raw.user_id != null ? String(raw.user_id) : undefined,
        groupId: raw.group_id != null ? String(raw.group_id) : undefined,
        data: {
          operatorId: raw.operator_id != null ? String(raw.operator_id) : undefined,
          messageId: raw.message_id != null ? String(raw.message_id) : undefined,
        },
      };
    }

    // 其他未处理的通知类型
    return {
      selfId,
      noticeType: noticeType || 'unknown',
      subType: subType || undefined,
      userId: raw.user_id != null ? String(raw.user_id) : undefined,
      groupId: raw.group_id != null ? String(raw.group_id) : undefined,
    };
  }

  parseRequestEvent(raw: OneBotRawEvent, fallbackSelfId: string): NormalizedRequestEvent | null {
    const selfId = raw.self_id != null ? String(raw.self_id) : fallbackSelfId;
    const requestType = (raw.request_type ?? '') as string;
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
