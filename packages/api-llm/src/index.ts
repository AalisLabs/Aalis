// ----- LLM 服务接口 -----
//
// 提供完整的 LLM 抽象 + 能力声明框架。
// 任何需要调用或实现 LLM 服务的插件都应从本包导入相关类型。

import type { ToolDefinition } from '@aalis/api-tools';
import type { Events, ProviderEntry, ServiceSelection } from '@aalis/core';
import { defineService } from '@aalis/core';
import type { Message, ToolCall } from '@aalis/schema-message';

export interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  reasoningContent?: string | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /**
     * promptTokens 中由 provider 前缀缓存命中的部分（≤ promptTokens）。
     *
     * 计费意义：命中部分通常远低于常规输入价（DeepSeek 上下文缓存约 1/10）。
     * 不支持或本次无命中的 provider 省略此字段——`undefined` 表示"不可知"，
     * 与 `0`（明确无命中）语义不同，消费方不要用 `?? 0` 抹平二者。
     */
    cachedPromptTokens?: number;
  };
}

/**
 * 工具调用增量进度（非完整 ToolCall，仅用于 UI 提示「正在生成」）。
 * Provider 每收到一个调用的增量就为它 yield 一个 chunk（一帧里有几个调用就各 yield 一个），
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
    /** 见 {@link ChatResponse.usage.cachedPromptTokens} */
    cachedPromptTokens?: number;
  };
}

// ----- per-model service entry（feat/service-granularity） -----
//
// 每个 LLM model 是 ServiceContainer 'llm' 服务名下独立的 entry。
//   - capability 声明 100% 反映该 model 的实际能力（无 router facade 谎言）
//   - `resolveLLMModel(llm, ref, ['vision'])` 按 handle 元数据 `instance.capabilities` 直接命中合适 model
//     （消费方过滤，不是 DI 选择）
//   - ChatModelRequest 不含 model/provider 字段：entry 已绑定具体 (provider, model)

/** Per-model chat request：不再含 model/provider —— entry 已绑定。 */
export interface ChatModelRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * 深度思考的档位：模型声明的 {@link LLMModel.thinking} 里某一档的 id；没带时按模型的默认档。模型不能调（没声明档位）时
   * 不带，带了模型没有的档位提供者拒绝（见 {@link requestedThinking}）
   */
  think?: string;
  /**
   * 消息里的图片是否为必需载荷。缺省 false。
   *
   * false（顺手带图，如把群消息附件一并递给主模型）：图片取不到时 provider 应
   * warn 并按纯文本继续，不打断这一轮。
   * true（图片就是全部内容，如视觉识别）：一张都取不到就该抛——否则视觉模型只
   * 看得到 prompt 里的占位文字，会照着编出一段描述，而调用方拿到非空内容便记成
   * 成功，失败被伪装成幻觉。
   *
   * 这个判断只有调用方做得了，provider 无从区分两种语义。
   */
  requireImages?: boolean;
  /** 这次调用做什么用，记账用：给人看的短语，如「对话」「摘要」「识图」「子任务」。调用方填，可以缺 */
  purpose?: string;
  /** 这次调用所在的会话，记账用。调用方填，可以缺 */
  sessionId?: string;
  /** 调用方的插件实例，记账用：经 `llm` 的绑定接口调用时按调用方这次激活填上，调用方自己填的不算 */
  caller?: string;
}

/**
 * 单个 LLM model 的 service entry。
 *
 * 一个 LLM provider 插件实例（如 plugin-llm-openai）按其发现的模型列表，
 * 在 apply() 期间为**每个 model 单独**调用 `provide(llm, modelHandle, { entryId })`，
 * model handle 上的 capabilities 字段诚实地反映该 model 的能力。
 *
 * 调用约定：
 *   const handle = resolveLLMModel(llm, ref, ['vision'])?.instance;
 *   await handle?.chat({ messages });   // entry 已知道是哪个 model
 *
 * 选择默认 model：`services.prefer('llm', '<provider>/<model>')` 或宿主配置的 `servicePreferences`。
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

  /**
   * 该 model 的能力元数据（chat/vision/tool_calling/audio/video…）。
   * 这是「模型能干啥」的领域数据——供 media 发现可处理图/音/视的模型、前端下拉展示与过滤用，
   * **不是** DI 选择机制（服务选择一律走配置 + 按名解析）。provider 注册时填。
   */
  readonly capabilities: readonly LLMCapability[];

  /** 能调深度思考的模型允许的档位；不能调的模型不声明 */
  readonly thinking?: ThinkingLevels;

  chat(request: ChatModelRequest): Promise<ChatResponse>;
  chatStream?(request: ChatModelRequest): AsyncIterable<ChatStreamChunk>;

  /**
   * 让管理面板（webui）触发该 provider 重新探测远端模型列表并 diff 当前已注册 entries。
   *
   * - **远端动态发现型** provider（Ollama / OpenAI）应实现：重新拉取模型列表端点（如 `{baseUrl}/models`）等
   *   并合并 `customModels`、按 model id 增删 `'llm'` entries。
   * - **静态契约型** provider（如 DeepSeek）可不实现。webui 的"刷新"按钮照常显示，对没有 refresh 的
   *   provider 由 webui-server 返回 404，提示该 provider 不支持运行时刷新。
   * - 同一 provider 下所有 model entries 共享同一份 refresh 闭包；webui 按 provider 的 contextId（即各 entry 的
   *   `providerId`，不是 entry 自己的 contextId `<provider>/<model>`）找到该 provider 的任一 entry，调一次即可。
   * - **失败语义**：发现失败（不可达、超时、非 2xx、响应不是 JSON 或不是模型列表）时抛错，消息带原因；已注册的
   *   entries 原样保留、不增删——不得把失败当成远端没有模型而注销自动发现的条目。经停用或停机中止时同样抛错。
   */
  refresh?(): Promise<{ added: string[]; removed: string[]; total: number }>;

  /**
   * 查服务商账户的余额（可选）：服务商有余额接口才实现，同一 provider 下所有 model entries 共享同一份，按 providerId
   * 找任一 entry 调一次即可。查不到（不可达、超时、认证失败、回应认不出）时抛错，消息带原因
   */
  balance?(signal?: AbortSignal): Promise<LLMBalance[]>;
}

/** 服务商账户的余额：一个币种一项 */
export interface LLMBalance {
  readonly currency: string;
  readonly amount: number;
}

// ----- 记账 -----

/**
 * 一次模型调用的用量，`llm:usage` 事件的内容。cachedTokens 是 inputTokens 里前缀缓存命中的部分，服务商不报时没有
 * （与 0 不同）；caller、sessionId、purpose 取请求里的同名字段
 */
export interface LLMUsageEvent {
  /** 服务商：模型所属 provider 的实例 id（{@link LLMModel.providerId}） */
  provider: string;
  model: string;
  caller?: string;
  sessionId?: string;
  purpose?: string;
  inputTokens: number;
  cachedTokens?: number;
  outputTokens: number;
}

declare module '@aalis/core' {
  interface AalisEvents {
    /** 一次模型调用结束、服务商报了用量：发射方是服务商登记的 {@link metered} 模型，消费方如记账插件 */
    'llm:usage': [usage: LLMUsageEvent];
  }
}

/**
 * 换掉 chat 与 chatStream，其余字段与方法照原样转给 model。逐个字段列出，LLMModel 加了字段这里漏写时编译报错
 * （chatStream 要写出来，没有时是 undefined）
 */
function withCalls(model: LLMModel, calls: { chat: LLMModel['chat']; chatStream: LLMModel['chatStream'] }): LLMModel {
  const refresh = model.refresh?.bind(model);
  const balance = model.balance?.bind(model);
  return {
    id: model.id,
    providerId: model.providerId,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities,
    thinking: model.thinking,
    ...calls,
    refresh,
    balance,
  } satisfies Record<keyof LLMModel, unknown>;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * 给登记的模型包上记账：chat 拿到用量、chatStream 结束时报过用量（取最后一次报的），就发一次 `llm:usage`，不等监听器。
 * 服务商登记模型时套一层，`provide(llm, metered(model, events), { entryId })`，自己的 chat 与 chatStream 不用管记账。
 * 服务商回的数运行时没人核，在这里规整一次：没报用量、输入或输出不是非负有限数的调用不记；缓存命中不是非负有限数时当没报，
 * 比输入多时截到输入
 */
export function metered(model: LLMModel, events: Pick<Events, 'emit'>): LLMModel {
  const report = (request: ChatModelRequest, usage: ChatResponse['usage']) => {
    if (!usage || !isCount(usage.promptTokens) || !isCount(usage.completionTokens)) return;
    const cached = usage.cachedPromptTokens;
    void events.emit('llm:usage', {
      provider: model.providerId,
      model: model.id,
      caller: request.caller,
      sessionId: request.sessionId,
      purpose: request.purpose,
      inputTokens: usage.promptTokens,
      ...(isCount(cached) ? { cachedTokens: Math.min(cached, usage.promptTokens) } : {}),
      outputTokens: usage.completionTokens,
    });
  };
  const { chatStream } = model;
  return withCalls(model, {
    async chat(request) {
      const response = await model.chat(request);
      report(request, response.usage);
      return response;
    },
    chatStream:
      chatStream &&
      async function* (request) {
        let usage: ChatResponse['usage'];
        try {
          for await (const chunk of chatStream.call(model, request)) {
            if (chunk.usage) usage = chunk.usage;
            yield chunk;
          }
        } finally {
          report(request, usage);
        }
      },
  });
}

// ----- 深度思考的档位 -----

/** 一个思考档位：id 是提供者自己的写法（请求的 think 填它），label 给人看 */
export interface ThinkingLevel {
  readonly id: string;
  readonly label: string;
}

/**
 * 模型允许的思考档位：levels 由浅到深排、至少两档（开关型就是「关、开」两档），default 是请求没带档位时用的那一档，
 * 须是 levels 里的一个。档位由各提供者按自己的协议定义并翻成线上字段，不做跨服务商的统一档位表
 */
export interface ThinkingLevels {
  readonly levels: readonly ThinkingLevel[];
  readonly default: string;
}

/**
 * 请求带的思考档位：没带时为 undefined；带了却不在模型声明的档位里（含模型不能调时带了档位）时抛错。提供者把档位翻成
 * 线上字段之前先过它，调用方要先按模型声明的档位选
 */
export function requestedThinking(
  model: Pick<LLMModel, 'id' | 'thinking'>,
  request: Pick<ChatModelRequest, 'think'>,
): string | undefined {
  const { think } = request;
  if (think !== undefined && !model.thinking?.levels.some(level => level.id === think)) {
    throw new Error(`模型 ${model.id} 没有思考档位「${think}」`);
  }
  return think;
}

/** 模型最浅的一档：机械任务（摘要、标题、结构化提取）要压低思考时带它；模型不能调时为 undefined */
export function lightestThinking(model: Pick<LLMModel, 'thinking'>): string | undefined {
  return model.thinking?.levels[0]?.id;
}

// ----- LLM 能力声明（capability 框架）-----

export interface LLMCapabilityRegistry {
  Chat: 'chat';
  ToolCalling: 'tool_calling';
  Streaming: 'streaming';
  Vision: 'vision';
  /** 会思考（产出思考内容）；能不能按请求调档看 {@link LLMModel.thinking} */
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

// SchemaFieldTypes 属配置表单词汇,扩展点随词汇一起住在 @aalis/schema-config
// （空 import 使本文件对其构成 module augmentation 而非 ambient 声明）。
import type {} from '@aalis/schema-config';

declare module '@aalis/schema-config' {
  interface SchemaFieldTypes {
    /**
     * LLM 模型引用：值为 {@link ModelRef}，前端渲染为
     * 联动 select（provider 列表来自 `/api/models/llm` 的 contextId 聚合；
     * model 列表由所选 provider 决定）。运行时由消费方用
     * `resolveLLMModel(caps.llm, value, caps)` 解析。parseConfig 不校验这个类型的取值，除 `''`（未选）外原样透传。
     */
    'llm-ref': ModelRef;
  }
}

// ----- LLM model entry 解析助手 -----

/**
 * LLM model 引用：`{ provider, model }` 二元组。
 * 由 ConfigSchema type='llm-ref' 字段统一编辑，YAML 中以嵌套对象形式存储。
 */
export interface ModelRef {
  /** provider 的 contextId（plugin instanceId，如 `@aalis/plugin-llm-openai:main`）。 */
  provider?: string;
  /** model id（provider 内唯一，如 `gpt-4o`）。 */
  model?: string;
}

/**
 * 按能力过滤 llm 的提供者条目 —— 能力源为模型自带的元数据 `use.capabilities`，
 * 不是 core 的能力选择（服务选择走配置 + 按名解析）。
 */
function listLLMEntries(
  source: Pick<ServiceSelection<LLMModel>, 'list'>,
  caps?: readonly LLMCapability[],
): ProviderEntry<LLMModel>[] {
  const all = source.list();
  if (!caps || caps.length === 0) return all;
  return all.filter(e => caps.every(c => (e.use.capabilities ?? []).includes(c)));
}

/**
 * 列出（可按能力过滤的）llm 提供者条目，供 `/model` 列表与前端下拉用。
 * 能力源为 `use.capabilities`（model 自带元数据），是展示/列举用途，非 DI 选择。
 */
export function listLLMModels(
  source: Pick<ServiceSelection<LLMModel>, 'list'>,
  opts?: { caps?: readonly LLMCapability[] },
): ProviderEntry<LLMModel>[] {
  return listLLMEntries(source, opts?.caps);
}

/**
 * 在 `list()` 上把 ref 解析为最匹配的提供者条目。
 *
 * 解析顺序（命中即返回）：
 * 1. ref.provider + ref.model 都有 → 直接拼接条目 id `${provider}/${model}` 查找
 * 2. 仅 ref.provider → 在该 provider 名下的条目中（按 capability 过滤后）取首个
 * 3. 仅 ref.model → 按模型自己的 `use.id` 严格匹配
 * 4. 都为空 → 取首个满足 capability 的条目（本插件选中的那一家在前，其余按挑选规则排）
 *
 * requiredCaps 按模型元数据 `use.capabilities` 过滤。找不到返回 undefined。
 */
export function resolveLLMModel(
  source: Pick<ServiceSelection<LLMModel>, 'list'>,
  ref?: ModelRef | null,
  requiredCaps?: LLMCapability[],
): ProviderEntry<LLMModel> | undefined {
  const all = listLLMEntries(source, requiredCaps);
  if (ref?.provider && ref?.model) return all.find(e => e.id === `${ref.provider}/${ref.model}`);
  if (ref?.provider) return all.find(e => e.id.startsWith(`${ref.provider}/`));
  if (ref?.model) return all.find(e => e.use.id === ref.model);
  return all[0];
}

// ----- 服务描述符（按激活绑定）-----

/**
 * 调用型。业务层在请求里填上调用方这次激活的实例 id（{@link ChatModelRequest.caller}），其余成员照原样转发。
 * 按模型选就是按条目 id 选：`caps.llm.of('<provider>/<model>')`；按能力筛遍历 `caps.llm.list()`，读条目的 `use.capabilities`
 */
export const llm = defineService<LLMModel, LLMModel>('llm', port =>
  // chatStream 是可选成员：取的时候才看选中的那一家有没有
  Object.create(port.provider, {
    chat: { value: (request: ChatModelRequest) => port.provider.chat({ ...request, caller: port.id }) },
    chatStream: {
      get: () => {
        const chatStream = port.provider.chatStream;
        return chatStream && ((request: ChatModelRequest) => chatStream({ ...request, caller: port.id }));
      },
    },
  }),
);
