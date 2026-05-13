// ----- LLM 服务接口 -----
//
// 提供完整的 LLM 抽象 + 能力声明框架。
// 任何需要调用或实现 LLM 服务的插件都应从本包导入相关类型。

import { registerCapabilityProbe } from '@aalis/core';
import type { Message, ToolCall } from '@aalis/plugin-message-api';
import type { ToolDefinition } from '@aalis/plugin-tools-api';

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

/**
 * 工具调用增量进度（非完整 ToolCall，仅用于 UI 提示「正在生成」）。
 * Provider 在每收到 tool_call 的 SSE delta 时 yield 一个 chunk，
 * 让上层可以渲染进度条而不必等整段 tool_calls 累积完。
 */
export interface ToolCallProgress {
  /** 工具调用在本轮中的索引（OpenAI 协议里的 tool_calls[i].index） */
  index: number;
  /** 当前已确定的函数名（首个 delta 之后即可获得） */
  name: string;
  /** 已累积的 arguments JSON 字符数（不含 name），用于显示进度 */
  charsAccumulated: number;
}

export interface ChatStreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCalls?: ToolCall[];
  /** 工具调用生成进度（与 toolCalls 互斥：前者是增量提示，后者是最终结果） */
  toolCallProgress?: ToolCallProgress;
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

// ----- per-model service entry（feat/service-granularity 引入） -----
//
// **新模型**：每个 LLM model 是 ServiceContainer 'llm' 服务名下独立的 entry。
//   - capability 声明 100% 反映该 model 的实际能力（无 router facade 谎言）
//   - `getService('llm', ['vision'])` 直接命中合适 model 而非绕过路由
//   - 移除了 ChatRequest.model/provider 字段：entry 已绑定具体 (provider, model)
//
// 旧 LLMService 接口仍在，给迁移期保留，将在 service-granularity 切换完成后删除。

/** Per-model chat request：不再含 model/provider —— entry 已绑定。 */
export interface ChatModelRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  think?: boolean;
}

/**
 * 单个 LLM model 的 service entry。
 *
 * 一个 LLM provider 插件实例（如 plugin-openai）会按其 listModels() 结果
 * 在 apply() 期间为**每个 model 单独**调用 `ctx.provide('llm', modelHandle, {...})`，
 * capabilities 数组诚实地反映该 model 的能力。
 *
 * 调用约定：
 *   const handle = ctx.getService<LLMModel>('llm', ['vision']);
 *   await handle?.chat({ messages });   // entry 已知道是哪个 model
 *
 * 选择 default model：通过 ServiceContainer.setPreference('llm', preferredContextId)
 * 或 persona.yaml 的 defaultServices 配置（见 plugin-author-guide §11）。
 */
export interface LLMModel {
  /** model id（provider 内唯一，如 'gpt-4o'）。来源：provider plugin 注册时填入。 */
  readonly id: string;
  /** 该 model 所属 provider 的 contextId（即 plugin instanceId）。 */
  readonly providerId: string;
  /** 上下文窗口 tokens。用于上层做 prompt 截断决策。 */
  readonly contextLength: number;

  chat(request: ChatModelRequest): Promise<ChatResponse>;
  chatStream?(request: ChatModelRequest): AsyncIterable<ChatStreamChunk>;
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
    : 'LLMService.chat() is required for capability "chat"',
);

registerCapabilityProbe('llm', LLMCapabilities.Streaming, inst =>
  typeof (inst as { chatStream?: unknown }).chatStream === 'function'
    ? true
    : 'LLMService.chatStream() is required for capability "streaming"',
);

// ----- ModelRef 编解码（cleanup-9 从 core 迁入） -----
export type { ModelRef } from './model-ref.js';
export { formatModelRef, parseModelRef } from './model-ref.js';
