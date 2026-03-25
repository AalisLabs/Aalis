// ===== 共享类型定义 =====

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
}

export interface IncomingMessage {
  content: string;
  sessionId: string;
  platform: string;
  userId?: string;
  images?: string[]; // base64 or URL
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
}

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;
  pluginName: string;
  /** 安全级别 (默认 'safe') */
  safety?: SafetyLevel;
  /** 最低权限等级 (默认 1) */
  authority?: number;
}

/** 工具摘要（不含 handler，用于搜索展示） */
export interface ToolSummary {
  name: string;
  description: string;
  authority: number;
  safety: SafetyLevel;
}

// ----- LLM 服务接口 -----

export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** 中止信号，用于取消正在进行的 LLM 调用 */
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  reasoningContent?: string | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** 流式响应的单个 chunk */
export interface ChatStreamChunk {
  /** 增量内容片段 */
  contentDelta?: string;
  /** 增量思考内容片段 */
  reasoningDelta?: string;
  /** 工具调用（仅在流结束时出现） */
  toolCalls?: ToolCall[];
  /** 是否结束 */
  done?: boolean;
  /** 用量统计（仅在最后一个 chunk 可能包含） */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMService {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  getTemperature(): number;
  getMaxTokens(): number;
  getMaxToolIterations(): number;
  /** 模型上下文窗口大小（token 数） */
  getContextLength(): number;
  /** 列出远端可用模型（用于前端下拉框）*/
  listModels?(): Promise<string[]>;
}

// ----- 记忆服务接口 -----

export interface MemoryService {
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
}

// ----- 向量数据库服务接口 -----

/** 向量搜索结果条目 */
export interface VectorSearchResult {
  /** 余弦相似度分数 */
  score: number;
  /** 存储时附带的元数据 */
  metadata: Record<string, unknown>;
}

/** 向量数据库服务——由 vectorstore 插件提供 */
export interface VectorStoreService {
  /** 添加一条向量及其元数据 */
  add(vector: number[], metadata: Record<string, unknown>): Promise<void>;
  /** 搜索最近邻，返回 [分数, 元数据][] */
  search(queryVector: number[], topK: number): Promise<VectorSearchResult[]>;
  /** 当前存储的向量总数 */
  size(): Promise<number>;
  /** 清空所有向量数据 */
  clear(): Promise<void>;
  /** 持久化（由调用方或 dispose 触发） */
  save(): Promise<void>;
}

// ----- 人格服务接口 -----

/** 输出格式中单个字段的定义 */
export interface OutputFormatField {
  /** 字段用途描述（写入 system prompt 供 LLM 理解） */
  description: string;
  /** 是否为发送给用户的回复字段（有且仅有一个） */
  reply?: boolean;
}

/** 角色卡定义的结构化输出格式 */
export interface OutputFormat {
  /** 字段定义表：key = JSON 字段名 */
  fields: Record<string, OutputFormatField>;
  /** 回复字段名（自动推断，取 reply: true 的那个 key） */
  replyField: string;
}

export interface PersonaService {
  getSystemPrompt(): string;
  getPersonaName(): string;
  /** 获取角色卡定义的结构化输出格式，无定义时返回 undefined */
  getOutputFormat?(): OutputFormat | undefined;
  /** 列出可用的人设卡（用于前端下拉框） */
  listModels?(): Promise<string[]>;
}

// ----- Embedding 服务接口 -----

export interface EmbeddingService {
  /** 将文本转为向量 */
  embed(text: string): Promise<number[]>;
  /** 列出远端可用模型（用于前端下拉框）*/
  listModels?(): Promise<string[]>;
}

// ----- Agent 服务接口 -----

/**
 * Agent 服务 —— 对话编排引擎
 *
 * 负责接收用户消息并编排完整的对话流程：
 * 组装系统提示、加载历史、调用 LLM、执行工具调用循环、发出回复。
 *
 * 默认由 plugin-agent-default 提供。
 * 外部插件可以注册自己的 AgentService 来完全接管或扩展对话编排逻辑。
 */
export interface AgentService {
  /** 处理一条传入消息，完成完整的对话循环 */
  handleMessage(message: IncomingMessage): Promise<void>;
  /** 中止指定会话的当前生成（可选实现） */
  abort?(sessionId: string): void;
}

// ----- 平台适配器接口 -----

/** 单个平台连接的状态 */
export interface PlatformConnection {
  /** 连接唯一标识 */
  id: string;
  /** 平台名称 (如 'cli', 'webui', 'onebot') */
  platform: string;
  /** 机器人自身 ID（仅协议平台使用） */
  selfId?: string;
  /** 连接状态 */
  status: 'online' | 'offline' | 'connecting';
  /** 额外信息 (如 OneBot 的实现名称、版本等) */
  detail?: Record<string, unknown>;
}

/**
 * 平台适配器 —— 每个平台插件实现此接口
 *
 * 提供统一的平台抽象，使核心可以查询所有已接入平台的连接状态，
 * 也使其他插件可以向指定平台发送消息。
 *
 * 第三方平台接入只需实现此接口并通过 `ctx.provide('platform', adapter)` 注册即可。
 */
export interface PlatformAdapter {
  /** 适配器显示名称 */
  adapterName: string;
  /** 平台标识 (如 'cli', 'webui', 'onebot', 'telegram', 'discord') */
  platform: string;
  /** 获取当前所有连接 */
  getConnections(): PlatformConnection[];
  /** 向指定 sessionId 发送纯文本消息 */
  sendMessage(sessionId: string, content: string): Promise<void>;
  /**
   * 适配器是否至少有一个可用连接
   * 默认实现：检查 getConnections() 中是否有 status === 'online'
   */
  isReady?(): boolean;
}

// ----- WebUI 服务接口 -----

/**
 * WebUI 服务 —— Web 管理后台
 *
 * 负责启动 HTTP 服务器，提供 REST API（插件管理、配置、权限等）
 * 和 WebSocket（消息/日志推送），同时托管前端静态文件。
 *
 * 核心要求此服务必须运行。
 * 默认由 plugin-webui 提供，第三方可替换整个实现或仅替换前端部分。
 */
export interface WebUIService {
  /** 获取 HTTP 服务监听端口 */
  getPort(): number;
  /** 获取 HTTP 服务监听地址 */
  getHost(): string;
  /**
   * 设置前端静态文件目录
   * 允许外部插件在运行时替换前端
   */
  setClientDir?(dir: string): void;
}

// ----- CLI 服务接口 -----

/**
 * CLI 服务 —— 命令行交互界面
 *
 * 提供终端 REPL 交互，支持指令输入和对话。
 * 核心要求此服务必须运行。
 * 默认由 plugin-cli 提供，第三方可提供自己的 CLI 实现。
 */
export interface CLIService {
  /** 获取当前会话 ID */
  getSessionId(): string;
  /** CLI 是否正在运行 */
  isRunning(): boolean;
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

// ----- 插件接口 -----

export interface PluginMeta {
  name: string;
  inject?: InjectDeclaration;
  provides?: string[];
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

export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect';

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

/**
 * Hook 定义：插件可以用中间件拦截和修改 Agent 核心流程
 *
 * 中间件不调用 next() 即可中断整个流程（包括 defaultAction），
 * 这是拦截消息的标准做法，不需要额外的 skip 标志。
 *
 * 第三方插件可通过 TypeScript declaration merging 扩展：
 * ```ts
 * declare module '@aalis/core' {
 *   interface HookContextMap {
 *     'schedule:before': { jobId: string; cron: string };
 *   }
 * }
 * ```
 */
export interface HookContextMap {
  'message:before': { message: IncomingMessage; metadata: Record<string, unknown> };
  'message:after': { message: IncomingMessage; response: string; sessionId: string; metadata: Record<string, unknown> };
  'llm-call:before': { messages: Message[]; tools: ToolDefinition[] };
  'llm-call:after': { response: ChatResponse; messages: Message[] };
  'tool-call:before': { name: string; args: Record<string, unknown>; toolCallContext: ToolCallContext };
  'tool-call:after': { name: string; result: string; toolCallContext: ToolCallContext };
  'response:before': { content: string; sessionId: string };
  // 允许任意字符串 key（运行时安全，类型兜底）
  [key: string]: Record<string, unknown>;
}

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
