// ===== 共享类型定义 =====

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
}

// ----- LLM 服务接口 -----

export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
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
  add(vector: number[], metadata: Record<string, unknown>): void;
  /** 搜索最近邻，返回 [分数, 元数据][] */
  search(queryVector: number[], topK: number): VectorSearchResult[];
  /** 当前存储的向量总数 */
  size(): number;
  /** 持久化（由调用方或 dispose 触发） */
  save(): void;
}

// ----- 人格服务接口 -----

export interface PersonaService {
  getSystemPrompt(): string;
  getPersonaName(): string;
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

// ----- 配置 Schema (internal-framework-style) -----

export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select';

export interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  /** select 类型的静态选项 */
  options?: Array<{ label: string; value: string | number }>;
  /** select 类型的动态选项来源：填服务名 (如 'llm', 'embedding')，
   *  运行时调用 service.listModels() 获取 */
  dynamicOptions?: string;
}

export interface SchemaGroup {
  label?: string;
  fields: Record<string, SchemaField>;
}

/** 配置 Schema：顶层 key 可以是字段或分组 */
export type ConfigSchema = Record<string, SchemaField | SchemaGroup>;

// ----- 事件类型 -----

export interface AalisEvents {
  'message:received': [message: IncomingMessage];
  'message:send': [message: OutgoingMessage];
  'message:stream': [chunk: StreamChunkMessage];
  'tool:execute': [info: ToolExecuteMessage];
  'service:registered': [name: string, capabilities: string[]];
  'service:unregistered': [name: string];
  'plugin:loaded': [name: string];
  'plugin:unloaded': [name: string];
  'ready': [];
  'dispose': [];
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
 * 支持的 hook 点:
 * - message:before     — 拦截用户消息（可修改或丢弃）
 * - llm-call:before    — 修改发送给 LLM 的请求
 * - llm-call:after     — 处理 LLM 返回结果
 * - tool-call:before   — 拦截工具调用
 * - tool-call:after    — 处理工具执行结果
 * - response:before    — 在发送回复前修改内容
 */
export interface HookContextMap {
  'message:before': { message: IncomingMessage };
  'llm-call:before': { messages: Message[]; tools: ToolDefinition[] };
  'llm-call:after': { response: ChatResponse; messages: Message[] };
  'tool-call:before': { name: string; args: Record<string, unknown>; toolCallContext: ToolCallContext };
  'tool-call:after': { name: string; result: string; toolCallContext: ToolCallContext };
  'response:before': { content: string; sessionId: string };
}
