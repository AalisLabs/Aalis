import type {
  Context,
  Message,
  ToolDefinition,
  ToolCall,
  ConfigSchema,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMService,
  ModelInfo,
  LLMCapability,
} from '@aalis/core';
import { LLMCapabilities } from '@aalis/core';

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
export const provides = ['llm'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, description: 'DeepSeek API 密钥' },
  baseUrl: { type: 'string', label: 'API 地址', default: 'https://api.deepseek.com', description: 'API 端点地址，可替换为兼容的第三方服务' },
  customModels: { type: 'textarea', label: '自定义模型', default: '', description: '手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。' },
  timeout: { type: 'number', label: '请求超时 (秒)', default: 120, description: 'LLM 请求超时时间（秒）。思考模式下建议 180-300 秒。0 = 不限制。' },
  temperature: { type: 'number', label: '温度', default: 0.7, description: '0-2，越高越随机' },
  maxTokens: { type: 'number', label: '最大 Token', default: 8192, description: '单次回复最大生成 token 数' },
  contextLength: { type: 'number', label: '上下文长度', default: 131072, description: '模型上下文窗口大小' },
  strictToolCalls: { type: 'boolean', label: 'Strict 工具调用', default: false, description: '启用后所有工具调用将使用 strict 模式，模型输出严格遵循 JSON Schema（参考 api-docs.deepseek.com）' },
  thinkingMode: {
    type: 'select', label: '思考模式', default: 'auto',
    options: [
      { label: '自动（按模型推断）', value: 'auto' },
      { label: '启用', value: 'enabled' },
      { label: '关闭', value: 'disabled' },
    ],
    description: '控制深度思考。deepseek-v4-flash / deepseek-v4-pro / deepseek-reasoner 默认启用。设置为「关闭」时会显式传递 thinking.type=disabled。',
  },
  reasoningEffort: {
    type: 'select', label: '推理强度', default: 'high',
    options: [
      { label: '高（默认）', value: 'high' },
      { label: '最大', value: 'max' },
    ],
    description: '思考模式下的推理强度（v4 模型）。API 会将 low/medium 映射为 high、xhigh 映射为 max。复杂 Agent 场景选 max。',
  },
  jsonMode: {
    type: 'boolean', label: 'JSON Mode', default: true,
    description: '启用后强制模型输出合法 JSON（response_format: json_object）。当工具可用时自动禁用以避免冲突。',
  },
};

export const defaultConfig = {
  baseUrl: 'https://api.deepseek.com',
  customModels: '',
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
  timeout?: number;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  strictToolCalls: boolean;
  reasoningEffort: 'high' | 'max';
  jsonMode: boolean;
}

// ===== DeepSeek API 消息格式 =====

type APIMessageContent =
  | string
  | null;

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
  private ctx: Context;
  private apiKey: string;
  private baseUrl: string;
  private customModels: string[];
  private defaultModel: string | null = null;
  private timeout: number;
  private temperature: number;
  private maxTokens: number;
  private contextLength: number;
  private enableThinking: boolean;
  private reasoningEffort: 'high' | 'max';
  private strictToolCalls: boolean;
  private jsonMode: boolean;
  private logger;

  constructor(ctx: Context, config: DeepSeekConfig, enableThinking: boolean) {
    this.ctx = ctx;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.customModels = config.customModels;
    // schema 中 timeout 单位为「秒」，存储为毫秒；0 视为不限制 → 用一个非常大的值
    this.timeout = config.timeout && config.timeout > 0 ? config.timeout * 1000 : 2_147_483_647;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.contextLength = config.contextLength;
    this.enableThinking = enableThinking;
    this.reasoningEffort = config.reasoningEffort;
    this.strictToolCalls = config.strictToolCalls;
    this.jsonMode = config.jsonMode;
    this.logger = ctx.logger;
  }

  /** 启动时快照的模型名集合（远端发现 + 自定义），供 supportsModel 同步查询使用。
   * 允许远端失败时退化为仅 customModels；运行时不再重拉，避免 listModels 网络抖动污染 LLMRouter 的慢路径缓存。 */
  private knownModelIds: Set<string> = new Set();

  /** 启动时调用：发现远端模型、检查重复、确定默认模型 */
  async initialize(): Promise<{ defaultModel: string | null; capabilities: LLMCapability[] }> {
    const remote = await this.fetchRemoteModels();
    const remoteIds = new Set(remote.map(m => m.id));

    for (const cm of this.customModels) {
      if (remoteIds.has(cm)) {
        this.logger.warn(`自定义模型 "${cm}" 与自动发现的模型重复，建议去重`);
      }
    }

    // 快照：供路由的 supportsModel 快路径使用
    this.knownModelIds = new Set([...remoteIds, ...this.customModels]);
    this.logger.info(`initialize: 远端=${remote.length} 个 [${[...remoteIds].join(',') || '<空>'}], 自定义=${this.customModels.length} 个 [${this.customModels.join(',') || '<空>'}], knownModelIds=${this.knownModelIds.size}`);

    this.defaultModel = remote[0]?.id ?? this.customModels[0] ?? null;
    const capabilities = this.defaultModel ? resolveCapabilities(this.defaultModel) : DEFAULT_CAPABILITIES;
    return { defaultModel: this.defaultModel, capabilities };
  }

  /** 同步接口：LLMRouter 优先调用，绕开 listModels 依赖远端返回的慢路径 */
  supportsModel(modelId: string): boolean {
    return this.knownModelIds.has(modelId);
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
        capabilities: resolveCapabilities(m.id),
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
      .map(id => ({ id, capabilities: resolveCapabilities(id) }));
    return [...remote, ...custom];
  }

  setEnableThinking(value: boolean): void {
    this.enableThinking = value;
  }

  /**
   * 判断是否应启用 JSON Mode
   * 条件：调用方请求 json_object + 配置启用 + 非思考模式 + 消息含 json 关键词（DeepSeek API 要求）
   * 注意：当请求包含 tools 时不启用 JSON Mode——DeepSeek 模型在同时收到
   * response_format 和 tools 时会将工具调用意图写入 JSON content，
   * 而不产生实际的 tool_calls，导致工具永远不被执行。
   */
  private shouldUseJsonMode(request: ChatRequest, messages: APIMessage[]): boolean {
    if (request.responseFormat !== 'json_object') return false;
    if (!this.jsonMode) return false;
    if (this.enableThinking) return false;
    if (request.tools && request.tools.length > 0) return false;
    return messages.some(m => typeof m.content === 'string' && /json/i.test(m.content));
  }

  /**
   * JSON 安全调用：内部处理 DeepSeek JSON Mode 的已知问题
   * 1. 空内容重试（DeepSeek 文档注意事项 #4：JSON Output 有概率返回空 content）
   * 2. 纯文本格式转换（模型未遵循 JSON 指令时，追加消息要求格式化）
   */
  private async chatWithJsonRetry(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.chat(request);

    // 有工具调用时不需要 JSON 内容
    if (response.toolCalls?.length) return response;

    // 空内容重试
    if (!response.content?.trim()) {
      this.logger.debug('JSON Mode 返回空内容，重试原始请求');
      const retry = await this.chat(request);
      if (retry.content?.trim()) return retry;
      return response;
    }

    // 非 JSON 内容：格式转换
    if (!response.content.trim().startsWith('{')) {
      this.logger.debug('JSON 格式转换：将纯文本回复转为结构化 JSON');
      const retryRequest: ChatRequest = {
        ...request,
        messages: [
          ...request.messages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: '请将你上面的回复严格转换为系统提示中要求的 JSON 格式，保留回复的完整内容，填充所有字段。只输出 JSON，不要输出其他任何内容。' },
        ],
        tools: undefined,
        temperature: 0.3,
      };
      const retry = await this.chat(retryRequest);
      if (retry.content?.trim().startsWith('{')) return retry;
    }

    return response;
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

    if (this.enableThinking) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = this.reasoningEffort;
      // 思考模式下 temperature 等参数不生效
    } else {
      // 显式关闭：v4 系列 API 默认 enabled，不发送字段会保持开启
      body.thinking = { type: 'disabled' };
      body.temperature = request.temperature ?? this.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const jsonMode = this.shouldUseJsonMode(request, messages);
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    this.logger.debug(`请求 DeepSeek${this.enableThinking ? ` (思考 effort=${this.reasoningEffort})` : ' (思考已关闭)'}${jsonMode ? ' (JSON Mode)' : ''}: ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`);

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (request.signal) signals.push(request.signal);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
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
    const jsonMode = this.shouldUseJsonMode(request, messages);

    // ===== 统一流式路径（JSON Mode 和普通模式共用） =====
    const tools = request.tools?.map(t => this.toAPITool(t));

    const body: Record<string, unknown> = {
      model: request.model ?? this.getDefaultModel(),
      messages,
      max_tokens: request.maxTokens ?? 8192,
      stream: true,
    };

    if (this.enableThinking) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = this.reasoningEffort;
    } else {
      body.thinking = { type: 'disabled' };
      body.temperature = request.temperature ?? this.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    this.logger.debug(`流式请求 DeepSeek${this.enableThinking ? ` (思考 effort=${this.reasoningEffort})` : ' (思考已关闭)'}${jsonMode ? ' (JSON Mode)' : ''}: ${body.model}, ${messages.length} 条消息`);

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
          'Authorization': `Bearer ${this.apiKey}`,
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
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
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

            if (chunk.contentDelta || chunk.reasoningDelta || chunk.usage) {
              yield chunk;
            }
          } catch { /* skip malformed JSON */ }
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

    // JSON Mode 空内容重试：DeepSeek 文档注意事项 #4（JSON Output 有概率返回空 content）
    if (jsonMode && !accContent.trim() && toolCalls.length === 0) {
      this.logger.debug('JSON Mode 流式返回空内容，重试原始请求');
      const retry = await this.chat(request);
      if (retry.content) yield { contentDelta: retry.content };
      yield { done: true, toolCalls: retry.toolCalls, usage: retry.usage };
      return;
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
  'deepseek-v4-pro':   [Chat, ToolCalling, Streaming, Thinking],
  // 独立推理模型
  'deepseek-reasoner': [Chat, ToolCalling, Streaming, Thinking],
  // 兼容旧别名（已下线，仅供老配置识别）
  'deepseek-chat':     [Chat, ToolCalling, Streaming],
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
  return raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const deepseekConfig: DeepSeekConfig = {
    apiKey: (config.apiKey as string) ?? '',
    baseUrl: (config.baseUrl as string) ?? 'https://api.deepseek.com',
    customModels: parseCustomModels(config.customModels),
    timeout: ((config.timeout as number) ?? 120) > 0 ? ((config.timeout as number) ?? 120) * 1000 : undefined,
    temperature: (config.temperature as number) ?? 0.7,
    maxTokens: (config.maxTokens as number) ?? 8192,
    contextLength: (config.contextLength as number) ?? 131072,
    strictToolCalls: (config.strictToolCalls as boolean) ?? false,
    reasoningEffort: ((config.reasoningEffort as string) === 'max' ? 'max' : 'high'),
    jsonMode: (config.jsonMode as boolean) ?? true,
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
    ctx.logger.info(`DeepSeek 已连接: ${deepseekConfig.baseUrl} (默认模型: ${defaultModel}) [${capabilities.join(', ')}]${enableThinking ? ` 思考模式(effort=${deepseekConfig.reasoningEffort})` : ''}`);
  } else {
    ctx.logger.warn(`DeepSeek 已连接: ${deepseekConfig.baseUrl}，但未发现任何可用模型`);
  }
}
