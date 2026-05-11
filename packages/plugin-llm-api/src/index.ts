// ----- LLM 服务接口 -----
//
// 提供完整的 LLM 抽象 + 能力声明框架。
// 任何需要调用或实现 LLM 服务的插件都应从本包导入相关类型。

import type { Message, ToolDefinition, ToolCall } from '@aalis/core';
import { registerCapabilityProbe } from '@aalis/core';

export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
  provider?: string;
  signal?: AbortSignal;
  think?: boolean;
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

export interface ChatStreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCalls?: ToolCall[];
  done?: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ModelInfo {
  id: string;
  capabilities: LLMCapability[];
  provider?: string;
  contextId?: string;
  contextLength?: number;
}

export interface LLMService {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  getTemperature(): number;
  getMaxTokens(): number;
  getContextLength(): number;
  listModels?(): Promise<ModelInfo[]>;
  getDefaultModelId?(): string | undefined;
}

// ----- LLM 能力声明（capability 框架）-----

export interface LLMCapabilityRegistry {
  Chat: 'chat';
  ToolCalling: 'tool_calling';
  Streaming: 'streaming';
  Vision: 'vision';
  Thinking: 'thinking';
  Router: 'router';
}

export type LLMCapability = LLMCapabilityRegistry[keyof LLMCapabilityRegistry];

export const LLMCapabilities = {
  Chat: 'chat',
  ToolCalling: 'tool_calling',
  Streaming: 'streaming',
  Vision: 'vision',
  Thinking: 'thinking',
  Router: 'router',
} as const satisfies LLMCapabilityRegistry;

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    llm: LLMCapability;
  }
}

// 注册能力↔方法探测器
registerCapabilityProbe('llm', LLMCapabilities.Chat, inst =>
  typeof (inst as { chat?: unknown }).chat === 'function'
    ? true
    : 'LLMService.chat() is required for capability "chat"');

registerCapabilityProbe('llm', LLMCapabilities.Streaming, inst =>
  typeof (inst as { chatStream?: unknown }).chatStream === 'function'
    ? true
    : 'LLMService.chatStream() is required for capability "streaming"');
