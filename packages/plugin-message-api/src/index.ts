// ============================================================
// @aalis/plugin-message-api — 消息层契约
//
// 本包持有 Aalis 全部"消息载体"类型，分两层：
//
// 1. LLM 协议层（OpenAI/DeepSeek format）：
//   - Message：LLM 对话上下文消息（role / content / toolCalls / segments ...）
//   - ContentSegment：助手输出的有序时间线分段（text / reasoning_text / tool_call）
//   - ToolCall：助手消息的 tool_calls 载荷（同为 OpenAI chat 协议字段）
//
// 2. 平台适配层（Aalis 边界消息形态）：
//   - IncomingMessage：从平台适配器（OneBot / WebUI / CLI 等）流入的原始消息
//   - OutgoingMessage：发往平台的回复消息
//   - StreamChunkMessage：流式回复片段（用于 WebUI 等支持流式的前端）
//
// 同时通过 declaration merging 将下列事件注入 `AalisEvents`：
//   - 'inbound:message'
//   - 'inbound:message:archived'
//   - 'outbound:message'
//   - 'outbound:stream'
//
// 依赖：仅 @aalis/core。
// ============================================================

// declare module 增强需要原模块可见，本包不用 core 的具体类型，
// 仅以空导入锚点 @aalis/core 让 TS 解析模块身份。
import type {} from '@aalis/core';

// ----- LLM 协议层消息类型 -----

/**
 * OpenAI/DeepSeek chat completions 中 assistant 消息携带的工具调用载荷。
 * 与 Message 同源同生命周期，故所属本包。
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 内容时间线分段（按到达顺序记录助手输出的真实结构）。
 * - text：正常对话文本
 * - reasoning_text：思考/推理文本（部分模型如 DeepSeek-R1、Ollama thinking 会产出）
 * - tool_call：工具调用片段（startTime/endTime 用于时长展示）
 *
 * 该数组若存在则为渲染顺序的真相；同时 message.content / reasoningContent
 * 仍保留为派生镜像，供 LLM API 与历史压缩等纯文本消费者使用。
 */
export type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'reasoning_text'; content: string }
  | {
      type: 'tool_call';
      name: string;
      args: Record<string, unknown>;
      result?: string;
      startTime?: number;
      endTime?: number;
    };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  timestamp?: number;
  reasoningContent?: string | null;
  /**
   * 助手输出的有序时间线（含 text / reasoning_text / tool_call）。
   * 仅 assistant 消息可能携带；存在时为 UI 渲染的权威来源，
   * content 与 reasoningContent 应与之保持一致（由生产方在累积时同步写）。
   */
  segments?: ContentSegment[];
  /** 图片列表（base64 data URL 或 HTTP URL），用于多模态 LLM */
  images?: string[];
  /**
   * 音频列表（base64 data URL / 本地路径 / file:// / http(s) URL），
   * 用于支持原生音频输入的 LLM（如 Gemma 3n E 系列、Gemini、GPT-4o-audio）。
   * Provider 实现需自行解析为各 API 期望的格式（base64 / file ref 等）。
   */
  audios?: string[];
  /** 元数据：用于标记消息来源等信息（不会发送给 LLM） */
  metadata?: Record<string, unknown>;
}

// ----- 入站消息 -----

/**
 * 多模态附件统一载体（v2 新主字段）。
 * 取代 images[] / files[]：所有适配器（OneBot / WebUI / CLI 等）应优先填 attachments，
 * 旧的 images / files 字段保留以兼容老的预处理器与历史代码，框架内的归一化函数会双向同步。
 */
export interface MessageAttachment {
  /** 媒介类型 */
  kind: 'image' | 'audio' | 'video' | 'file';
  /** 内容：base64 data URL / http(s) URL / file:// URI；下游决定如何解析 */
  data: string;
  /** MIME 类型，尽量提供以便分发 */
  mimeType?: string;
  /** 文件名（如有） */
  name?: string;
  /** 来源标识（platform 内部 ID 等，用于幂等与去重） */
  sourceId?: string;
  /** 字节大小（如已知，便于上限/计费判断） */
  byteSize?: number;
  /** 时长秒（仅音视频，如已知） */
  durationSec?: number;
}

export interface IncomingMessage {
  content: string;
  sessionId: string;
  platform: string;
  userId?: string;
  /** 用户昵称 */
  nickname?: string;
  /**
   * 多模态附件统一载体（唯一入口）。
   * 所有平台适配器（OneBot / WebUI / CLI 等）都应只填此字段；
   * plugin-media 在 preprocess 阶段会为每条 attachment 生成文本描述写入 _attachmentDescriptions。
   */
  attachments?: MessageAttachment[];
  /**
   * 预处理器为各 attachments 生成的文本描述（按 attachments 下标对齐；未识别项为 undefined）。
   * 由 plugin-media 写入。
   */
  _attachmentDescriptions?: Array<string | undefined>;
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
  /**
   * 助手要附带发送的多模态附件（图片/音频/视频/文件）。
   * 适配器（OneBot / WebUI 等）应优先发结构化 attachments，把远程 URL 主动下载为本地文件后用 file:// 形式发送。
   * 若 attachments 为空但 content 内含 `<image url="...">` 标记，则由适配器解析嵌入式发图（旧路径，仍兼容）。
   */
  attachments?: MessageAttachment[];
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
  /**
   * 工具调用生成进度提示。当 LLM 正在生成 tool_call（不发文本/reasoning）时，
   * provider 每收到一段 tool_calls delta 会通过此字段上报，让 UI 显示「正在生成工具调用」。
   * 仅用于 UI 提示，不影响最终 tool_call segment 的下发。
   */
  toolCallProgress?: {
    index: number;
    name: string;
    charsAccumulated: number;
  };
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

export {
  type AttachmentRef,
  AttachmentRefKind,
  buildAttachmentRefMatcher,
  formatAttachmentRef,
  parseAttachmentRefs,
} from './attachment-ref.js';
// ----- 身份标识工具（cleanup-9 从 core 迁入） -----
export { getMessageName, getSenderLabel, prefixSender } from './identity.js';
