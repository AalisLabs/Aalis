// ----- LLM 服务接口 -----
//
// 提供完整的 LLM 抽象 + 能力声明框架。
// 任何需要调用或实现 LLM 服务的插件都应从本包导入相关类型。

import type { Context } from '@aalis/core';
import { registerCapabilityProbe } from '@aalis/core';
import type { Message, ToolCall } from '@aalis/plugin-message-api';
import type { ToolDefinition } from '@aalis/plugin-tools-api';

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
  /**
   * Capability 字符串数组。注册时来自 ServiceContainer，因此使用宽松的 string[]
   * 而不是 LLMCapability[]，便于跨插件共享（自定义 capability 也能照常上送给前端）。
   */
  capabilities: string[];
  provider?: string;
  contextId?: string;
  contextLength?: number;
}

// ----- per-model service entry（feat/service-granularity） -----
//
// 每个 LLM model 是 ServiceContainer 'llm' 服务名下独立的 entry。
//   - capability 声明 100% 反映该 model 的实际能力（无 router facade 谎言）
//   - `getService('llm', ['vision'])` 直接命中合适 model 而非绕过路由
//   - ChatModelRequest 不含 model/provider 字段：entry 已绑定具体 (provider, model)

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
  /**
   * Provider 建议的最大输出 token（per-model 上限提示）。可选。
   * Agent 用于计算 tokenBudget 预留：`tokenBudget ≈ contextLength - maxOutputTokens - safetyMargin`。
   * 调用方未在 ChatModelRequest 显式指定时，Provider 会以此为默认。
   */
  readonly maxOutputTokens?: number;

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
  /** 原生音频理解（能接收音频输入，返回描述/问答，如 Gemini / GPT-4o-audio / Gemma 4 E系列） */
  Audio: 'audio';
  /** 专门的语音转文本能力（如 Whisper API）。与 Audio 互独立。 */
  AudioTranscription: 'audio_transcription';
  /** 原生视频理解（能接收视频 bytes，如 Gemini）。OpenAI Vision 是逐帧，不在此列。 */
  Video: 'video';
}

export type LLMCapability = LLMCapabilityRegistry[keyof LLMCapabilityRegistry];

export const LLMCapabilities = {
  Chat: 'chat',
  ToolCalling: 'tool_calling',
  Streaming: 'streaming',
  Vision: 'vision',
  Thinking: 'thinking',
  Audio: 'audio',
  AudioTranscription: 'audio_transcription',
  Video: 'video',
} as const satisfies LLMCapabilityRegistry;

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    llm: LLMCapability;
  }
}

// 注册能力↔方法探测器
registerCapabilityProbe('llm', LLMCapabilities.Chat, inst =>
  typeof (inst as { chat?: unknown }).chat === 'function' ? true : 'LLMModel.chat() is required for capability "chat"',
);

registerCapabilityProbe('llm', LLMCapabilities.Streaming, inst =>
  typeof (inst as { chatStream?: unknown }).chatStream === 'function'
    ? true
    : 'LLMModel.chatStream() is required for capability "streaming"',
);

// ----- LLM model entry 解析助手 -----

/** ServiceContainer 中一个 'llm' entry 的完整快照（与 ctx.getAllServices 返回的形状一致）。 */
export interface LLMModelEntry {
  instance: LLMModel;
  contextId: string;
  /** entry 上声明的能力集（核心层为 string[]，LLM 域内取值范围为 LLMCapability）。 */
  capabilities: string[];
  label?: string;
}

/**
 * LLM model 引用：`{ provider, model }` 二元组。
 * 由 ConfigSchema type='llm-ref' 字段统一编辑，YAML 中以嵌套对象形式存储。
 */
export interface ModelRef {
  /** provider 的 contextId（plugin instanceId，如 `@aalis/plugin-openai:main`）。 */
  provider?: string;
  /** model id（provider 内唯一，如 `gpt-4o`）。 */
  model?: string;
}

/**
 * 把 ref 解析为最匹配的 LLMModel entry。
 *
 * 解析顺序（命中即返回）：
 * 1. ref.provider + ref.model 都有 → 直接拼接 entryId `${provider}/${model}` 查找
 * 2. 仅 ref.provider → 在该 provider 名下 entries 中按 capability 过滤后取首个
 * 3. 仅 ref.model → 全局 'llm' entries 按 instance.id 严格匹配
 * 4. 都为空 → `ctx.getService('llm', requiredCaps)` 取第一个匹配 capability 的 entry
 *
 * 找不到时返回 undefined（调用方决定是抛错还是退化）。
 */
export function resolveLLMModel(
  ctx: Context,
  ref?: ModelRef | null,
  requiredCaps?: LLMCapability[],
): LLMModelEntry | undefined {
  // Case 1: 完整 ref → 直查 entryId
  if (ref?.provider && ref?.model) {
    const entryId = `${ref.provider}/${ref.model}`;
    const all = ctx.getAllServices<LLMModel>('llm', requiredCaps);
    return all.find(e => e.contextId === entryId);
  }

  // Case 2: 仅 provider → 该 provider 下首个匹配 cap 的
  if (ref?.provider) {
    const all = ctx.getAllServices<LLMModel>('llm', requiredCaps);
    return all.find(e => e.contextId.startsWith(`${ref.provider}/`));
  }

  // Case 3: 仅 model → 跨 provider 按 instance.id 匹配
  if (ref?.model) {
    const all = ctx.getAllServices<LLMModel>('llm', requiredCaps);
    return all.find(e => e.instance.id === ref.model);
  }

  // Case 4: 默认 → 取首个匹配 cap 的（preference / priority / 注册顺序）
  const all = ctx.getAllServices<LLMModel>('llm', requiredCaps);
  return all[0];
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    llm: LLMModel;
  }
}
