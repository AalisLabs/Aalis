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
} from '@aalis/core';

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
  defaultModel: { type: 'string', label: '默认模型', default: 'deepseek-chat', description: '未指定模型时使用的默认模型名称' },
  temperature: { type: 'number', label: '温度', default: 0.7, description: '0-2，越高越随机' },
  maxTokens: { type: 'number', label: '最大 Token', default: 8192, description: '单次回复最大生成 token 数' },
  contextLength: { type: 'number', label: '上下文长度', default: 131072, description: '模型上下文窗口大小' },
  maxToolIterations: { type: 'number', label: '最大工具迭代', default: 10, description: '工具调用最大循环次数' },
  strictToolCalls: { type: 'boolean', label: 'Strict 工具调用', default: false, description: '启用后所有工具调用将使用 strict 模式，模型输出严格遵循 JSON Schema（参考 api-docs.deepseek.com）' },
  thinkingMode: {
    type: 'select', label: '思考模式', default: 'auto',
    options: [
      { label: '自动（按模型推断）', value: 'auto' },
      { label: '启用', value: 'enabled' },
      { label: '关闭', value: 'disabled' },
    ],
    description: '控制深度思考。「自动」会根据模型名称推断（reasoner 模型自动启用）。deepseek-chat 也可手动启用思考模式。',
  },
  thinkingBudget: {
    type: 'number', label: '思考 Token 预算', default: 0,
    description: '限制思考链最大 token 数（0 = 不限制，由模型自行决定）。设置后可控制思考深度，减少 token 消耗。',
  },
  jsonMode: {
    type: 'boolean', label: 'JSON Mode', default: true,
    description: '启用后强制模型输出合法 JSON（response_format: json_object）。当工具可用时自动禁用以避免冲突。',
  },
};

export const defaultConfig = {
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-chat',
  temperature: 0.7,
  maxTokens: 8192,
  contextLength: 131072,
  maxToolIterations: 10,
};

// ===== 配置 =====

interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  timeout?: number;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  maxToolIterations: number;
  strictToolCalls: boolean;
  thinkingBudget: number;
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
  private defaultModel: string;
  private timeout: number;
  private temperature: number;
  private maxTokens: number;
  private contextLength: number;
  private maxToolIterations: number;
  private enableThinking: boolean;
  private thinkingBudget: number;
  private strictToolCalls: boolean;
  private jsonMode: boolean;
  private logger;

  constructor(ctx: Context, config: DeepSeekConfig, enableThinking: boolean) {
    this.ctx = ctx;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.defaultModel = config.defaultModel;
    this.timeout = config.timeout ?? 120000;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.contextLength = config.contextLength;
    this.maxToolIterations = config.maxToolIterations;
    this.enableThinking = enableThinking;
    this.thinkingBudget = config.thinkingBudget;
    this.strictToolCalls = config.strictToolCalls;
    this.jsonMode = config.jsonMode;
    this.logger = ctx.logger;
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

  getMaxToolIterations(): number {
    return this.maxToolIterations;
  }

  getContextLength(): number {
    return this.contextLength;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data: { id: string }[] };
      return data.data.map(m => ({
        id: m.id,
        capabilities: resolveCapabilities(m.id),
      }));
    } catch {
      return [];
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = request.messages.map(m => this.toAPIMessage(m));
    const tools = request.tools?.map(t => this.toAPITool(t));

    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages,
      max_tokens: request.maxTokens ?? 8192,
    };

    if (this.enableThinking) {
      const thinking: Record<string, unknown> = { type: 'enabled' };
      if (this.thinkingBudget > 0) thinking.budget_tokens = this.thinkingBudget;
      body.thinking = thinking;
      // 思考模式下 temperature 等参数不生效
    } else {
      body.temperature = request.temperature ?? this.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const jsonMode = this.shouldUseJsonMode(request, messages);
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    this.logger.debug(`请求 DeepSeek${this.enableThinking ? ` (思考模式${this.thinkingBudget > 0 ? `, 预算 ${this.thinkingBudget}` : ''})` : ''}${jsonMode ? ' (JSON Mode)' : ''}: ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`);

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
      model: request.model ?? this.defaultModel,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      stream: true,
    };

    if (this.enableThinking) {
      const thinking: Record<string, unknown> = { type: 'enabled' };
      if (this.thinkingBudget > 0) thinking.budget_tokens = this.thinkingBudget;
      body.thinking = thinking;
    } else {
      body.temperature = request.temperature ?? this.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    this.logger.debug(`流式请求 DeepSeek${this.enableThinking ? ' (思考模式)' : ''}${jsonMode ? ' (JSON Mode)' : ''}: ${body.model}, ${messages.length} 条消息`);

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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

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

const MODEL_CAPABILITIES: Record<string, string[]> = {
  'deepseek-chat':     ['chat', 'tool_calling', 'streaming'],
  'deepseek-reasoner': ['chat', 'tool_calling', 'streaming', 'thinking'],
};

const DEFAULT_CAPABILITIES = ['chat', 'streaming'];

function resolveCapabilities(model: string, userOverride?: unknown): string[] {
  // 用户显式声明优先
  if (Array.isArray(userOverride) && userOverride.length > 0) {
    return userOverride as string[];
  }
  // 精确匹配
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model];
  // 模糊匹配：模型名包含关键词
  const lower = model.toLowerCase();
  if (lower.includes('reasoner')) return ['chat', 'tool_calling', 'streaming', 'thinking'];
  if (lower.includes('chat')) return ['chat', 'tool_calling', 'streaming'];
  return DEFAULT_CAPABILITIES;
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const deepseekConfig: DeepSeekConfig = {
    apiKey: (config.apiKey as string) ?? '',
    baseUrl: (config.baseUrl as string) ?? 'https://api.deepseek.com',
    defaultModel: (config.defaultModel as string) ?? (config.model as string) ?? 'deepseek-chat',
    timeout: config.timeout as number | undefined,
    temperature: (config.temperature as number) ?? 0.7,
    maxTokens: (config.maxTokens as number) ?? 8192,
    contextLength: (config.contextLength as number) ?? 131072,
    maxToolIterations: (config.maxToolIterations as number) ?? 10,
    strictToolCalls: (config.strictToolCalls as boolean) ?? false,
    thinkingBudget: (config.thinkingBudget as number) ?? 0,
    jsonMode: (config.jsonMode as boolean) ?? true,
  };

  if (!deepseekConfig.apiKey) {
    throw new Error('未配置 apiKey，DeepSeek 插件无法启动');
  }

  /** 收集所有已知模型能力的并集 */
  const getAllCapabilities = (): string[] => {
    const caps = new Set<string>();
    for (const c of Object.values(MODEL_CAPABILITIES)) {
      for (const cap of c) caps.add(cap);
    }
    return [...caps];
  };

  const capabilities = getAllCapabilities();

  // 解析思考模式：auto 根据默认模型推断，enabled/disabled 强制覆盖
  const thinkingMode = (config.thinkingMode as string) ?? 'auto';
  let enableThinking: boolean;
  if (thinkingMode === 'enabled') {
    enableThinking = true;
  } else if (thinkingMode === 'disabled') {
    enableThinking = false;
  } else {
    enableThinking = resolveCapabilities(deepseekConfig.defaultModel).includes('thinking');
  }

  const service = new DeepSeekLLMService(ctx, deepseekConfig, enableThinking);

  ctx.provide('llm', service, { capabilities, label: `DeepSeek (${deepseekConfig.baseUrl.replace(/^https?:\/\//, '')})` });

  ctx.logger.info(`DeepSeek 已连接: ${deepseekConfig.baseUrl} (默认模型: ${deepseekConfig.defaultModel}) [${capabilities.join(', ')}]${enableThinking ? ` 思考模式${deepseekConfig.thinkingBudget > 0 ? `(预算 ${deepseekConfig.thinkingBudget})` : ''}` : ''}`);
}
