import type { ConfigSchema, Context, Message, ToolCall, ToolDefinition } from '@aalis/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMCapability,
  LLMService,
  ModelInfo,
} from '@aalis/plugin-llm-api';
import { LLMCapabilities } from '@aalis/plugin-llm-api';

// ===== 插件元数据 =====

/** 已知的内容审查错误关键词 */
const CONTENT_FILTER_PATTERNS = [
  'content exists risk',
  'content_filter',
  'content_policy',
  'sensitive content',
  'risk control',
];

/**
 * 剥离 DeepSeek 模型泄漏的 DSML（DeepSeek Markup Language）标记
 *
 * 思考模型有时会在 content 中直接输出 <｜DSML｜function_calls>...</｜DSML｜function_calls> 标记
 * 而非正确走 API 的 tool_calls 通道，导致 JSON 解析失败。
 */
const DSML_PATTERN = /<[｜|]DSML[｜|][\s\S]*$/;
function stripDSML(content: string): string {
  return content.replace(DSML_PATTERN, '').trimEnd();
}

/** 解析 API 错误，对内容审查类错误返回友好提示 */
function parseApiError(provider: string, status: number, body: string): string {
  const lower = body.toLowerCase();
  if (status === 400 && CONTENT_FILTER_PATTERNS.some(p => lower.includes(p))) {
    return `${provider} 拒绝了此次请求（内容安全策略），请尝试换一个话题或缩短上下文`;
  }
  return `${provider} API 错误 (${status}): ${body}`;
}

export const name = '@aalis/plugin-deepseek';
export const displayName = 'DeepSeek';
export const subsystem = 'llm';
export const provides = ['llm'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, description: 'DeepSeek API 密钥' },
  baseUrl: {
    type: 'string',
    label: 'API 地址',
    default: 'https://api.deepseek.com',
    description: 'API 端点地址，可替换为兼容的第三方服务',
  },
  customModels: {
    type: 'textarea',
    label: '自定义模型',
    default: '',
    description:
      '手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。',
  },
  modelCapabilities: {
    type: 'textarea',
    label: '模型能力覆盖',
    default: '',
    description:
      '按行指定某个模型的能力集（**覆盖**插件自动推断结果）。\n格式：`<modelId>: <cap1>,<cap2>,...`，每行一条。如：deepseek-chat: chat,tool_calling,streaming',
  },
  timeout: {
    type: 'number',
    label: '请求超时 (秒)',
    default: 120,
    description: 'LLM 请求超时时间（秒）。思考模式下建议 180-300 秒。0 = 不限制。',
  },
  temperature: { type: 'number', label: '温度', default: 0.7, description: '0-2，越高越随机' },
  maxTokens: { type: 'number', label: '最大 Token', default: 8192, description: '单次回复最大生成 token 数' },
  contextLength: { type: 'number', label: '上下文长度', default: 131072, description: '模型上下文窗口大小' },
  strictToolCalls: {
    type: 'boolean',
    label: 'Strict 工具调用',
    default: false,
    description: '启用后所有工具调用将使用 strict 模式，模型输出严格遵循 JSON Schema（参考 api-docs.deepseek.com）',
  },
  forceJsonOutput: {
    type: 'boolean',
    label: '强制 JSON 输出',
    default: false,
    description:
      '启用后所有最终回复请求将携带 response_format: {type:"json_object"}，配合角色卡 outputFormat 使用可提升格式遵循率。工具调用阶段不受影响（工具响应走 tool_calls 字段）。需确保 system prompt 中含有 json 字样（启用 outputFormat 的角色卡会自动满足此条件）。',
  },
  thinkingMode: {
    type: 'select',
    label: '思考模式',
    default: 'auto',
    options: [
      { label: '自动（按模型推断）', value: 'auto' },
      { label: '启用', value: 'enabled' },
      { label: '关闭', value: 'disabled' },
    ],
    description:
      '控制深度思考。deepseek-v4-flash / deepseek-v4-pro / deepseek-reasoner 默认启用。设置为「关闭」时会显式传递 thinking.type=disabled。',
  },
  reasoningEffort: {
    type: 'select',
    label: '推理强度',
    default: 'auto',
    options: [
      { label: '自动（由 API 按场景选 high/max）', value: 'auto' },
      { label: '高', value: 'high' },
      { label: '最大', value: 'max' },
    ],
    description:
      '思考模式下的推理强度（v4 模型）。「自动」不发送参数，API 会为普通请求选 high、为 Agent 复杂场景选 max，推荐。',
  },
};

export const defaultConfig = {
  baseUrl: 'https://api.deepseek.com',
  customModels: '',
  modelCapabilities: '',
  timeout: 120,
  temperature: 0.7,
  maxTokens: 8192,
  contextLength: 131072,
};

// ===== 配置 =====

interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  customModels: string[];
  modelCapabilities: Map<string, LLMCapability[]>;
  timeout?: number;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  strictToolCalls: boolean;
  forceJsonOutput: boolean;
  reasoningEffort: 'auto' | 'high' | 'max';
}

// ===== DeepSeek API 消息格式 =====

type APIMessageContent = string | null;

interface APIMessage {
  role: string;
  content: APIMessageContent;
  reasoning_content?: string | null;
  tool_calls?: APIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface APIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface APITool {
  type: 'function';
  function: {
    name: string;
    strict?: boolean;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface APIChatResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: APIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ===== LLM 服务实现 =====

class DeepSeekLLMService implements LLMService {
  private apiKey: string;
  private baseUrl: string;
  private customModels: string[];
  private modelCapabilities: Map<string, LLMCapability[]>;
  private defaultModel: string | null = null;
  private timeout: number;
  private temperature: number;
  private maxTokens: number;
  private contextLength: number;
  private enableThinking: boolean;
  private reasoningEffort: 'auto' | 'high' | 'max';
  private strictToolCalls: boolean;
  private forceJsonOutput: boolean;
  private logger;

  constructor(ctx: Context, config: DeepSeekConfig, enableThinking: boolean) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.customModels = config.customModels;
    this.modelCapabilities = config.modelCapabilities;
    // schema 中 timeout 单位为「秒」，存储为毫秒；0 视为不限制 → 用一个非常大的值
    this.timeout = config.timeout && config.timeout > 0 ? config.timeout * 1000 : 2_147_483_647;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.contextLength = config.contextLength;
    this.enableThinking = enableThinking;
    this.reasoningEffort = config.reasoningEffort;
    this.strictToolCalls = config.strictToolCalls;
    this.forceJsonOutput = config.forceJsonOutput ?? false;
    this.logger = ctx.logger;
  }

  /** 启动时调用：发现远端模型、检查重复、确定默认模型 */
  async initialize(): Promise<{ defaultModel: string | null; capabilities: LLMCapability[] }> {
    const remote = await this.fetchRemoteModels();
    const remoteIds = new Set(remote.map(m => m.id));

    for (const cm of this.customModels) {
      if (remoteIds.has(cm)) {
        this.logger.warn(`自定义模型 "${cm}" 与自动发现的模型重复，建议去重`);
      }
    }
    this.logger.info(
      `initialize: 远端=${remote.length} 个 [${[...remoteIds].join(',') || '<空>'}], 自定义=${this.customModels.length} 个 [${this.customModels.join(',') || '<空>'}]`,
    );

    this.defaultModel = remote[0]?.id ?? this.customModels[0] ?? null;
    const capabilities = this.defaultModel ? this.resolveModelCapabilities(this.defaultModel) : DEFAULT_CAPABILITIES;
    return { defaultModel: this.defaultModel, capabilities };
  }

  /** 优先用用户覆盖（modelCapabilities 配置），否则走启发式推断。 */
  private resolveModelCapabilities(modelId: string): LLMCapability[] {
    return resolveCapabilities(modelId, this.modelCapabilities.get(modelId));
  }

  private getDefaultModel(): string {
    if (!this.defaultModel) throw new Error('无可用模型：远端模型列表为空且未配置 customModels');
    return this.defaultModel;
  }

  private async fetchRemoteModels(): Promise<ModelInfo[]> {
    const url = `${this.baseUrl}/models`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`fetchRemoteModels 失败 ${url}: HTTP ${res.status} ${res.statusText} - ${body.slice(0, 200)}`);
        return [];
      }
      const data = (await res.json()) as { data: { id: string }[] };
      return data.data.map(m => ({
        id: m.id,
        capabilities: this.resolveModelCapabilities(m.id),
      }));
    } catch (err) {
      this.logger.warn(`fetchRemoteModels 异常 ${url}: ${(err as Error).message}`);
      return [];
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const remote = await this.fetchRemoteModels();
    const remoteIds = new Set(remote.map(m => m.id));
    const custom = this.customModels
      .filter(id => !remoteIds.has(id))
      .map(id => ({ id, capabilities: this.resolveModelCapabilities(id) }));
    // contextLength 为 provider 全局配置；附到每个 ModelInfo 上以便 router.getContextLengthFor 查询
    return [...remote, ...custom].map(m => ({ ...m, contextLength: this.contextLength }));
  }

  setEnableThinking(value: boolean): void {
    this.enableThinking = value;
  }

  getTemperature(): number {
    return this.temperature;
  }

  getMaxTokens(): number {
    return this.maxTokens;
  }

  getContextLength(): number {
    return this.contextLength;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = request.messages.map(m => this.toAPIMessage(m));
    const tools = request.tools?.map(t => this.toAPITool(t));

    const body: Record<string, unknown> = {
      model: request.model ?? this.getDefaultModel(),
      messages,
      max_tokens: request.maxTokens ?? 8192,
    };

    const shouldThink = request.think !== undefined ? request.think : this.enableThinking;

    if (shouldThink) {
      body.thinking = { type: 'enabled' };
      if (this.reasoningEffort !== 'auto') body.reasoning_effort = this.reasoningEffort;
      // 思考模式下 temperature 等参数不生效
    } else {
      // 显式关闭：v4 系列 API 默认 enabled，不发送字段会保持开启
      body.thinking = { type: 'disabled' };
      body.temperature = request.temperature ?? this.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    // 强制 JSON 输出：工具调用走 tool_calls 字段，不受 response_format 影响
    if (this.forceJsonOutput) {
      body.response_format = { type: 'json_object' };
    }

    this.logger.debug(
      `请求 DeepSeek${shouldThink ? ` (思考 effort=${this.reasoningEffort})` : ' (思考已关闭)'}: ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`,
    );

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (request.signal) signals.push(request.signal);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(parseApiError('DeepSeek', response.status, errorText));
    }

    const data = (await response.json()) as APIChatResponse;
    const choice = data.choices[0];

    if (!choice) {
      throw new Error('DeepSeek 返回了空的 choices');
    }

    const result: ChatResponse = {
      content: choice.message.content ? stripDSML(choice.message.content) : choice.message.content,
      reasoningContent: choice.message.reasoning_content ?? undefined,
    };

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      result.toolCalls = choice.message.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    if (data.usage) {
      result.usage = {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.prompt_tokens + data.usage.completion_tokens,
      };
    }

    return result;
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const messages = request.messages.map(m => this.toAPIMessage(m));

    // ===== 统一流式路径 =====
    const tools = request.tools?.map(t => this.toAPITool(t));

    const body: Record<string, unknown> = {
      model: request.model ?? this.getDefaultModel(),
      messages,
      max_tokens: request.maxTokens ?? 8192,
      stream: true,
    };

    const shouldThink = request.think !== undefined ? request.think : this.enableThinking;

    if (shouldThink) {
      body.thinking = { type: 'enabled' };
      if (this.reasoningEffort !== 'auto') body.reasoning_effort = this.reasoningEffort;
    } else {
      body.thinking = { type: 'disabled' };
      body.temperature = request.temperature ?? this.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    // 强制 JSON 输出：工具调用走 tool_calls 字段，不受 response_format 影响
    if (this.forceJsonOutput) {
      body.response_format = { type: 'json_object' };
    }

    this.logger.debug(
      `流式请求 DeepSeek${shouldThink ? ` (思考 effort=${this.reasoningEffort})` : ' (思考已关闭)'}: ${body.model}, ${messages.length} 条消息`,
    );

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (request.signal) signals.push(request.signal);

    const reqStart = Date.now();
    // 守护：超过 15 秒还没拿到响应头，提示可能是网络/上游慢
    const slowConnectTimer = setTimeout(() => {
      this.logger.warn(`DeepSeek 连接慢：已等待 15s 仍未收到响应头 (url=${this.baseUrl}/v1/chat/completions)`);
    }, 15_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      clearTimeout(slowConnectTimer);
      const elapsed = Date.now() - reqStart;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`DeepSeek fetch 失败 (耗时 ${elapsed}ms): ${msg}`);
      throw err;
    }
    clearTimeout(slowConnectTimer);
    this.logger.debug(`DeepSeek 响应头到达: status=${response.status}, 耗时 ${Date.now() - reqStart}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(parseApiError('DeepSeek', response.status, errorText));
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    /** 流式累积内容，用于检测 DSML 泄漏 */
    let accContent = '';
    let dsmlDetected = false;

    if (!response.body) {
      throw new Error('DeepSeek API 返回了空的响应体，无法进行流式读取');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstChunkLogged = false;
    const streamStart = Date.now();
    // 守护：拿到响应头后 30 秒还没第一帧 SSE 数据，提示流停滞
    const streamStallTimer = setTimeout(() => {
      if (!firstChunkLogged) {
        this.logger.warn(`DeepSeek 流停滞：响应头已到但 30s 仍未收到首帧 SSE`);
      }
    }, 30_000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          clearTimeout(streamStallTimer);
          this.logger.debug(`DeepSeek 首帧到达: 耗时 ${Date.now() - streamStart}ms (从响应头算起)`);
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') {
            const toolCalls: ToolCall[] = [];
            for (const [, tc] of [...toolCallBuffers.entries()].sort((a, b) => a[0] - b[0])) {
              toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } });
            }
            yield { done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
            return;
          }

          try {
            const data = JSON.parse(payload);
            const delta = data.choices?.[0]?.delta;
            if (!delta) continue;

            const chunk: ChatStreamChunk = {};
            if (delta.content) {
              if (!dsmlDetected) {
                accContent += delta.content;
                // 检测 DSML 起始标记（全角或半角 | 前缀）
                const dsmlIdx = accContent.search(/<[｜|]DSML/);
                if (dsmlIdx !== -1) {
                  dsmlDetected = true;
                  // 输出 DSML 之前的部分（如果有）
                  const cleanPart = accContent.slice(0, dsmlIdx);
                  const prevLen = accContent.length - delta.content.length;
                  const cleanDelta = cleanPart.slice(prevLen);
                  if (cleanDelta) chunk.contentDelta = cleanDelta;
                } else {
                  chunk.contentDelta = delta.content;
                }
              }
              // dsmlDetected = true 时不再 emit content
            }
            if (delta.reasoning_content) chunk.reasoningDelta = delta.reasoning_content;

            // 累积工具调用
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (tc.id) {
                  toolCallBuffers.set(idx, { id: tc.id, name: tc.function?.name ?? '', args: '' });
                }
                const entry = toolCallBuffers.get(idx);
                if (entry) {
                  if (tc.function?.name) entry.name = tc.function.name;
                  if (tc.function?.arguments) entry.args += tc.function.arguments;
                  chunk.toolCallProgress = {
                    index: idx,
                    name: entry.name,
                    charsAccumulated: entry.args.length,
                  };
                }
              }
            }

            if (data.usage) {
              chunk.usage = {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.prompt_tokens + data.usage.completion_tokens,
              };
            }

            if (chunk.contentDelta || chunk.reasoningDelta || chunk.usage || chunk.toolCallProgress) {
              yield chunk;
            }
          } catch {
            /* skip malformed JSON */
          }
        }
      }
    } finally {
      clearTimeout(streamStallTimer);
      reader.releaseLock();
    }

    const toolCalls: ToolCall[] = [];
    for (const [, tc] of [...toolCallBuffers.entries()].sort((a, b) => a[0] - b[0])) {
      toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } });
    }

    yield { done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  /**
   * 转换为 DeepSeek API 消息格式
   * 关键：在工具调用循环中保留 reasoning_content，
   * 但历史消息（从 memory 加载）不含 reasoning_content
   */
  private toAPIMessage(msg: Message): APIMessage {
    const apiMsg: APIMessage = {
      role: msg.role,
      content: msg.content ?? null,
    };

    // DeepSeek API 不支持 image_url content 类型
    // 图片应由 plugin-image-recognition 预处理为文本描述，不传递给 API

    // 传递思考内容给 API（工具调用循环中需要）
    if (msg.reasoningContent) {
      apiMsg.reasoning_content = msg.reasoningContent;
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      apiMsg.tool_calls = msg.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    if (msg.toolCallId) {
      apiMsg.tool_call_id = msg.toolCallId;
    }

    if (msg.name) {
      apiMsg.name = msg.name;
    }

    return apiMsg;
  }

  private toAPITool(tool: ToolDefinition): APITool {
    return {
      type: 'function',
      function: {
        name: tool.function.name,
        strict: this.strictToolCalls || tool.function.strict,
        description: tool.function.description,
        parameters: tool.function.parameters as Record<string, unknown>,
      },
    };
  }
}

// ===== 模型能力映射 =====

const { Chat, ToolCalling, Streaming, Thinking } = LLMCapabilities;

const MODEL_CAPABILITIES: Record<string, LLMCapability[]> = {
  // 当前 v4 系列（默认启用思考，可通过 thinking.type=disabled 关闭）
  'deepseek-v4-flash': [Chat, ToolCalling, Streaming, Thinking],
  'deepseek-v4-pro': [Chat, ToolCalling, Streaming, Thinking],
  // 独立推理模型
  'deepseek-reasoner': [Chat, ToolCalling, Streaming, Thinking],
};

const DEFAULT_CAPABILITIES: LLMCapability[] = [Chat];

function resolveCapabilities(model: string, userOverride?: unknown): LLMCapability[] {
  // 用户显式声明优先
  if (Array.isArray(userOverride) && userOverride.length > 0) {
    return userOverride as LLMCapability[];
  }
  // 精确匹配
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model];
  // 模糊匹配：模型名包含关键词
  const lower = model.toLowerCase();
  if (lower.includes('reasoner')) return [Chat, ToolCalling, Streaming, Thinking];
  // v4 及后续主线模型默认启用思考
  if (/\bv[4-9]\b/.test(lower) || lower.includes('-pro') || lower.includes('-flash')) {
    return [Chat, ToolCalling, Streaming, Thinking];
  }
  if (lower.includes('chat')) return [Chat, ToolCalling, Streaming];
  return DEFAULT_CAPABILITIES;
}

// ===== 插件入口 =====

/** 解析自定义模型列表：支持逗号分隔和换行分隔 */
function parseCustomModels(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 解析能力覆盖 textarea：每行 `<modelId>: cap1,cap2,...` */
function parseModelCapabilities(raw: unknown): Map<string, LLMCapability[]> {
  const out = new Map<string, LLMCapability[]>();
  if (!raw || typeof raw !== 'string') return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const modelId = trimmed.slice(0, colonIdx).trim();
    const caps = trimmed
      .slice(colonIdx + 1)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean) as LLMCapability[];
    if (modelId && caps.length > 0) out.set(modelId, caps);
  }
  return out;
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const deepseekConfig: DeepSeekConfig = {
    apiKey: (config.apiKey as string) ?? '',
    baseUrl: (config.baseUrl as string) ?? 'https://api.deepseek.com',
    customModels: parseCustomModels(config.customModels),
    modelCapabilities: parseModelCapabilities(config.modelCapabilities),
    timeout: ((config.timeout as number) ?? 120) > 0 ? ((config.timeout as number) ?? 120) * 1000 : undefined,
    temperature: (config.temperature as number) ?? 0.7,
    maxTokens: (config.maxTokens as number) ?? 8192,
    contextLength: (config.contextLength as number) ?? 131072,
    strictToolCalls: (config.strictToolCalls as boolean) ?? false,
    forceJsonOutput: (config.forceJsonOutput as boolean) ?? false,
    reasoningEffort: (() => {
      const v = config.reasoningEffort as string | undefined;
      return v === 'high' || v === 'max' ? v : 'auto';
    })(),
  };

  if (!deepseekConfig.apiKey) {
    throw new Error('未配置 apiKey，DeepSeek 插件无法启动');
  }

  // 解析思考模式：auto 根据默认模型推断，enabled/disabled 强制覆盖
  const thinkingMode = (config.thinkingMode as string) ?? 'auto';

  const service = new DeepSeekLLMService(ctx, deepseekConfig, false); // enableThinking 稍后确定
  const { defaultModel, capabilities } = await service.initialize();

  // 根据 thinkingMode 和默认模型确定思考开关
  let enableThinking: boolean;
  if (thinkingMode === 'enabled') {
    enableThinking = true;
  } else if (thinkingMode === 'disabled') {
    enableThinking = false;
  } else {
    enableThinking = defaultModel ? resolveCapabilities(defaultModel).includes('thinking') : false;
  }
  service.setEnableThinking(enableThinking);

  const label = `DeepSeek (${deepseekConfig.baseUrl.replace(/^https?:\/\//, '')})`;
  ctx.provide('llm', service, { capabilities, label });

  if (defaultModel) {
    ctx.logger.info(
      `DeepSeek 已连接: ${deepseekConfig.baseUrl} (默认模型: ${defaultModel}) [${capabilities.join(', ')}]${enableThinking ? ` 思考模式(effort=${deepseekConfig.reasoningEffort})` : ''}`,
    );
  } else {
    ctx.logger.warn(`DeepSeek 已连接: ${deepseekConfig.baseUrl}，但未发现任何可用模型`);
  }
}
