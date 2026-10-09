// ============================================================
// @aalis/schema-message — 消息层契约
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
//   - 'assistant:message:archived'
//   - 'outbound:message'
//   - 'outbound:stream'
//
// 依赖：@aalis/core（类型锚点）+ @aalis/util-text-normalize（prepareLLMMessages 的 UTF-16 规整）。
// ============================================================

// declare module 增强需要原模块可见，本包不用 core 的具体类型，
// 仅以空导入锚点 @aalis/core 让 TS 解析模块身份。
import type {} from '@aalis/core';
import { toWellFormedText } from '@aalis/util-text-normalize';
import { AttachmentRefKind, formatAttachmentRef } from './attachment-ref.js';

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
 * - tool_call：工具调用片段（startTime/endTime 用于时长展示；callId 同这次调用的 ToolCallContext.callId，
 *   历史里的工具卡据它与实时推送对上，参数没解析成、没有执行的调用没有）
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
      callId?: string;
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
   * 约定的语义类（详见 `WellKnownKinds` / `CONTROL_KINDS` / `DIRECTIVE_KINDS`）：
   * - `'event-marker'`              ：system 控制类标记（如压缩分隔条），不应进入 LLM 上下文。
   * - `'cross-session-delegation'`  ：notice 子类——系统代发的任务指令（triggerType 为 proactive，如 workflow 的 agent 节点）。
   * - `'host-notice'`               ：notice 子类——宿主撰写的事件通知（入站消息带 hostNotice）。
   * - `'outbound-image'`            ：assistant 子类——agent 已发出的图片。
   * - notice 的平台事件类型         ：`'poke' | 'group_recall' | 'group_increase' | ...`（取自 OneBot 等适配器）。
   *
   * 第三方插件可定义自己的 kind 字符串，但请避开 `WellKnownKinds` 中已有的语义。
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

/** 多模态附件统一载体。 */
export interface MessageAttachment {
  /** 媒介类型 */
  kind: 'image' | 'audio' | 'video' | 'file';
  /**
   * 内容：base64 data URL / http(s) URL / file:// URI / storage URI（`<根>:/路径`，如 `data:/images/…`，经 storage 服务读取；
   * 与 data URL 以有无 `;base64,` 区分）；下游决定如何解析
   */
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
  /**
   * 出站附件：文本描述（vision/asr 结果）。由生产者（如 send_attachment）填充，
   * 供全局出站归档写入 `[类型: desc | ref:xxx]` 标记，让 memory_recall 能命中。
   */
  description?: string;
  /**
   * 出站附件：稳定引用标识（http(s) url / storage uri）。用于出站归档与历史回放；
   * 缺省时全局归档回退用 data。与平台落盘后改写的 data 解耦，避免归档到临时/不可访问路径。
   */
  ref?: string;
  /**
   * 出站附件：跳过全局归档。用于 history_ref 重发等场景（同一媒体已在档，
   * 避免向量库膨胀与重复入档）。缺省 false。
   */
  skipArchive?: boolean;
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
   * 由适配器填充；归档插件写进元数据的 {@link WellKnownMetadataKeys}.MessageId，供"引用回复"反查归档原文以保留图片描述等富信息。
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
  /**
   * 平台类型名：适配器在 PlatformAdapter.sessionTypes 里声明的类型之一（如 OneBot 的 group、private、channel）。
   * 不带时按 private、一对一
   */
  sessionType?: string;
  /** 收到这条消息的机器人账号（平台给出时由适配器填，如 OneBot 的 self_id） */
  selfId?: string;
  /**
   * 系统侧注入者的来源标识（如 'idle-trigger'、'scheduler'、'workflow:<id>'）。
   * 平台适配器投递真人消息**不设置**此字段：带 source 的消息被视为内部注入——不经触发策略、
   * 不过回复后冷却（禁言与限速照常生效）。同时用于并发隔离：同一 session 不同来源互不打断。
   */
  source?: string;
  /** 群名称（仅群聊时可用） */
  groupName?: string;
  /** 多方聊天窗口的 id，由适配器填（如 OneBot 的群号，频道为 `<guild>:<channel>`） */
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
  /** 通知动作是否指向机器人；poke 为 false 时按未点名互动判断，省略沿用戳机器人的语义。 */
  noticeTargetIsSelf?: boolean;
  /**
   * 触发类型（下游插件可据此区分主发言者语义）。真人消息由 inbound:trigger 相位生效的触发插件写入
   * （immediate / interval），平台适配器不设置；内部注入由注入方自带（idle、proactive）。flow 相位对
   * immediate 不查回复后冷却与限速，所以不经触发插件改写时（作用域外、没装触发插件），入站消息上预设的
   * immediate 会原样生效。
   * - 'direct'    私聊或单一用户直连（默认语义：userId 是主发言者）
   * - 'immediate' 群聊中被 @/名字主动触发（userId 是主发言者）
   * - 'interval'  群聊中因消息频率/活跃度被动触发（无明确主发言者，userId 仅为最后一条消息发送者）
   * - 'idle'      空闲自动触发（无 userId / 无主发言者）
   * - 'proactive' 系统代发给 agent 的任务指令，如 workflow 的 agent 节点（content 是任务描述而非用户消息）
   * 未设置时下游插件按 'direct' 兼容处理。
   */
  triggerType?: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive';
  /**
   * 代理身份（与 platform/userId 解耦）：当本条消息并非由人类直接发送，而是由 scheduler、
   * idle-trigger、workflow 等系统侧触发器投递时，记录"AI 应代谁执行"。
   *
   * 与 platform/userId 的区别：
   * - platform/userId 表示消息的物理来源（路由+发言者标识），写归档、做用户档案/关系；
   * - actor 表示授权身份，agent 构造 ToolCallContext 时优先使用 actor，
   *   从而让 authority 守卫按 actor 的 (platform, userId) 查权限等级。
   *
   * 触发器（如 scheduler）应在创建任务时 snapshot 调用者身份，触发时回填此字段；
   * 不能由 LLM/AI 在工具入参中自由指定，避免提权。
   *
   * AI 自发回合（无主发言者，如群聊 'interval' 触发）没有可代之人：触发器应回填
   * {@link selfInitiatedActor}（userId 为空串 = 无主体），authority 按默认等级裁决、
   * 永不视为 owner。'idle' 合成消息本就不带 userId，天然无主体，无需回填。
   */
  actor?: {
    platform: string;
    userId: string;
  };
  /**
   * 宿主撰写的事件通知（不是任何人的发言）。带这个字段的消息：
   * - 注入方必须同时设 `source`；不设 userId、nickname、sessionType、triggerType；
   * - actor：不延续某次调用的通知用 {@link selfInitiatedActor}、不设 `callerUserId`；延续某次工具调用的（如后台任务
   *   结束通知），platform 同那次调用，actor 取那次调用的有效授权身份 `actor ?? { platform, userId }`（都没有时仍为
   *   selfInitiatedActor），并设 `callerUserId`。延续身份的注入方要在 `test/architecture/host-notice-identity.test.ts` 登记；
   * - agent 渲染为 system 通知，归档为 role 'notice'、kind {@link WellKnownKinds}.HostNotice；
   * - 不进向量记忆、抽取与记忆扩窗。
   *
   * `kind` 是通知的子类（如 'paper-task'），`id` 是注入方生成的通知标识（日志与账本对位用，存档记下；含义随 kind，
   * 如后台任务结束通知的是任务 id）。
   * `untrusted` 是注入方已用 wrapUntrustedContent 包好的不可信段：只在当轮渲染时接在正文之后，
   * 不归档、不进任何存储。宿主撰写的行一律放在 content 里。
   */
  hostNotice?: {
    kind: string;
    id?: string;
    untrusted?: string;
    /**
     * 仅转述状态：保留人设、提供本轮结果，不续跑历史工具链，不提供或执行工具。
     * 误调用工具、空回复或遗漏正文链接与格式纠正共用重试预算（至少一次）；用尽才由注入方兜底。
     * 客户端只收到校验后的正文，不流出生成中或失败轮的原文。
     * 模型错误只记日志并报告 agent:turn:after(error)，
     * 不向会话发通用错误提示；注入方负责根据回合结果派发固定正文或保留待发。
     * 需要 Agent 后续行动的通知不设置此项。
     */
    reportOnly?: boolean;
    /**
     * 通知延续某次工具调用时，那次调用的 ToolCallContext.userId。plugin-agent 只用它填本轮工具调用上下文的 userId
     * （工具眼里是谁在调）与 inbound.callerUserId（执行守卫据此判这一轮是不是 owner 链的延续），并让这位发言者在同一会话的
     * 消息打断这一轮；不当作发言者：归档、用户档案、关系与提示词钩子都不看它。须与 actor 取自同一次调用；不延续某次调用的通知不设。
     */
    callerUserId?: string;
    /**
     * 回复这条通知时引用哪条消息：平台消息 id，取自起那次调用的入站消息（ToolCallContext.inbound.messageId）。
     * plugin-agent 回复时把它带进出站消息的 {@link OutgoingMessage.replyTo}；入站消息没有平台消息 id 的不设
     */
    replyTo?: string;
    /**
     * 给界面的事实：扁平的键值，键由定义这个 kind 的契约约定（如 api-tools 的后台任务结束通知）。界面据此把通知画成状态，
     * 写给模型的 content 不给人看；不进模型的上下文，存档按 {@link WellKnownMetadataKeys}.HostNoticeFacts 记下
     */
    facts?: Record<string, string | number>;
  };
}

/**
 * AI 自发回合的授权身份：无主体。
 *
 * 'interval' 触发复用的是恰好撞上频率阈值的那条真人消息，若不回填 actor，授权轴会经
 * `actor ?? {platform, userId}` 回退到「最后发言者」——绝大多数回合按陌生人 0 级判权
 * （自发回合工具全挂），而 owner 恰好最后发言时整轮（含群内任何提示注入）以 owner 等级
 * 执行。契约（triggerType 注释）与 prompt 侧特判都把 interval 当无主发言者，授权轴应一致。
 *
 * userId 取空串而非缺省：`actor?.userId ?? userId` 回退链遇空串不回退（?? 只认 null/undefined），
 * 由此派生的定时任务/子任务保持匿名，不会漂回物理发言者；authority 的等级查表以空
 * userId 为无键 → 默认等级，owner 判定永不命中空串。
 */
export function selfInitiatedActor(platform: string): { platform: string; userId: string } {
  return { platform, userId: '' };
}

// ----- 出站消息 -----

/**
 * 传输端确认已接受消息，不代表收件人已阅读；失败也 resolve，避免无人等待时产生拒绝。
 * 失败分支的 unconfirmed 表示请求已经发出、只是没等到平台确认（如 OneBot 文件上传超时），消息可能已经送达：
 * 发起方不得自动重发，也不得劝模型重发。没有这个标记的失败才是确定没送达。
 */
export type OutboundDeliveryResult = { ok: true } | { ok: false; error: string; unconfirmed?: true };

/**
 * 发起方等待传输确认的上限。适配器自身的重试窗口可能更长（如 OneBot 单个附件最坏约 150 秒），
 * 超过上限时发起方应报「未确认、请勿重发」而不是失败；上限只为不带回合中止信号的调用方
 * （mcp-server、workflow）不至于一等两三分钟。
 */
export const DELIVERY_WAIT_MS = 90_000;

/**
 * 等 {@link OutgoingMessage.delivery} 结算；signal 中止（回合 latest-wins、手动 abort、插件停机）或到 timeoutMs
 * （缺省 {@link DELIVERY_WAIT_MS}）时不再等，返回 undefined。适配器的发送不随之取消，所以 undefined 只能当
 * 「未确认」，不能当「未发送」。
 */
export function awaitDelivery<T>(
  delivery: Promise<T>,
  signal?: AbortSignal,
  timeoutMs: number = DELIVERY_WAIT_MS,
): Promise<T | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      finish();
    };
    const stop = () => settle(() => resolve(undefined));
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    delivery.then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    );
  });
}

/** 发往平台的回复：只带要发出去的正文与附件。思考与工具时间线在存档的 Message 上，客户端经会话协议拿 */
export interface OutgoingMessage {
  content: string;
  sessionId: string;
  platform?: string;
  /**
   * 仅进程内：目标适配器在出站监听器中同步认领并填写，发起方 await emit 后可等待它。
   * 不存在表示没有适配器提供确认，不能当作发送成功。旁观/镜像客户端不得认领其他平台的消息。
   * 所有发送分支都须结算；不序列化、不持久化，也不把事件广播完成当成投递完成。
   */
  delivery?: Promise<OutboundDeliveryResult>;
  /** 宿主通知的最终转述或宿主正文兜底；用于关联通知派发，不给回合中的工具消息附带此标记。 */
  hostNotice?: { kind: string; id?: string };
  /**
   * 引用回复：被引用消息的平台消息 id。支持引用的适配器把引用加在这条消息的第一条分条前，不支持的忽略。
   * 现在只有回复宿主通知时带（IncomingMessage.hostNotice.replyTo）
   */
  replyTo?: string;
  /**
   * 助手要附带发送的多模态附件（图片/音频/视频/文件）。
   * 适配器（OneBot / WebUI 等）应优先发结构化 attachments，把远程 URL 主动下载为本地文件后用 file:// 形式发送。
   * 若 attachments 为空但 content 内含 `<image url="...">` 标记，则由适配器解析嵌入式发图（旧路径，仍兼容）。
   */
  attachments?: MessageAttachment[];
  /** 消息来源：agent = AI 回复（可分条延迟发送），其他来源默认立即整条发送 */
  source?: 'agent' | 'system' | 'command';
  /** 由工具调用发出的消息：那次调用的 id（ToolCallContext.callId），会话的客户端据此把消息挂到对应的工具卡上 */
  callId?: string;
  /** agent 一轮的回复：这一轮的 id。适配器记投递失败时带上它，回看历史时据此标出这一轮的回复没发出 */
  turnId?: string;
  /**
   * 本条回复的 LLM 元数据（agent 存档时同一份写进这条 assistant 消息元数据的 {@link WellKnownMetadataKeys}.ModelInfo），
   * 只在进程内；会话服务取其中的模型与这一轮的 token 标在实时推送的回复上，与历史里还原的一致
   */
  modelInfo?: {
    provider?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
  };
}

// ----- 流式片段 -----

/** 流式消息片段 */
export interface StreamChunkMessage {
  sessionId: string;
  /** 所在回合的 id（agent 在回合开始时生成，同一轮的工具调用、用量与回合结束带同一个） */
  turnId: string;
  platform?: string;
  contentDelta?: string;
  reasoningDelta?: string;
  /**
   * 工具调用的生成进度：模型生成工具调用的参数时，provider 每收到一段增量上报一次（api-llm 的 ToolCallProgress），
   * agent 转发时带上这次调用的 callId，与之后执行它时 tool:execute 的 callId 相同，界面据此在参数生成期间就画出它的
   * 工具卡。同一个调用的多次进度 callId 相同；只是提示，不影响最终的工具调用
   */
  toolCallProgress?: {
    /** 这一次模型回复里的第几个工具调用 */
    index: number;
    name: string;
    /** 已生成的参数字数 */
    charsAccumulated: number;
    callId: string;
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
     * assistant 回复已落库（来自 message-archive.saveMessage，仅 role='assistant' 且内容非空时发出）。
     * 与 'inbound:message:archived' 对称，供派生索引（如向量记忆索引 AI 自身发言）订阅。
     */
    'assistant:message:archived': [data: { sessionId: string; message: Message }];
    /**
     * 入站消息已落库（来自 message-archive.archiveIncoming）。无论是否触发 agent 回复都会发出。
     *
     * payload 字段：
     * - `incoming`：原始入参（含 platform/userId/nickname/groupName/triggerType 等会话上下文，未必持久化）
     * - `archivedMessage`：实际写入 memory 的 `Message`（经过预处理器变换后的最终内容，可能与 `incoming.content` 不同）
     */
    'inbound:message:archived': [data: { sessionId: string; incoming: IncomingMessage; archivedMessage: Message }];
    'outbound:message': [message: OutgoingMessage];
    /** 传输端确认后的消息快照；attachments 只包含成功的附件，供归档等旁观者使用。 */
    'outbound:delivered': [message: OutgoingMessage];
    'outbound:stream': [chunk: StreamChunkMessage];
  }
}

// ============================================================
// LLM 出口工具：自定义 role → WellKnownRole 转译
// ============================================================

/**
 * 已知的 Message.kind 语义常量。第三方插件可使用新值；本表仅作为框架内的契约。
 *
 * - `EventMarker`：纯 UI/控制标记（如对话压缩分隔条）。LLM 出口与抽取均应排除。
 * - `CrossSessionDelegation`：代发任务——triggerType 为 proactive 的入站消息（如 workflow 的 agent 节点）归档时标的 kind。
 * - `OutboundImage`：assistant 已发出的图片占位（content 为 attachment ref 标签）。
 * - `OutboundAudio`：assistant 已发出的音频占位。
 * - `OutboundVideo`：assistant 已发出的视频占位。
 * - `OutboundFile`：assistant 已发出的文件占位（描述位是文件名）。
 * - `HostNotice`：宿主撰写的事件通知——带 `hostNotice` 的入站消息归档时标的 kind（role 为 notice）。
 * - `OutboundDeliveryFailed`：平台适配器记下的投递失败（role 为 system）：她发出的消息平台没收下或结果未知，进下一轮的上下文，
 *   让她知道刚才那条没送达。metadata 带 {@link WellKnownMetadataKeys} 的 `DeliveryError`（与投递结果同一句原因），以及那条
 *   消息的 `TurnId`（一轮的回复）或 `CallId`（经工具发出的）。
 */
export const WellKnownKinds = {
  EventMarker: 'event-marker',
  CrossSessionDelegation: 'cross-session-delegation',
  OutboundImage: 'outbound-image',
  OutboundAudio: 'outbound-audio',
  OutboundVideo: 'outbound-video',
  OutboundFile: 'outbound-file',
  HostNotice: 'host-notice',
  OutboundDeliveryFailed: 'outbound-delivery-failed',
} as const;

export type WellKnownKind = (typeof WellKnownKinds)[keyof typeof WellKnownKinds];

/** 出站附件归档时的消息 kind 与占位符 kind */
const OUTBOUND_MEDIA = {
  image: { kind: WellKnownKinds.OutboundImage, ref: AttachmentRefKind.Image },
  audio: { kind: WellKnownKinds.OutboundAudio, ref: AttachmentRefKind.Audio },
  video: { kind: WellKnownKinds.OutboundVideo, ref: AttachmentRefKind.Video },
  file: { kind: WellKnownKinds.OutboundFile, ref: AttachmentRefKind.File },
} as const;

/**
 * 发出的图片、音频、视频与文件在会话历史里的记法：一条 assistant 消息，kind 为 OutboundImage / OutboundAudio /
 * OutboundVideo / OutboundFile，正文是附件引用占位符（{@link formatAttachmentRef}）。归档方一律用它，memory_recall 与
 * 会话服务回看历史才能按同一格式命中、还原。文件的 desc 记文件名。时间戳与 metadata 由调用方补上。
 */
export function outboundMediaMessage(kind: MessageAttachment['kind'], ref: string, desc?: string): Message {
  const media = OUTBOUND_MEDIA[kind];
  return { role: 'assistant', kind: media.kind, content: formatAttachmentRef({ kind: media.ref, desc, ref }) };
}

/** 存档里提问带的一个附件（{@link WellKnownMetadataKeys}.Attachments 的一项） */
export interface ArchivedAttachment {
  kind: MessageAttachment['kind'];
  /** 入站附件带的文件名 */
  name?: string;
  /** 地址：存储地址（`<根>:/路径`）或网址；入站附件的 data 不是地址（内联数据、本机路径、预处理器的私有引用）、预处理器也没给出引用的没有 */
  ref?: string;
}

/**
 * 跨插件约定的 `Message.metadata` 键。metadata 是开放字典，本表登记由一方写入、另一方读取的键：写方与读方都引用这里的
 * 常量，第三方的 agent、存档与适配器照着写，读历史与记忆的一方（会话服务回看历史、向量记忆、用户档案与关系等）才还原得出
 * 说话人、群、文件、回复的模型与 token、工具卡的归组。
 *
 * - `VisibleContent`：assistant 消息的可见正文（字符串）。回复经结构化输出（persona 的 outputFormat）
 *   时，`content` 存整串 JSON 信封（保持历史 few-shot 的格式），用户实际看到的是其中的回复字段。
 *   agent 落库时把解码后的正文写进这个键，只在它与 `content` 不同时写入；缺省即 `content` 本身就是
 *   可见正文。检索、摘要等按语义消费历史的一方应优先读它，读不到再退回 `content`。
 * - `SpokenContent`：提问里发言人自己写的话（字符串，可以是空串），即入站消息的 `content`。存档的 `content` 是给模型看的
 *   归档文本（{@link buildIncomingContent}：发送者前缀、引用与附件描述），存档只在两者不同时写这个键；缺省即 `content`。
 *   会话服务据此给出提问条目的正文。
 * - `Attachments`：提问带的附件清单（{@link ArchivedAttachment} 的数组，按入站顺序），存档写；会话服务据此把文件还原成卡片、
 *   图片等按地址显示。没有附件时不写。
 * - `Platform`、`UserId`、`Nickname`：说话人的平台、用户 id 与昵称（字符串）。存档写入站消息的；agent 给她自己的回复写
 *   这一轮的平台与她在那里的账号、昵称。会话服务据此标出说话人与是不是 owner，向量记忆、用户档案与关系等也读。
 * - `GroupId`、`GroupName`、`SessionType`：说话所在的群号、群名与会话类型（字符串，即入站消息的 `groupId`、`groupName`、
 *   `sessionType`）。存档写入站消息的，agent 给她自己的回复写这一轮的；向量记忆与最近消息据此写出说话的位置，关系插件据此
 *   判断是不是群聊。
 * - `MessageId`：平台侧的消息 id（字符串，即入站消息的 `messageId`），存档写；存档按它反查被引用的原文，关系插件据此把
 *   引用与回复对回消息。
 * - `Source`：这条记录的来源（字符串）：入站消息是它的 `source`（内部注入的来源，真人发言没有）；插件自己写的记录（发出的
 *   附件、投递失败）写插件的名字。会话服务据此标出提问是不是内部注入的。
 * - `HostNoticeKind`、`HostNoticeId`、`HostNoticeFacts`：宿主通知的子类（`hostNotice.kind`）、id（`hostNotice.id`）与给界面的
 *   事实（`hostNotice.facts`），存档写；会话服务据此给出通知条目的种类、id 与事实。
 * - `TurnId`：所在回合的 id（字符串）。agent 写在这一轮落库的回复与工具结果上，平台适配器写在一轮回复的投递失败记录上；
 *   会话服务据此把存档归回回合、标出哪一轮的回复没发出。
 * - `CallId`：工具调用的 id（字符串，即 `ToolCallContext.callId`）。agent 写在工具结果上，平台适配器写在经工具发出的
 *   消息的投递失败记录上；会话服务据此把历史里的工具卡对回实时推送。
 * - `ModelInfo`：一轮回复的模型与这一轮的 token，与 {@link OutgoingMessage}.modelInfo 同形；agent 写在这一轮最后的回复上，
 *   会话服务标在回复条目上。
 * - `SentRef`、`SentName`：发出的附件（`outboundMediaMessage` 记的那条）原样的地址与文件名（字符串）：占位符里的地址遇到
 *   「]」会截断、描述位的「]」「|」换成了全角。归档发出附件的一方写，会话服务优先取它们还原附件。
 * - `DeliveryError`：投递失败记录（{@link WellKnownKinds}.OutboundDeliveryFailed）里与投递结果同一句的原因（字符串），平台
 *   适配器写；会话服务据此写出回复为什么没发出。
 */
export const WellKnownMetadataKeys = {
  VisibleContent: 'visibleContent',
  SpokenContent: 'spokenContent',
  Attachments: 'attachments',
  Platform: 'platform',
  UserId: 'userId',
  Nickname: 'nickname',
  GroupId: 'groupId',
  GroupName: 'groupName',
  SessionType: 'sessionType',
  MessageId: 'messageId',
  Source: 'source',
  HostNoticeKind: 'hostNoticeKind',
  HostNoticeId: 'hostNoticeId',
  HostNoticeFacts: 'hostNoticeFacts',
  TurnId: 'turnId',
  CallId: 'callId',
  ModelInfo: 'modelInfo',
  SentRef: 'ref',
  SentName: 'name',
  DeliveryError: 'error',
} as const;

/**
 * 平台无关的 well-known `noticeType` 值。
 *
 * `noticeType` 字段是开放字符串（各平台 adapter 自由填写），但列在这里的是**共享语义词**：
 * 语义与平台解耦，各平台 adapter 负责把自家等价事件映射到同一个词，下游的通用插件
 * （如 trigger-policy 的直触发判定）只认这份词汇表，不认平台私有事件名。
 */
export const WellKnownNoticeTypes = {
  /**
   * "戳/逗弄"类互动动作（QQ 戳一戳等）。
   * adapter 把群友互戳与戳机器人都转为 inbound，并用 noticeTargetIsSelf 区分是否点名机器人。
   */
  Poke: 'poke',
} as const;

export type WellKnownNoticeType = (typeof WellKnownNoticeTypes)[keyof typeof WellKnownNoticeTypes];

/**
 * 控制类 kind 集合：这些消息不携带可供模型理解或抽取的语义内容，
 * 仅用于 UI / 内部状态。LLM 出口、信息抽取等流程默认应排除。
 */
export const CONTROL_KINDS: ReadonlyArray<string> = [WellKnownKinds.EventMarker];

/**
 * 宿主或系统撰写、不是任何人发言的指令类 kind。
 * - 归档消息的 kind 属于它：抽取（用户事实、指令、关系）与记忆扩窗一律跳过；
 * - 请求期消息的 metadata.injector 属于它：是本轮的指令块（turn-context、turn-hint 落在它之前；DeepSeek 不把它改成 user）。
 */
export const DIRECTIVE_KINDS: ReadonlyArray<string> = [
  WellKnownKinds.CrossSessionDelegation,
  WellKnownKinds.HostNotice,
];

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
  [WellKnownKinds.HostNotice]: '[宿主通知]',
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
 * 工具结果携图（tool 消息带 images）：OpenAI 系协议的 tool 消息只能是文本，图片块只认 user
 * 角色。这里把 images 从 tool 消息上摘下，在**该段连续 tool 应答全部结束之后**追加一条注明
 * 来源的 user 图片消息（并行工具调用时 assistant(tool_calls) 后的 tool 应答必须连续，载体
 * 插在中间会被端点拒收）。各 provider 沿用自己 user 角色的图片展开即可，无需感知工具携图。
 * 幂等：摘过 images 的 tool 消息再次调用不会重复生成载体。
 *
 * 不修改原对象；返回新数组与必要时的消息浅拷贝。
 */
export function prepareLLMMessages<
  T extends Pick<Message, 'role' | 'content' | 'kind'> & Pick<Message, 'images' | 'toolCallId'>,
>(messages: T[]): T[] {
  const out: T[] = [];
  let pendingImages: string[] = [];
  let pendingCallIds: string[] = [];
  const flushCarrier = (): void => {
    if (pendingImages.length === 0) return;
    out.push({
      role: 'user',
      content: `[以下图片是工具调用 ${pendingCallIds.join('、')} 的返回内容]`,
      images: pendingImages,
    } as T);
    pendingImages = [];
    pendingCallIds = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      if (m.images && m.images.length > 0) {
        const { images, ...textOnly } = m;
        pendingImages.push(...images);
        pendingCallIds.push(m.toolCallId ?? '?');
        out.push(normalizeForLLM(textOnly as T));
      } else {
        out.push(normalizeForLLM(m));
      }
      continue;
    }
    flushCarrier();
    out.push(normalizeForLLM(m));
  }
  flushCarrier();
  return out;
}

/** 单条消息的协议归一：自定义 role 转译 + 可读前缀 + 良构 UTF-16。 */
function normalizeForLLM<T extends Pick<Message, 'role' | 'content' | 'kind'>>(m: T): T {
  const llmRole = toLLMRole(m.role);
  const prefix = (m.kind && KIND_PREFIX[m.kind]) ?? CUSTOM_ROLE_PREFIX[m.role as string];
  const needsRoleRewrite = llmRole !== m.role;
  // 边界硬保证：所有发往 LLM 的 string content 先规整成良构 UTF-16（孤代理→�）。杜绝孤代理经
  // JSON.stringify 编成 `\ud83d`（半个代理对）被严格 JSON 解析器（如 DeepSeek 服务端）拒收、
  // 致整条请求 400。对良构内容为 no-op（原样返回、不新建字符串），故不改变现有行为；对任何插件
  // 产生的内容在此唯一出口自动生效，第三方插件无需感知"孤代理"、无需调用任何东西。
  const content = typeof m.content === 'string' ? toWellFormedText(m.content) : m.content;
  const contentChanged = content !== m.content;
  // 幂等守卫：content 已带该前缀就不再叠加。role 前缀靠改写 role 自消费，kind 前缀不消费 kind，
  // 二次调用会把 `[跨会话委派]` 叠成两遍——用 startsWith 兜住，两条路径都真幂等。
  const needsPrefix = !!prefix && typeof content === 'string' && content.length > 0 && !content.startsWith(prefix);
  if (!needsRoleRewrite && !needsPrefix && !contentChanged) return m;
  const newContent = needsPrefix ? `${prefix} ${content}` : (content ?? null);
  return { ...m, role: llmRole, content: newContent } as T;
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
// ----- 入站消息的归档文本（归档与触发判定共用） -----
export { buildIncomingContent } from './incoming-content.js';
