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

/** 模型信息（含能力声明） */
export interface ModelInfo {
  id: string;
  capabilities: LLMCapability[];
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

// ----- LLM 路由服务接口（plugin-llm-router 提供）-----

/** 聚合后的模型条目（携带提供者标识） */
export interface AggregatedModelInfo {
  id: string;
  capabilities: LLMCapability[];
  provider: string;
  contextId: string;
}

/**
 * LLM 路由服务 —— 由 plugin-llm-router 提供。
 *
 * 同名 facade 模式（与 plugin-storage-router 对齐）：路由器注册为 'llm' 服务的一个
 * 普通 provider，同时带 'router' capability。它对外实现 LLMService，内部聚合并转发到
 * 其他同名 LLM provider。router 只静态声明自身真实提供的 facade 能力；vision / tool_calling
 * 等后端能力仍由真实 provider 暴露，并由 router 在请求转发时动态选择。
 *
 * 调用约定（重要）：
 * - **绝大多数调用方只应使用 `LLMService`**：`getService<LLMService>('llm')?.chat({ model, ... })`
 *   即可。router.chat 内部会按 `request.model` 路由到拥有该模型的 provider，并按消息内容
 *   （images / tools / think）自动校验 provider capability，失败时抛出明确错误。
 * - 仅当确实需要"枚举所有可用模型"（例如 WebUI 模型选择器、配置面板）时才使用本接口。
 *
 * `resolveModelProvider` / `getModelProviderMap` 等内部路由细节**不再**作为公共 API 暴露——
 * 调用方手动解析 provider 再 `instance.chat(...)` 是反模式（绕开 facade 重复 router 已做的事），
 * 应改为 `llm.chat({ model })` 让 router 自己路由。
 */
export interface LLMRouterService {
  /** 聚合所有 LLM 提供者的模型列表（带 provider 来源信息） */
  listAllModels(): Promise<AggregatedModelInfo[]>;
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
