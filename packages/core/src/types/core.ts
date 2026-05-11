// ===== 核心机制类型 =====

// ----- 安全与权限 -----

/** 安全等级：safe=安全操作, dangerous=高危操作 */
export type SafetyLevel = 'safe' | 'dangerous';

/** 细粒度权限标识，如 tool:file.write、storage:workspace:read */
export type PermissionId = string;

/** 用户身份标识 */
export interface UserIdentity {
  platform: string;
  userId: string;
}

// ----- 消息 -----

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
  /** 元数据：用于标记消息来源等信息（不会发送给 LLM） */
  metadata?: Record<string, unknown>;
}

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

/** 工具调用状态通知 */
export interface ToolExecuteMessage {
  sessionId: string;
  platform?: string;
  /** 工具名称 */
  toolName: string;
  /** 传入工具的参数 */
  args: Record<string, unknown>;
  /** 'start' = 开始调用, 'end' = 调用完成 */
  phase: 'start' | 'end';
  /** 工具返回结果（仅在 phase='end' 时存在） */
  result?: string;
}

// ----- 工具调用 (DeepSeek/OpenAI format) -----

export interface ToolFunction {
  name: string;
  strict?: boolean;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallContext {
  sessionId: string;
  userId?: string;
  platform?: string;
  /** 当前平台启用的工具分组（供 search_tools 等工具过滤用） */
  enabledGroups?: string[];
}

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;
  pluginName: string;
  /** 最低权限等级 (默认 1) */
  authority?: number;
  /** 安全级别 (默认 'safe') */
  safety?: SafetyLevel;
  /** 静态权限标识，用于透明展示与策略匹配 */
  permissions?: PermissionId[];
  /** 根据工具参数解析动态权限，如 storage:workspace:write */
  resolvePermissions?: (
    args: Record<string, unknown>,
    ctx: ToolCallContext,
  ) => PermissionId[] | Promise<PermissionId[]>;
  /** 工具所属分组（用于按平台筛选，未设置时始终可用） */
  groups?: string[];
}

/** 工具摘要（不含 handler，用于搜索展示） */
export interface ToolSummary {
  name: string;
  description: string;
  groups?: string[];
  permissions?: PermissionId[];
}

/** 工具分组信息 */
export interface ToolGroupInfo {
  /** 分组标识（如 'system'、'onebot'、'search'） */
  name: string;
  /** 显示名称（如 '系统工具'、'OneBot 工具'） */
  label: string;
  /** 分组描述 */
  description?: string;
  /** 注册该分组的插件 */
  pluginName: string;
}
// ----- 服务依赖声明 -----

export interface ServiceDependency {
  service: string;
  capabilities?: string[];
}

export type DependencyDeclaration = string | ServiceDependency;

export interface InjectDeclaration {
  required?: DependencyDeclaration[];
  optional?: DependencyDeclaration[];
}

// ----- 插件扩展声明 -----

/**
 * 插件可以声明它对 core 做了哪些扩展，用于前端展示和文档生成。
 *
 * @example
 * export const extends_: ExtendDeclaration = {
 *   events: ['scheduler:tick', 'scheduler:error'],
 *   hooks: ['schedule:before'],
 *   mixins: { scheduler: ['schedule', 'cron'] },
 * };
 */
export interface ExtendDeclaration {
  /** 该插件新增的自定义事件名 */
  events?: string[];
  /** 该插件新增的自定义钩子名 */
  hooks?: string[];
  /** 该插件 mixin 到 Context 上的方法: { 服务名: [方法名...] } */
  mixins?: Record<string, string[]>;
}

// ----- 配置 Schema  -----

export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect' | 'textarea';

export interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  /** 标记为敏感字段，前端显示时自动遮蔽 */
  secret?: boolean;
  /** select / multiselect 类型的静态选项 */
  options?: Array<{ label: string; value: string | number }>;
  /** select / multiselect 类型的动态选项来源：填服务名 (如 'llm', 'embedding', 'platform')，
   *  运行时调用 service.listModels() 获取（platform 特殊处理：收集所有 adapter.platform） */
  dynamicOptions?: string;
  /** select 类型的动态选项来源：填服务名 (如 'llm')，
   *  运行时获取该服务的所有提供者列表（contextId + displayName） */
  dynamicProviders?: string;
  /** multiselect 是否允许用户手动输入自定义值（不限于选项列表） */
  allowCustom?: boolean;
}

export interface SchemaGroup {
  label?: string;
  description?: string;
  fields: Record<string, SchemaField>;
}

/** 数组 Schema：对象数组，每个元素用 items 描述其字段结构 */
export interface SchemaArray {
  type: 'array';
  label: string;
  description?: string;
  /** 数组每个元素的字段定义 */
  items: Record<string, SchemaField>;
  default?: unknown[];
}

/** 配置 Schema：顶层 key 可以是字段、分组或数组 */
export type ConfigSchema = Record<string, SchemaField | SchemaGroup | SchemaArray>;

// ----- 事件类型 -----

/**
 * 内置事件表
 *
 * 第三方插件可通过 TypeScript declaration merging 扩展：
 * ```ts
 * declare module '@aalis/core' {
 *   interface AalisEvents {
 *     'scheduler:tick': [jobId: string];
 *   }
 * }
 * ```
 */
export interface AalisEvents {
  'inbound:message': [message: IncomingMessage];
  /**
   * 入站消息已落库（来自 message-archive.archiveIncoming）。无论是否触发 agent 回复都会发出。
   *
   * 这是所有「派生持久数据」（向量索引、用户画像事实抽取、消息计数等）应当统一挂载的锚点：
   * 既保证只对真正进入历史的消息生效，又不依赖 agent 是否回复。
   *
   * payload 字段：
   * - `incoming`：原始入参（含 platform/userId/nickname/groupName/triggerType 等会话上下文，未必持久化）
   * - `archivedMessage`：实际写入 memory 的 `Message`（经过预处理器变换后的最终内容，可能与 `incoming.content` 不同）
   */
  'inbound:message:archived': [data: { sessionId: string; incoming: IncomingMessage; archivedMessage: Message }];
  'outbound:message': [message: OutgoingMessage];
  'outbound:stream': [chunk: StreamChunkMessage];
  'tool:execute': [info: ToolExecuteMessage];
  'service:registered': [name: string, capabilities: string[]];
  'service:unregistered': [name: string];
  'plugin:loaded': [name: string];
  'plugin:unloaded': [name: string];
  'plugins:changed': [];
  ready: [];
  /** 应用已启动完成，适合 CLI / TUI 等用户交互入口接管终端 */
  'app:started': [];
  dispose: [];
  restarting: [];
  /** 应用正在启动（start() 开头，在服务检查和消息路由注册之前） */
  'app:starting': [];
  /** 应用正在停止（stop() 开头，在 dispose 之前） */
  'app:stopping': [];
  // 会话管理事件由 plugin-session-manager 通过 declaration merging 注入
  /**
   * Gateway 某个入站相位执行完毕（无论是否被 swallow）。
   *
   * 遥测插件可订阅此事件以：
   *   - 记录每个相位耗时
   *   - 统计 swallow 率
   *   - 追踪消息在管道中的流转路径
   *
   * 对主流程零侵入：observer 的异常不会影响入站处理。
   */
  'gateway:phase:done': [
    data: {
      phase: string;
      /** true = 链走到底（未被 swallow）；false = 某 handler 未调用 next() 终止了链 */
      reachedEnd: boolean;
      durationMs: number;
      sessionId: string;
      platform: string;
    },
  ];
  // 允许任意字符串 key 兜底（运行时事件总线开放，但鼓励第三方插件通过 declaration merging 显式声明事件签名以获得类型安全）
  [key: string]: unknown[];
}

// ----- 钩子/中间件类型 -----

/**
 * 中间件 next 函数，调用它将控制传递给下一个中间件或默认行为
 */
export type MiddlewareNext = () => Promise<void>;

/**
 * 中间件函数签名：接收数据和 next，可选择修改数据或中断流程
 */
export type MiddlewareFn<T> = (data: T, next: MiddlewareNext) => Promise<void>;

// ----- 指令系统 -----

/** 指令执行上下文 */
export interface CommandContext {
  /** 会话 ID */
  sessionId: string;
  /** 平台标识 */
  platform: string;
  /** 用户 ID */
  userId?: string;
  /** 指令参数 (命令名之后的部分，按空格分割) */
  args: string[];
  /** 按指令声明解析出的具名位置参数 */
  operands?: Record<string, unknown>;
  /** 按指令声明解析出的选项参数 */
  options?: Record<string, unknown>;
  /** 原始输入文本 */
  raw: string;
  /** 跳过安全等级检查（用于工具桥接等已在上层完成检查的场景） */
  skipSafetyCheck?: boolean;
}

export type CommandValueType = 'string' | 'number' | 'boolean' | 'enum' | 'string[]';

export interface CommandArgumentDefinition {
  /** 位置参数名称 */
  name: string;
  /** 参数类型。text 会消费剩余所有参数并拼回文本 */
  type: 'string' | 'number' | 'boolean' | 'text';
  /** 参数描述 */
  description?: string;
  /** 是否必填 */
  required?: boolean;
  /** 是否消费剩余所有参数 */
  variadic?: boolean;
}

export interface CommandOptionDefinition {
  /** 长选项名，如 type 对应 --type */
  name: string;
  /** 短别名或额外长别名，如 t 对应 -t */
  alias?: string | string[];
  /** 选项类型 */
  type: CommandValueType;
  /** 选项描述 */
  description?: string;
  /** enum 可选值 */
  choices?: string[];
  /** 默认值 */
  default?: unknown;
  /** 是否必填 */
  required?: boolean;
}

/** 指令定义 */
export interface CommandDefinition {
  /** 指令名称 (不含前缀斜杠) */
  name: string;
  /** 指令描述 */
  description: string;
  /** 最低权限等级 (默认 1) */
  authority?: number;
  /** 安全级别 (默认 'safe') */
  safety?: SafetyLevel;
  /** 静态权限标识，用于透明展示与策略匹配 */
  permissions?: PermissionId[];
  /** 位置参数声明 */
  arguments?: CommandArgumentDefinition[];
  /** 选项声明 */
  options?: CommandOptionDefinition[];
  /** 自定义用法文本 */
  usage?: string;
  /** 示例 */
  examples?: string[];
  /**
   * 执行函数
   * @returns 返回字符串表示要回复给用户的文本，返回 void 表示指令自行处理了输出
   *
   * 当存在 subcommands 时，未匹配到任何子指令名的情况下回退到此 action（args 保持原样）。
   * 若希望"必须指定子指令"，可在此返回 usage 提示。
   */
  action: (ctx: CommandContext) => Promise<string | void>;
  /**
   * 子指令树（递归）。匹配规则：
   * - 解析时按 args 顺序逐层匹配子指令名，命中即下沉一层并消耗一个 arg
   * - 命中后调用对应节点的 action（args 为剩余部分）
   * - 任意一层未命中则停在当前节点，调用其 action
   *
   * 权限/安全等级继承：子节点未声明时，继承自其有效父节点（含 override）。
   * Override 键为冒号拼接的完整路径，如 `clear:all`、`db:migrate:up`。
   */
  subcommands?: SubcommandDefinition[];
}

/**
 * 子指令定义（递归）
 *
 * 与 CommandDefinition 类似，但：
 * - action 可选：仅作为分组节点（仅含 subcommands）时省略，调用即返回 usage 提示
 * - 子指令的 pluginName 隐式继承自根指令
 */
export interface SubcommandDefinition {
  /** 子指令名称（不含前缀） */
  name: string;
  /** 子指令描述 */
  description: string;
  /** 最低权限等级；未声明则继承父节点的有效值 */
  authority?: number;
  /** 安全级别；未声明则继承父节点的有效值 */
  safety?: SafetyLevel;
  /** 静态权限标识；会与父节点权限共同生效 */
  permissions?: PermissionId[];
  /** 位置参数声明 */
  arguments?: CommandArgumentDefinition[];
  /** 选项声明 */
  options?: CommandOptionDefinition[];
  /** 自定义用法文本 */
  usage?: string;
  /** 示例 */
  examples?: string[];
  /** 执行函数；省略时该节点仅作为分组，调用回退为 usage 提示 */
  action?: (ctx: CommandContext) => Promise<string | void>;
  /** 进一步的孙级子指令 */
  subcommands?: SubcommandDefinition[];
}

/** 已注册的指令 */
export interface RegisteredCommand extends CommandDefinition {
  /** 注册此指令的插件名 */
  pluginName: string;
}
