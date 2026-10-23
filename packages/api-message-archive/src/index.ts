import { roomClass, rootSessionOf, type SessionInfo } from '@aalis/api-session-manager';
import { isStorageUri } from '@aalis/api-storage';
import { defineService } from '@aalis/core';
import type { TextRef } from '@aalis/schema-i18n';
import type { IncomingMessage, Message, MessageAttachment, OutgoingMessage } from '@aalis/schema-message';
import { t } from './texts.js';

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
  /**
   * 描述是要翻译的文字时，它的文字对象（content 写它按原文渲染的整句）：记进元数据的 WellKnownMetadataKeys.Text，
   * 界面按读者的语言显示
   */
  text?: TextRef;
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
  /**
   * 归档一条入站消息。turn 是它进的那一轮（agent 开轮或插入时给）：回合 id 与进入方式（opened 开轮，joined 插进在跑的一轮）记进
   * 元数据的 TurnId、TurnEntry；没进一轮的（被触发判定或流控吞掉的、被放掉的）不给
   */
  archiveIncoming(
    message: IncomingMessage,
    turn?: { turnId: string; entry: 'opened' | 'joined' },
  ): Promise<ArchiveIncomingResult>;
  /**
   * 按送达的快照把出站消息记进会话历史，所有平台一条规则（送达之后发 outbound:delivered 的适配器由存档据此调，送达本身就是写进
   * 会话历史的适配器直接调、等它兑现，没有窗口的子会话由存档认领后调）。要记的内容在调用时同步取走：调用之后对消息的改写不算，
   * 调用方不必另做快照。
   *
   * 1. 不是她回复的文字记成事件标记（schema-message 的 outboundMarkerMessage）；她的回复由 agent 存档，不记。
   * 2. 附件逐个记，不分来源、种类，也不分是否随她的回复发出，按有没有地址分（{@link outboundAddress}）。有地址的按
   *    outboundMediaMessage 记（她发的 role assistant，插件发的 role notice），元数据带 SentRef，文件的描述位写文件名、另带
   *    SentName；没有地址的（data URL、file:// 与本机路径）记成事件标记，正文与元数据的文字对象是 {@link unaddressedText}，
   *    不把内容写进正文。
   * 3. 每条记录的元数据带出站的 Source、TurnId 与 CallId，都是有才记；同一会话里出站记录的时间戳各不相同（按会话与时间戳认
   *    消息的下游据此分得开，如向量记忆换掉改写过的条目）。
   * 4. 图、音、视频的描述取附件带的，发出即记、不等识图。她发的网址图片与视频没带描述时，参考实现记完之后在后台识图，补到后经
   *    记忆的 updateMessageContent 改写这一条、发 memory:messages-rewritten；记忆后端不支持改写时不补。
   *
   * 全部记录写完才兑现（不等后台的识图），写失败时以原因拒绝，已写成的几条不撤回。
   */
  recordOutbound(message: OutgoingMessage): Promise<void>;
  /** 平台 notice/事件入档（系统级条目，不会触发 agent 响应） */
  archiveNotice?(options: ArchiveNoticeOptions): Promise<Message | null>;
  /**
   * 在指定会话最近 `scanLimit` 条历史中查找 metadata.messageId 命中的归档消息。
   * 用于"引用回复"反查我方原文（含图片描述等富信息），避免远端再拉一次。
   * 命中返回归档消息；缺省 scanLimit=100。
   */
  findByMessageId?(sessionId: string, messageId: string, scanLimit?: number): Promise<Message | null>;
}

/**
 * 出站附件记进会话历史用的地址（{@link MessageArchiveService.recordOutbound} 第 2 条）：ref，没有 ref 时 data 是网址或存储地址的
 * 取 data；data URL、file:// 与本机路径没有。发送前要改写 data 的适配器（如换成自己落盘的副本）先按它把原来的地址留在 ref 上，
 * 旁观出站的一方（如会话服务的实时推送）按它给出与历史相同的附件
 */
export function outboundAddress(att: MessageAttachment): string | undefined {
  return att.ref ?? (/^https?:\/\//i.test(att.data) || isStorageUri(att.data) ? att.data : undefined);
}

/** 没有地址的出站附件记成的那一句（recordOutbound 第 2 条）：「[种类] 名字」，没有名字时只写种类 */
export function unaddressedText(att: MessageAttachment): TextRef {
  const kind = t(att.kind);
  return att.name ? t('unaddressed', { kind, name: att.name }) : t('unaddressedKind', { kind });
}

/** {@link speakerOf} 判说话人要问的两个服务，都可缺：调用方按自己可选依赖的在场情况给 */
export interface SpeakerDeps {
  /** 会话管理：按 id 取会话记录 */
  sessionManager?: { getSession(sessionId: string): SessionInfo | undefined };
  /** 权限服务：谁是 owner、owner 在某个平台登记的账号 */
  authority?: {
    isOwner(platform: string, userId?: string): boolean;
    ownerOn(platform: string): { userId: string } | undefined;
  };
}

/**
 * 入站消息归档文本的说话人，交给 schema-message 的 buildIncomingContent 加前缀；存档、触发判定与 agent 的兜底正文都按它，
 * 判定方看到的当前消息与存档逐字一致。依次：
 * 1. 带 source 的（子任务、定时任务、编排、宿主通知、平台事件合成的通知等内部注入）不给：不是任何人的发言；
 * 2. 根会话的受众只有 owner（api-session-manager 的 roomClass 为 owner-only）时不给；
 * 3. 从别的平台往房间里插话（入口平台不是根会话的出生平台）、授权身份（actor，没有时取物理身份）是 owner 时，给 owner 在
 *    出生平台登记的账号，没登记时给这条消息自己的身份；
 * 4. 其余给这条消息自己的昵称与账号。
 * 会话管理不在时第 2、3 条判不出，按第 4 条；权限服务不在时没有人是 owner。
 */
export function speakerOf(
  incoming: IncomingMessage,
  { sessionManager, authority }: SpeakerDeps,
): Pick<IncomingMessage, 'nickname' | 'userId'> | undefined {
  if (incoming.source) return undefined;
  const own = { nickname: incoming.nickname, userId: incoming.userId };
  if (!sessionManager) return own;
  const lookup = (id: string) => sessionManager.getSession(id);
  const isOwner = (platform: string, userId?: string) => authority?.isOwner(platform, userId) ?? false;
  const session = lookup(incoming.sessionId);
  if (roomClass(session, lookup, isOwner) === 'owner-only') return undefined;
  const birth = rootSessionOf(session, lookup)?.originPlatform;
  const { platform, userId } = incoming.actor ?? incoming;
  if (birth === undefined || birth === incoming.platform || !isOwner(platform, userId)) return own;
  const account = authority?.ownerOn(birth);
  return account ? { userId: account.userId } : own;
}

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
export const messageArchive = defineService<MessageArchiveService>('message-archive');
