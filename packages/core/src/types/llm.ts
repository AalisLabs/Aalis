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
  /** 是否启用扩展思考。设为 false 可显式关闭提供者默认的 think 模式 */
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

/** 模型信息（含能力声明）。router 聚合后的条目会携带 provider/contextId 归属。 */
export interface ModelInfo {
  id: string;
  capabilities: LLMCapability[];
  /** router 聚合时填充（展示用 label 或 instanceId） */
  provider?: string;
  /** router 聚合时填充（用于精确定位提供者） */
  contextId?: string;
}

export interface LLMService {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  getTemperature(): number;
  getMaxTokens(): number;
  /** 模型上下文窗口大小（token 数） */
  getContextLength(): number;
  /** 列出远端可用模型及其能力 */
  listModels?(): Promise<ModelInfo[]>;
  /**
   * 提供者自报默认模型 ID。
   * LLMRouter 在用户未指定 `model` 时可参考此值。
   */
  getDefaultModelId?(): string | undefined;
  /**
   * 同步/异步判断该提供者是否支持指定模型。
   * 实现后可让 LLMRouter 跳过 listModels 枚举（快路径）。
   */
  supportsModel?(modelId: string): boolean | Promise<boolean>;
}

// ----- LLM 能力声明（capability 框架）-----

/**
 * LLM 服务能力注册表
 *
 * 第三方插件可通过 declaration merging 追加新能力：
 *
 * ```ts
 * declare module '@aalis/core' {
 *   interface LLMCapabilityRegistry {
 *     AudioInput: 'audio_input';
 *     FimCompletion: 'fim_completion';
 *   }
 * }
 * ```
 *
 * 然后在自己的 LLM 服务里：
 * ```ts
 * ctx.provide('llm', service, { capabilities: ['chat', 'audio_input'] });
 * ```
 */
export interface LLMCapabilityRegistry {
  /** 基础对话能力（必备） */
  Chat: 'chat';
  /** 支持工具调用 / function calling */
  ToolCalling: 'tool_calling';
  /** 支持流式输出 */
  Streaming: 'streaming';
  /** 支持图像输入（多模态） */
  Vision: 'vision';
  /** 支持扩展思考 / reasoning */
  Thinking: 'thinking';
  /** 路由器 facade（按 model id 查找提供者，不提供 chat） */
  Router: 'router';
}

/** LLM 能力字符串 union（自动包含第三方扩展） */
export type LLMCapability = LLMCapabilityRegistry[keyof LLMCapabilityRegistry];

/**
 * LLM 内置能力常量
 *
 * 用于注册时引用，避免 magic string 拼写错误：
 * ```ts
 * ctx.provide('llm', service, { capabilities: [LLMCapabilities.Chat, LLMCapabilities.Streaming] });
 * ```
 */
export const LLMCapabilities = {
  Chat: 'chat',
  ToolCalling: 'tool_calling',
  Streaming: 'streaming',
  Vision: 'vision',
  Thinking: 'thinking',
  Router: 'router',
} as const satisfies LLMCapabilityRegistry;

// 注册到全局服务能力映射
declare module './capabilities.js' {
  interface ServiceCapabilityMap {
    llm: LLMCapability;
  }
}

// 注册能力↔方法探测器（dev 模式下在 ctx.provide 时校验）
import { registerCapabilityProbe } from './capabilities.js';

registerCapabilityProbe('llm', LLMCapabilities.Chat, inst =>
  typeof (inst as { chat?: unknown }).chat === 'function'
    ? true
    : 'LLMService.chat() is required for capability "chat"');

registerCapabilityProbe('llm', LLMCapabilities.Streaming, inst =>
  typeof (inst as { chatStream?: unknown }).chatStream === 'function'
    ? true
    : 'LLMService.chatStream() is required for capability "streaming"');

// ToolCalling / Vision / Thinking 为参数层能力，由调用方按请求传参判定，不做方法探测。
