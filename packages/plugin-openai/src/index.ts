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

/** 解析 API 错误，对内容审查类错误返回友好提示 */
function parseApiError(provider: string, status: number, body: string): string {
  const lower = body.toLowerCase();
  if (status === 400 && CONTENT_FILTER_PATTERNS.some(p => lower.includes(p))) {
    return `${provider} 拒绝了此次请求（内容安全策略），请尝试换一个话题或缩短上下文`;
  }
  return `${provider} API 错误 (${status}): ${body}`;
}

export const name = '@aalis/plugin-openai';
export const displayName = 'OpenAI';
export const provides = ['llm'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, description: 'OpenAI API 密钥' },
  baseUrl: { type: 'string', label: 'API 地址', default: 'https://api.openai.com', description: 'API 端点地址，可替换为兼容的第三方服务' },
  defaultModel: { type: 'string', label: '默认模型', default: 'gpt-4o', description: '未指定模型时使用的默认模型名称' },
  temperature: { type: 'number', label: '温度', default: 0.7, description: '0-2，越高越随机' },
  maxTokens: { type: 'number', label: '最大 Token', default: 4096, description: '单次回复最大生成 token 数' },
  contextLength: { type: 'number', label: '上下文长度', default: 128000, description: '模型上下文窗口大小' },
  maxToolIterations: { type: 'number', label: '最大工具迭代', default: 10, description: '工具调用最大循环次数' },
};

export const defaultConfig = {
  baseUrl: 'https://api.openai.com',
  defaultModel: 'gpt-4o',
  temperature: 0.7,
  maxTokens: 4096,
  contextLength: 128000,
  maxToolIterations: 10,
};

// ===== 配置 =====

interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  timeout?: number;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  maxToolIterations: number;
}

// ===== OpenAI-compatible 消息格式 =====

type APIMessageContent =
  | string
  | null
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

interface APIMessage {
  role: string;
  content: APIMessageContent;
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

class OpenAILLMService implements LLMService {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private timeout: number;
  private temperature: number;
  private maxTokens: number;
  private contextLength: number;
  private maxToolIterations: number;
  private logger;

  constructor(config: OpenAIConfig, logger: Context['logger']) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.defaultModel = config.defaultModel;
    this.timeout = config.timeout ?? 120000;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.contextLength = config.contextLength;
    this.maxToolIterations = config.maxToolIterations;
    this.logger = logger;
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
      const res = await fetch(`${this.baseUrl}/v1/models`, {
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
      temperature: request.temperature ?? this.temperature,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (request.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    this.logger.debug(`请求 LLM${request.responseFormat === 'json_object' ? ' (JSON Mode)' : ''}: ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`);

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
      throw new Error(parseApiError('LLM', response.status, errorText));
    }

    const data = (await response.json()) as APIChatResponse;
    const choice = data.choices[0];

    if (!choice) {
      throw new Error('LLM 返回了空的 choices');
    }

    const result: ChatResponse = {
      content: choice.message.content,
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
    const tools = request.tools?.map(t => this.toAPITool(t));

    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages,
      temperature: request.temperature ?? this.temperature,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (request.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    this.logger.debug(`流式请求 LLM${request.responseFormat === 'json_object' ? ' (JSON Mode)' : ''}: ${body.model}, ${messages.length} 条消息`);

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
      throw new Error(parseApiError('LLM', response.status, errorText));
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

    if (!response.body) {
      throw new Error('LLM API 返回了空的响应体，无法进行流式读取');
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
            // 组装工具调用
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
            if (delta.content) chunk.contentDelta = delta.content;

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

            if (chunk.contentDelta || chunk.usage) {
              yield chunk;
            }
          } catch { /* skip malformed JSON */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If we get here without [DONE], yield done
    const toolCalls: ToolCall[] = [];
    for (const [, tc] of [...toolCallBuffers.entries()].sort((a, b) => a[0] - b[0])) {
      toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } });
    }
    yield { done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  private toAPIMessage(msg: Message): APIMessage {
    const apiMsg: APIMessage = {
      role: msg.role,
      content: msg.content,
    };

    // 多模态：如果消息包含图片，构造 content 数组
    if (msg.images && msg.images.length > 0 && msg.role === 'user') {
      const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
      if (msg.content) {
        parts.push({ type: 'text', text: msg.content });
      }
      for (const img of msg.images) {
        parts.push({ type: 'image_url', image_url: { url: img } });
      }
      apiMsg.content = parts;
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
        strict: tool.function.strict,
        description: tool.function.description,
        parameters: tool.function.parameters as Record<string, unknown>,
      },
    };
  }
}

// ===== 模型能力映射 =====

const MODEL_CAPABILITIES: Record<string, string[]> = {
  'gpt-4o':            ['chat', 'tool_calling', 'streaming', 'vision'],
  'gpt-4o-mini':       ['chat', 'tool_calling', 'streaming', 'vision'],
  'gpt-4-turbo':       ['chat', 'tool_calling', 'streaming'],
  'gpt-4':             ['chat', 'tool_calling', 'streaming'],
  'gpt-3.5-turbo':     ['chat', 'tool_calling', 'streaming'],
  'o1':                ['chat', 'thinking'],
  'o1-mini':           ['chat', 'thinking'],
  'o1-preview':        ['chat', 'thinking'],
  'o3':                ['chat', 'tool_calling', 'streaming', 'thinking'],
  'o3-mini':           ['chat', 'tool_calling', 'streaming', 'thinking'],
  'o4-mini':           ['chat', 'tool_calling', 'streaming', 'thinking'],
};

const DEFAULT_CAPABILITIES = ['chat', 'tool_calling', 'streaming'];

function resolveCapabilities(model: string, userOverride?: unknown): string[] {
  // 用户显式声明优先
  if (Array.isArray(userOverride) && userOverride.length > 0) {
    return userOverride as string[];
  }
  // 精确匹配
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model];
  // 模糊匹配
  const lower = model.toLowerCase();
  for (const [known, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (lower.startsWith(known)) return caps;
  }
  return DEFAULT_CAPABILITIES;
}

// ===== 插件入口 =====

/** 收集所有已知模型能力的并集 */
function getAllCapabilities(): string[] {
  const caps = new Set<string>();
  for (const c of Object.values(MODEL_CAPABILITIES)) {
    for (const cap of c) caps.add(cap);
  }
  return [...caps];
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const openaiConfig: OpenAIConfig = {
    apiKey: (config.apiKey as string) ?? '',
    baseUrl: (config.baseUrl as string) ?? 'https://api.openai.com',
    defaultModel: (config.defaultModel as string) ?? (config.model as string) ?? 'gpt-4o',
    timeout: config.timeout as number | undefined,
    temperature: (config.temperature as number) ?? 0.7,
    maxTokens: (config.maxTokens as number) ?? 4096,
    contextLength: (config.contextLength as number) ?? 128000,
    maxToolIterations: (config.maxToolIterations as number) ?? 10,
  };

  if (!openaiConfig.apiKey) {
    throw new Error('未配置 apiKey，插件无法启动');
  }

  const service = new OpenAILLMService(openaiConfig, ctx.logger);
  const capabilities = getAllCapabilities();

  ctx.provide('llm', service, { capabilities, label: `OpenAI (${openaiConfig.baseUrl.replace(/^https?:\/\//, '')})` });

  ctx.logger.info(`已连接: ${openaiConfig.baseUrl} (默认模型: ${openaiConfig.defaultModel}) [${capabilities.join(', ')}]`);
}
