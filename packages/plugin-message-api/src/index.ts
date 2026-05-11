// ============================================================
// @aalis/plugin-message-api — 平台消息层契约
//
// 本包定义 Aalis 平台适配层的消息数据契约：
//   - IncomingMessage：从平台适配器（OneBot / WebUI / CLI 等）流入的原始消息
//   - OutgoingMessage：发往平台的回复消息
//   - StreamChunkMessage：流式回复片段（用于 WebUI 等支持流式的前端）
//
// 这些类型描述的是「平台↔Aalis」边界的消息形态，与 OpenAI 风格的
// `Message`（在 core，描述 LLM 上下文）不同——后者是协议层数据载体，
// 前者是平台层语义数据。
//
// 同时通过 declaration merging 将下列事件注入 `AalisEvents`：
//   - 'inbound:message'
//   - 'inbound:message:archived'
//   - 'outbound:message'
//   - 'outbound:stream'
//
// 依赖：core（仅依赖协议层 `Message` / `ContentSegment`）。
// ============================================================

import type { ContentSegment, Message } from '@aalis/core';

// ----- 入站消息 -----

export interface IncomingMessage {
  content: string;
  sessionId: string;
  platform: string;
  userId?: string;
  /** 用户昵称 */
  nickname?: string;
  images?: string[]; // base64 or URL
  /** 附件文件列表（用户上传的文档等） */
  files?: Array<{
    /** 文件名 */
    name: string;
    /** 文件内容（base64 data URL） */
    data: string;
    /** MIME 类型 */
    mimeType?: string;
  }>;
  /** 附件上传顺序（images 与 files 的交错顺序） */
  attachmentOrder?: Array<'image' | 'file'>;
  /** 预处理器生成的图片描述（按 images 原始下标对齐） */
  _imageDescriptions?: string[];
  /** 图片识别后的调试信息，供统一日志与持久化链路复用 */
  _imageRecognitionInfo?: {
    imageCount: number;
    successCount: number;
    descriptions: string[];
    transformedContent: string;
  };
  /** 预处理器生成的文件描述（按 files 原始下标对齐） */
  _fileDescriptions?: string[];
  /** 会话类型：群聊、私聊、频道等 */
  sessionType?: 'group' | 'private' | 'channel';
  /** 消息来源标识（用于并发隔离：同一 session 不同来源互不打断） */
  source?: string;
  /** 群名称（仅群聊时可用） */
  groupName?: string;
  /** 群组 ID（直接字段，无需从 sessionId 解析） */
  groupId?: string;
  /** 引用回复的原消息 */
  replyTo?: {
    messageId: string;
    content?: string;
    userId?: string;
    nickname?: string;
  };
  /** 通知子类型（如 poke、group_upload 等非消息事件） */
  noticeType?: string;
  /**
   * 触发类型（适配器侧设置，下游插件可据此区分主发言者语义）：
   * - 'direct'    私聊或单一用户直连（默认语义：userId 是主发言者）
   * - 'immediate' 群聊中被 @/名字主动触发（userId 是主发言者）
   * - 'interval'  群聊中因消息频率/活跃度被动触发（无明确主发言者，userId 仅为最后一条消息发送者）
   * - 'idle'      空闲自动触发（无 userId / 无主发言者）
   * 未设置时下游插件按 'direct' 兼容处理。
   */
  triggerType?: 'direct' | 'immediate' | 'interval' | 'idle';
}

// ----- 出站消息 -----

export interface OutgoingMessage {
  content: string;
  sessionId: string;
  platform?: string;
  reasoningContent?: string;
  /** 助手输出的有序时间线（与 Message.segments 含义一致），存在时为 webui 等消费者顺序渲染的依据 */
  segments?: ContentSegment[];
  /** 消息来源：agent = AI 回复（可分条延迟发送），其他来源默认立即整条发送 */
  source?: 'agent' | 'system' | 'command';
}

// ----- 流式片段 -----

/** 流式消息片段 */
export interface StreamChunkMessage {
  sessionId: string;
  platform?: string;
  contentDelta?: string;
  reasoningDelta?: string;
  done?: boolean;
  /** 当工具调用次数达到上限时为 true，前端可据此提示用户继续 */
  toolLimitReached?: boolean;
}

// ----- 事件签名（declaration merging 注入到 AalisEvents） -----

declare module '@aalis/core' {
  interface AalisEvents {
    'inbound:message': [message: IncomingMessage];
    /**
     * 入站消息已落库（来自 message-archive.archiveIncoming）。无论是否触发 agent 回复都会发出。
     *
     * payload 字段：
     * - `incoming`：原始入参（含 platform/userId/nickname/groupName/triggerType 等会话上下文，未必持久化）
     * - `archivedMessage`：实际写入 memory 的 `Message`（经过预处理器变换后的最终内容，可能与 `incoming.content` 不同）
     */
    'inbound:message:archived': [data: { sessionId: string; incoming: IncomingMessage; archivedMessage: Message }];
    'outbound:message': [message: OutgoingMessage];
    'outbound:stream': [chunk: StreamChunkMessage];
  }
}

// 防止 "未使用导入" 警告（Message 在 declaration merging 中引用）
export type _MessageRef = Message;
