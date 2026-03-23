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

export interface ModelInfo {
  id: string;
  name?: string;
}

export interface LLMService {
  chat(request: ChatRequest): Promise<ChatResponse>;
  listModels?(): Promise<ModelInfo[]>;
  getModel?(): string;
  setModel?(model: string): void;
}

// ----- 记忆服务接口 -----

export interface MemoryService {
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
}

// ----- 人格服务接口 -----

export interface PersonaService {
  getSystemPrompt(): string;
  getPersonaName(): string;
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

// ----- 事件类型 -----

export interface AalisEvents {
  'message:received': [message: IncomingMessage];
  'message:send': [message: OutgoingMessage];
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
