import type {} from '@aalis/core';
import type { IncomingMessage, Message } from '@aalis/plugin-message-api';

export interface ArchiveIncomingResult {
  message: Message;
  content: string;
}

/** 平台通知/事件归档参数（参考 OneBot v11/v12 notice 规范） */
export interface ArchiveNoticeOptions {
  /** 归档目标会话 ID（与正常消息共用同一会话） */
  sessionId: string;
  /** 通知类型：onebot 中的 notice_type / detail_type，例如 group_ban、group_recall、group_increase 等 */
  noticeType: string;
  /** 通知子类型（如 v11 group_ban 的 ban / lift_ban） */
  subType?: string;
  /** 人类可读的描述文本，将作为 system 消息内容写入记忆 */
  content: string;
  /** 平台标识（如 onebot） */
  platform?: string;
  /** 触发者用户 ID */
  userId?: string;
  /** 被操作者用户 ID（如禁言对象、撤回消息发送者） */
  targetId?: string;
  /** 群 ID（群聊场景） */
  groupId?: string;
  /** 操作者用户 ID（如管理员） */
  operatorId?: string;
  /** 事件时间戳（毫秒），缺省使用当前时间 */
  timestamp?: number;
  /** 任意附加数据（持续时长、消息 ID 等），透传至 metadata */
  data?: Record<string, unknown>;
}

export interface MessageArchiveService {
  saveMessage(sessionId: string, message: Message, options?: { debugLabel?: string }): Promise<void>;
  archiveIncoming(message: IncomingMessage): Promise<ArchiveIncomingResult>;
  /** 平台 notice/事件入档（系统级条目，不会触发 agent 响应） */
  archiveNotice?(options: ArchiveNoticeOptions): Promise<Message | null>;
  /**
   * 在指定会话最近 `scanLimit` 条历史中查找 metadata.messageId 命中的归档消息。
   * 用于"引用回复"反查我方原文（含图片描述等富信息），避免远端再拉一次。
   * 命中返回归档消息；缺省 scanLimit=100。
   */
  findByMessageId?(sessionId: string, messageId: string, scanLimit?: number): Promise<Message | null>;
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    'message-archive': MessageArchiveService;
  }
}
