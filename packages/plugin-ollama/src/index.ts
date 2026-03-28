import type {
  Context,
  Message,
  ToolDefinition,
  ConfigSchema,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMService,
  ModelInfo,
} from '@aalis/core';
import type { Logger } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-ollama';
export const displayName = 'Ollama';
export const provides = ['llm'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  baseUrl: { type: 'string', label: 'Ollama 地址', default: 'http://localhost:11434', description: '本地 Ollama 服务的 HTTP 地址' },
  defaultModel: { type: 'string', label: '默认模型', default: 'llama3.1', description: '未指定模型时使用的默认模型名称' },
  temperature: { type: 'number', label: '温度', default: 0.7, description: '0-2，越高越随机' },
  maxTokens: { type: 'number', label: '最大 Token', default: 4096, description: '单次回复最大生成 token 数（num_predict）' },
  contextLength: { type: 'number', label: '上下文长度', default: 8192, description: '模型上下文窗口大小（num_ctx）' },
  maxToolIterations: { type: 'number', label: '最大工具迭代', default: 10, description: '工具调用最大循环次数' },
  keepAlive: { type: 'string', label: '模型保活时间', default: '5m', description: '模型在显存中保留的时间，如 5m、1h、0（立即卸载）' },
};

export const defaultConfig = {
  baseUrl: 'http://localhost:11434',
  defaultModel: 'llama3.1',
  temperature: 0.7,
  maxTokens: 4096,
  contextLength: 8192,
  maxToolIterations: 10,
  keepAlive: '5m',
};

// ===== 配置 =====

interface OllamaConfig {
  baseUrl: string;
  defaultModel: string;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  maxToolIterations: number;
  keepAlive: string;
}

// ===== Ollama API 消息格式 =====

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ===== LLM 服务实现 =====

class OllamaLLMService implements LLMService {
  private baseUrl: string;
  private defaultModel: string;
  private temperature: number;
  private maxTokens: number;
  private contextLength: number;
  private maxToolIterations: number;
  private keepAlive: string;
  private logger: Logger;

  constructor(config: OllamaConfig, logger: Logger) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.defaultModel = config.defaultModel;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.contextLength = config.contextLength;
    this.maxToolIterations = config.maxToolIterations;
    this.keepAlive = config.keepAlive;
    this.logger = logger;
  }

  getTemperature(): number { return this.temperature; }
  getMaxTokens(): number { return this.maxTokens; }
  getMaxToolIterations(): number { return this.maxToolIterations; }
  getContextLength(): number { return this.contextLength; }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as { models: { name: string }[] };
      return data.models.map(m => ({
        id: m.name,
        capabilities: resolveCapabilities(m.name),
      }));
    } catch {
      return [];
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = await Promise.all(request.messages.map(m => this.toOllamaMessage(m)));
    const tools = request.tools?.map(t => this.toOllamaTool(t));

    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages,
      stream: false,
      options: {
        temperature: request.temperature ?? this.temperature,
        num_predict: request.maxTokens ?? this.maxTokens,
        num_ctx: this.contextLength,
      },
      keep_alive: this.keepAlive,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    this.logger.debug(`请求 Ollama: ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`);

    const signals: AbortSignal[] = [AbortSignal.timeout(120000)];
    if (request.signal) signals.push(request.signal);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API 错误 (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OllamaChatResponse;

    const result: ChatResponse = {
      content: data.message.content || null,
    };

    if (data.message.tool_calls && data.message.tool_calls.length > 0) {
      result.toolCalls = data.message.tool_calls.map((tc, i) => ({
        id: `call_ollama_${Date.now()}_${i}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      }));
    }

    if (data.prompt_eval_count != null || data.eval_count != null) {
      const promptTokens = data.prompt_eval_count ?? 0;
      const completionTokens = data.eval_count ?? 0;
      result.usage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    }

    return result;
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const messages = await Promise.all(request.messages.map(m => this.toOllamaMessage(m)));
    const tools = request.tools?.map(t => this.toOllamaTool(t));

    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages,
      stream: true,
      options: {
        temperature: request.temperature ?? this.temperature,
        num_predict: request.maxTokens ?? this.maxTokens,
        num_ctx: this.contextLength,
      },
      keep_alive: this.keepAlive,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    this.logger.debug(`流式请求 Ollama: ${body.model}, ${messages.length} 条消息`);

    const signals: AbortSignal[] = [AbortSignal.timeout(120000)];
    if (request.signal) signals.push(request.signal);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API 错误 (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Ollama API 返回了空的响应体，无法进行流式读取');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCallBuffers: OllamaToolCall[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const data = JSON.parse(trimmed) as OllamaChatResponse;

            // 累积工具调用
            if (data.message?.tool_calls) {
              toolCallBuffers.push(...data.message.tool_calls);
            }

            if (data.done) {
              // 最后一个 chunk
              const chunk: ChatStreamChunk = { done: true };

              if (toolCallBuffers.length > 0) {
                chunk.toolCalls = toolCallBuffers.map((tc, i) => ({
                  id: `call_ollama_${Date.now()}_${i}`,
                  type: 'function' as const,
                  function: {
                    name: tc.function.name,
                    arguments: JSON.stringify(tc.function.arguments),
                  },
                }));
              }

              if (data.prompt_eval_count != null || data.eval_count != null) {
                const promptTokens = data.prompt_eval_count ?? 0;
                const completionTokens = data.eval_count ?? 0;
                chunk.usage = {
                  promptTokens,
                  completionTokens,
                  totalTokens: promptTokens + completionTokens,
                };
              }

              yield chunk;
              return;
            }

            if (data.message?.content) {
              yield { contentDelta: data.message.content };
            }
          } catch { /* skip malformed JSON */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 流意外结束时补发 done
    const finalChunk: ChatStreamChunk = { done: true };
    if (toolCallBuffers.length > 0) {
      finalChunk.toolCalls = toolCallBuffers.map((tc, i) => ({
        id: `call_${i}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      }));
    }
    yield finalChunk;
  }

  /**
   * 将图片字符串解析为 Ollama 所需的纯 base64 格式。
   * 支持 data URI、HTTP(S) URL、纯 base64、文件路径。
   * 返回 null 表示图片无法获取。
   */
  private async resolveImage(img: string): Promise<string | null> {
    // data URI → 提取 base64（兼容多参数格式如 data:image/png;charset=utf-8;base64,...）
    const dataMatch = img.match(/^data:[^,]*;base64,(.+)$/);
    if (dataMatch) return dataMatch[1];

    // HTTP(S) URL → 下载并转 base64
    if (/^https?:\/\//i.test(img)) {
      try {
        const res = await fetch(img, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) {
          this.logger.warn(`下载图片失败 (${res.status}): ${img}`);
          return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.toString('base64');
      } catch (err) {
        this.logger.warn(`下载图片异常: ${img}`, err);
        return null;
      }
    }

    // 其他情况（纯 base64 或文件路径）直接返回
    return img;
  }

  /**
   * 转换为 Ollama API 消息格式
   * Ollama 的图片通过 images 字段传递 base64 数据（或 URL）
   * 工具调用结果通过 role: tool 传递
   */
  private async toOllamaMessage(msg: Message): Promise<OllamaMessage> {
    const ollamaMsg: OllamaMessage = {
      role: msg.role === 'tool' ? 'tool' : msg.role,
      content: msg.content ?? '',
    };

    // 多模态：Ollama 支持 images 字段（base64 或文件路径）
    if (msg.images && msg.images.length > 0 && msg.role === 'user') {
      const resolved = await Promise.all(msg.images.map(img => this.resolveImage(img)));
      const valid = resolved.filter((r): r is string => r !== null);
      if (valid.length > 0) ollamaMsg.images = valid;
    }

    // 传递工具调用（assistant 消息中的）
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      ollamaMsg.tool_calls = msg.toolCalls.map(tc => ({
        function: {
          name: tc.function.name,
          arguments: safeParseJSON(tc.function.arguments),
        },
      }));
    }

    return ollamaMsg;
  }

  private toOllamaTool(tool: ToolDefinition): OllamaTool {
    return {
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters as Record<string, unknown>,
      },
    };
  }
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ===== 模型能力映射 =====

const MODEL_CAPABILITIES: Record<string, string[]> = {
  'llama3.1':       ['chat', 'tool_calling', 'streaming'],
  'llama3.2':       ['chat', 'tool_calling', 'streaming'],
  'llama3.3':       ['chat', 'tool_calling', 'streaming'],
  'llava':          ['chat', 'streaming', 'vision'],
  'llava-llama3':   ['chat', 'streaming', 'vision'],
  'gemma2':         ['chat', 'streaming'],
  'gemma3':         ['chat', 'tool_calling', 'streaming', 'vision'],
  'qwen2.5':        ['chat', 'tool_calling', 'streaming'],
  'qwen2.5-coder':  ['chat', 'tool_calling', 'streaming'],
  'qwen3':          ['chat', 'tool_calling', 'streaming'],
  'mistral':        ['chat', 'tool_calling', 'streaming'],
  'deepseek-r1':    ['chat', 'streaming'],
  'phi4':           ['chat', 'streaming'],
  'command-r':      ['chat', 'tool_calling', 'streaming'],
};

const DEFAULT_CAPABILITIES = ['chat', 'streaming'];

function resolveCapabilities(model: string, userOverride?: unknown): string[] {
  if (Array.isArray(userOverride) && userOverride.length > 0) {
    return userOverride as string[];
  }
  // 去掉 tag 部分（如 llama3.1:8b → llama3.1）
  const baseName = model.split(':')[0].toLowerCase();
  if (MODEL_CAPABILITIES[baseName]) return MODEL_CAPABILITIES[baseName];
  // 模糊匹配
  for (const [known, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (baseName.startsWith(known)) return caps;
  }
  // 常见视觉模型关键词
  if (baseName.includes('llava') || baseName.includes('vision')) {
    return ['chat', 'streaming', 'vision'];
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
  const ollamaConfig: OllamaConfig = {
    baseUrl: (config.baseUrl as string) ?? 'http://localhost:11434',
    defaultModel: (config.defaultModel as string) ?? (config.model as string) ?? 'llama3.1',
    temperature: (config.temperature as number) ?? 0.7,
    maxTokens: (config.maxTokens as number) ?? 4096,
    contextLength: (config.contextLength as number) ?? 8192,
    maxToolIterations: (config.maxToolIterations as number) ?? 10,
    keepAlive: (config.keepAlive as string) ?? '5m',
  };

  const service = new OllamaLLMService(ollamaConfig, ctx.logger);
  const capabilities = getAllCapabilities();

  ctx.provide('llm', service, { capabilities, label: `Ollama (${ollamaConfig.baseUrl.replace(/^https?:\/\//, '')})` });

  ctx.logger.info(`Ollama 已连接: ${ollamaConfig.baseUrl} (默认模型: ${ollamaConfig.defaultModel}) [${capabilities.join(', ')}]`);
}
