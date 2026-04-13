// ===== 核心机制类型 =====

// ----- 安全与权限 -----

/** 安全等级：safe=安全操作, dangerous=高危操作 */
export type SafetyLevel = 'safe' | 'dangerous';

/** 用户身份标识 */
export interface UserIdentity {
  platform: string;
  userId: string;
}

// ----- 消息 -----

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  timestamp?: number;
  reasoningContent?: string | null;
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
}

export interface OutgoingMessage {
  content: string;
  sessionId: string;
  platform?: string;
  reasoningContent?: string;
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
  /** 安全级别 (默认 'safe') */
  safety?: SafetyLevel;
  /** 最低权限等级 (默认 1) */
  authority?: number;
  /** 工具所属分组（用于按平台筛选，未设置时始终可用） */
  groups?: string[];
}

/** 工具摘要（不含 handler，用于搜索展示） */
export interface ToolSummary {
  name: string;
  description: string;
  authority: number;
  safety: SafetyLevel;
  groups?: string[];
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

// ----- 执行守卫 -----

/**
 * 执行守卫上下文 —— 在工具/指令执行前进行权限检查的最小信息
 */
export interface ExecutionGuardContext {
  /** 操作名称（工具名或指令名） */
  name: string;
  /** 操作类型 */
  type: 'tool' | 'command';
  /** 声明的最低权限等级 */
  authority: number;
  /** 声明的安全等级 */
  safety: SafetyLevel;
  /** 会话 ID */
  sessionId: string;
  /** 来源平台 */
  platform: string;
  /** 用户 ID */
  userId?: string;
  /** 操作参数（工具调用时） */
  args?: Record<string, unknown>;
  /** 是否跳过安全等级检查（指令的工具桥接等场景） */
  skipSafetyCheck?: boolean;
}

/**
 * 执行守卫函数
 *
 * 返回 null 表示放行，返回 string 表示拦截（值为拦截原因/提示消息）。
 * 由外部插件（如 plugin-authority）通过 setExecutionGuard() 注入。
 */
export type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;

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

// ----- 配置 Schema (internal-framework-style) -----

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
  'message:received': [message: IncomingMessage];
  'message:send': [message: OutgoingMessage];
  'message:stream': [chunk: StreamChunkMessage];
  'tool:execute': [info: ToolExecuteMessage];
  'service:registered': [name: string, capabilities: string[]];
  'service:unregistered': [name: string];
  'plugin:loaded': [name: string];
  'plugin:unloaded': [name: string];
  'plugins:changed': [];
  'ready': [];
  'dispose': [];
  'restarting': [];
  /** 应用正在启动（start() 开头，在服务检查和消息路由注册之前） */
  'app:starting': [];
  /** 应用正在停止（stop() 开头，在 dispose 之前） */
  'app:stopping': [];
  // ----- 会话管理事件 -----
  'session:created': [session: import('./session.js').SessionInfo];
  'session:updated': [session: import('./session.js').SessionInfo];
  'session:completed': [session: import('./session.js').SessionInfo];
  'session:deleted': [sessionId: string];
  'session:switched': [sessionId: string];
  // 允许任意字符串 key（运行时安全，类型兜底）
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
  /** 原始输入文本 */
  raw: string;
  /** 跳过安全等级检查（用于工具桥接等已在上层完成检查的场景） */
  skipSafetyCheck?: boolean;
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
  /** 是否同时注册为 AI 工具 (默认 false) */
  asTools?: boolean;
  /**
   * 执行函数
   * @returns 返回字符串表示要回复给用户的文本，返回 void 表示指令自行处理了输出
   */
  action: (ctx: CommandContext) => Promise<string | void>;
}

/** 已注册的指令 */
export interface RegisteredCommand extends CommandDefinition {
  /** 注册此指令的插件名 */
  pluginName: string;
}

/**
 * 插件分组信息 —— 用于 Dashboard 自动分层
 *
 * 由 Agent / Platform 等子系统协调器的 `getPluginGroups()` 返回，
 * WebUI Dashboard 据此将插件归入对应的子系统面板。
 */
export interface PluginGroupInfo {
  /** 分组显示名称 */
  label: string;
  /** 该分组包含的插件 instanceId 列表 */
  plugins: string[];
}
