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

/**
 * 标准 LLM role（OpenAI / DeepSeek / Ollama 等 chat 协议直接接受的四种）。
 * 出口适配器只看到这四种；任何 WellKnownRole 以外的扩展 role 需在出口转译为其中之一。
 */
export type WellKnownRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 消息 role：标准四种 + 任意扩展字符串。
 *
 * 设计：使用 `WellKnownRole | (string & {})` 模式既保留四种标准 role 的字面量自动补全/收窄，
 * 又允许任意自定义 role（如 `'notice'`、未来可能的 `'event'` / `'observation'` 等）。
 *
 * 约束：自定义 role 仅用于 Aalis 内部存储/检索/渲染；调用 LLM 前必须由 provider 适配器
 * 转译为 WellKnownRole 之一（典型做法：notice → system，并在 content 前加 `[系统通知]` 前缀）。
 */
export type MessageRole = WellKnownRole | (string & {});

export interface Message {
  role: MessageRole;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  /**
   * 子分类（与 role 正交的语义维度）。设计目标：
   * - 让所有 role 共用同一个子类入口，避免 system.name / notice.metadata.noticeType / assistant.metadata.kind 三套互不相通的"伪子分类"。
   * - 统一过滤/渲染判断：`m.kind === 'event-marker'` 这种写法跨 role 通用。
   *
   * 约定的语义类（详见 `WELL_KNOWN_KINDS` / `CONTROL_KINDS`）：
   * - `'event-marker'`              ：system 控制类标记（如压缩分隔条），不应进入 LLM 上下文。
   * - `'cross-session-delegation'`  ：notice 子类——来自另一会话的 agent 委派任务。
   * - `'outbound-image'`            ：assistant 子类——agent 已发出的图片。
   * - notice 的平台事件类型         ：`'poke' | 'group_recall' | 'group_increase' | ...`（取自 OneBot 等适配器）。
   *
   * 第三方插件可定义自己的 kind 字符串，但请避开 `WELL_KNOWN_KINDS` 中已有的语义。
   */
  kind?: string;
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
   * 平台侧消息 ID（如 OneBot 的 message_id）。
   * 由适配器填充；归档插件会写入 metadata.messageId，供"引用回复"反查归档原文以保留图片描述等富信息。
   */
  messageId?: string;
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
  /**
   * 群聊中发送者在群内的角色：owner=群主, admin=管理员, member=普通成员。
   * 仅群聊有效，由适配器从平台消息 sender 字段或主动查询填充。
   */
  senderRole?: 'owner' | 'admin' | 'member';
  /** 群聊中发送者的专属头衔（如 "群主"、"打卡王" 等），仅群聊有效。 */
  senderTitle?: string;
  /**
   * 群聊中 self 账号（机器人自身）在该群内的角色。
   * 适配器应在群消息处理时主动查询（带缓存）并填充，用于让 agent 正确认知自身权限。
   */
  selfRole?: 'owner' | 'admin' | 'member';
  /** 群聊中 self 账号的专属头衔（如有）。 */
  selfTitle?: string;
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
   * - 'proactive' 由另一会话的 agent 通过工具发起跨会话委派（content 是任务描述而非用户消息）
   * 未设置时下游插件按 'direct' 兼容处理。
   */
  triggerType?: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive';
  /**
   * 代理身份（与 platform/userId 解耦）：当本条消息并非由人类直接发送，而是由 scheduler、
   * idle-trigger、proactive 委派等系统侧触发器投递时，记录"AI 应代谁执行"。
   *
   * 与 platform/userId 的区别：
   * - platform/userId 表示消息的物理来源（路由+发言者标识），写归档、做用户档案/关系；
   * - actor 表示授权身份，agent 构造 ToolCallContext 时优先使用 actor，
   *   从而让 authority 守卫按 actor 的 (platform, userId) 查权限等级。
   *
   * 触发器（如 scheduler）应在创建任务时 snapshot 调用者身份，触发时回填此字段；
   * 不能由 LLM/AI 在工具入参中自由指定，避免提权。
   */
  actor?: {
    platform: string;
    userId: string;
  };
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
  /** 本条回复的 LLM 元数据（供 webui 实时展示，不需持久化）。 */
  modelInfo?: {
    provider?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    elapsedMs?: number;
  };
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

// ============================================================
// LLM 出口工具：自定义 role → WellKnownRole 转译
// ============================================================

/**
 * 已知的 Message.kind 语义常量。第三方插件可使用新值；本表仅作为框架内的契约。
 *
 * - `EventMarker`：纯 UI/控制标记（如对话压缩分隔条）。LLM 出口与抽取均应排除。
 * - `CrossSessionDelegation`：跨会话委派——另一 agent 通过工具向本会话派发任务。
 * - `OutboundImage`：assistant 已发出的图片占位（content 为 attachment ref 标签）。
 */
export const WellKnownKinds = {
  EventMarker: 'event-marker',
  CrossSessionDelegation: 'cross-session-delegation',
  OutboundImage: 'outbound-image',
  OutboundVideo: 'outbound-video',
} as const;

export type WellKnownKind = (typeof WellKnownKinds)[keyof typeof WellKnownKinds];

/**
 * 控制类 kind 集合：这些消息不携带可供模型理解或抽取的语义内容，
 * 仅用于 UI / 内部状态。LLM 出口、信息抽取等流程默认应排除。
 */
export const CONTROL_KINDS: ReadonlyArray<string> = [WellKnownKinds.EventMarker];

/** 自定义 role 转译为 LLM 接受的 WellKnownRole 的默认映射。 */
const CUSTOM_ROLE_MAP: Record<string, WellKnownRole> = {
  notice: 'system',
};

/** 自定义 role 在 LLM 视角下的内容前缀（仅当转译为 system 时使用）。 */
const CUSTOM_ROLE_PREFIX: Record<string, string> = {
  notice: '[系统通知]',
};

/**
 * Kind 级别的内容前缀（优先级高于 role 前缀）。当 message.kind 命中时，
 * 用此前缀替换 role 前缀，从而精确表达子语义（例如「跨会话委派」与普通通知区分）。
 */
const KIND_PREFIX: Record<string, string> = {
  [WellKnownKinds.CrossSessionDelegation]: '[跨会话委派]',
};

/**
 * 把 Aalis 内部 role 转译为 LLM 协议接受的 WellKnownRole。
 * 未知 role 一律回落为 'system'，避免任何漏网造成 provider 报错。
 */
export function toLLMRole(role: MessageRole): WellKnownRole {
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
    return role as WellKnownRole;
  }
  return CUSTOM_ROLE_MAP[role as string] ?? 'system';
}

/**
 * 准备发往 LLM provider 的消息：把所有自定义 role 转译为 WellKnownRole，
 * 同时给 content 加上可读前缀（kind 优先，其次 role）。
 * provider 适配器应在序列化前调用该函数，确保协议合法。
 *
 * 不修改原对象；返回浅拷贝数组与必要时的消息浅拷贝。
 */
export function prepareLLMMessages<T extends Pick<Message, 'role' | 'content' | 'kind'>>(messages: T[]): T[] {
  return messages.map(m => {
    const llmRole = toLLMRole(m.role);
    const prefix = (m.kind && KIND_PREFIX[m.kind]) ?? CUSTOM_ROLE_PREFIX[m.role as string];
    const needsRoleRewrite = llmRole !== m.role;
    const needsPrefix = !!prefix && typeof m.content === 'string' && m.content.length > 0;
    if (!needsRoleRewrite && !needsPrefix) return m;
    const newContent = needsPrefix ? `${prefix} ${m.content}` : (m.content ?? null);
    return { ...m, role: llmRole, content: newContent } as T;
  });
}

export {
  type AttachmentRef,
  AttachmentRefKind,
  buildAttachmentRefMatcher,
  formatAttachmentRef,
  parseAttachmentRefs,
} from './attachment-ref.js';
// ----- 身份标识工具（cleanup-9 从 core 迁入） -----
export { getMessageName, getSenderLabel, prefixSender } from './identity.js';
