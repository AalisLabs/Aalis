// ----- LLM 服务接口 -----

import type { Message, ToolDefinition, ToolCall } from './core.js';

export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** 覆盖模型（不指定则使用服务默认模型） */
  model?: string;
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

/** 模型信息（含能力声明） */
export interface ModelInfo {
  id: string;
  capabilities: string[];
}

export interface LLMService {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  getTemperature(): number;
  getMaxTokens(): number;
  getMaxToolIterations(): number;
  /** 模型上下文窗口大小（token 数） */
  getContextLength(): number;
  /** 列出远端可用模型及其能力 */
  listModels?(): Promise<ModelInfo[]>;
}
