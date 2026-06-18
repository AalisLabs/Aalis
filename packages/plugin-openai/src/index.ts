import type { ConfigSchema, Context } from '@aalis/core';
import type { ChatModelRequest, ChatResponse, ChatStreamChunk, LLMCapability, LLMModel } from '@aalis/plugin-llm-api';
import { LLMCapabilities } from '@aalis/plugin-llm-api';
import type { Message, ToolCall } from '@aalis/plugin-message-api';
import { prepareLLMMessages, toLLMRole } from '@aalis/plugin-message-api';
import type { ToolDefinition } from '@aalis/plugin-tools-api';
import type {} from '@aalis/plugin-webui-api'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）

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
export const subsystem = 'llm';
export const provides = ['llm'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', secret: true, description: 'OpenAI API 密钥（本地服务可留空）' },
  baseUrl: {
    type: 'string',
    label: 'API 地址',
    default: 'https://api.openai.com',
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
    label: '单模型能力覆盖',
    default: '',
    description:
      '按行指定某个模型的能力集。有该模型的表项时**覆盖**插件启发式推断，与 adapter 默认能力仍取并集。\n格式：`<modelId>: <cap1>,<cap2>,...`，每行一条。如：gpt-4o: chat,tool_calling,vision,streaming\n可用能力：chat / tool_calling / vision / streaming / thinking / json_mode 等。',
  },
  providerCapabilities: {
    type: 'string',
    label: '适配器默认能力（逗号分隔）',
    default: '',
    description:
      '为本适配器下所有模型额外补充的能力。最终某模型的能力 = 此处能力 ∪ 模型级别能力。例：chat,tool_calling,streaming',
  },
  timeout: {
    type: 'number',
    label: '请求超时 (秒)',
    default: 120,
    description: 'LLM 请求超时时间（秒）。思考模式或长文本建议适当调大。0 = 不限制。',
  },
  temperature: { type: 'number', label: '温度', default: 0.7, description: '0-2，越高越随机' },
  maxTokens: { type: 'number', label: '最大 Token', default: 4096, description: '单次回复最大生成 token 数' },
  contextLength: { type: 'number', label: '上下文长度', default: 128000, description: '模型上下文窗口大小' },
};

export const defaultConfig = {
  baseUrl: 'https://api.openai.com',
  customModels: '',
  modelCapabilities: '',
  providerCapabilities: '',
  timeout: 120,
  temperature: 0.7,
  maxTokens: 4096,
  contextLength: 128000,
};

// ===== 配置 =====

interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  customModels: string[];
  modelCapabilities: Map<string, LLMCapability[]>;
  providerCapabilities: LLMCapability[];
  timeout?: number;
  temperature: number;
  maxTokens: number;
  contextLength: number;
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

/** OpenAI 推理模型(o 系列：o1/o3/o4…)：拒 max_tokens(需 max_completion_tokens)、拒非默认 temperature。 */
function isReasoningModel(model: string): boolean {
  return /^o\d/i.test(model);
}

// ===== OpenAI 客户端（不是 service、仅是底层 fetch 封装，多个 ModelHandle 共享） =====

class OpenAIClient {
  private apiKey: string;
  readonly baseUrl: string;
  private timeout: number;
  readonly temperature: number;
  readonly maxTokens: number;
  private logger;

  constructor(config: OpenAIConfig, logger: Context['logger']) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    // schema 中 timeout 单位为「秒」，存储为毫秒；0 视为不限制 → 用一个非常大的值
    this.timeout = config.timeout && config.timeout > 0 ? config.timeout * 1000 : 2_147_483_647;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.logger = logger;
  }

  /** 构造请求头（无 apiKey 时不发 Authorization） */
  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /** 发现远端模型列表（仅含 id） */
  async fetchRemoteModelIds(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.headers,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data: { id: string }[] };
      return data.data.map(m => m.id);
    } catch {
      return [];
    }
  }

  async chat(model: string, request: ChatModelRequest): Promise<ChatResponse> {
    const messages = prepareLLMMessages(request.messages).map(m => this.toAPIMessage(m));
    const tools = request.tools?.map(t => this.toAPITool(t));

    const reasoning = isReasoningModel(model);
    const body: Record<string, unknown> = {
      model,
      messages,
      // 推理模型(o 系列)拒 max_tokens(需 max_completion_tokens)且只接受默认 temperature → 分支处理(M14)；
      // 缺省回退到配置的 this.maxTokens，而非字面量 4096(M15，遵守 llm-api 契约)。
      [reasoning ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens ?? this.maxTokens,
      ...(reasoning ? {} : { temperature: request.temperature ?? this.temperature }),
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    this.logger.debug(`请求 LLM: ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`);

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (request.signal) signals.push(request.signal);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers,
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

  async *chatStream(model: string, request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
    const messages = prepareLLMMessages(request.messages).map(m => this.toAPIMessage(m));
    const tools = request.tools?.map(t => this.toAPITool(t));

    const reasoning = isReasoningModel(model);
    const body: Record<string, unknown> = {
      model,
      messages,
      // 同 chat()：推理模型分支 max_completion_tokens / 略去 temperature(M14)，缺省回退 this.maxTokens(M15)。
      [reasoning ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens ?? this.maxTokens,
      ...(reasoning ? {} : { temperature: request.temperature ?? this.temperature }),
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    this.logger.debug(`流式请求 LLM: ${body.model}, ${messages.length} 条消息`);

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (request.signal) signals.push(request.signal);

    const reqStart = Date.now();
    const slowConnectTimer = setTimeout(() => {
      this.logger.warn(`LLM 连接慢：已等待 15s 仍未收到响应头 (url=${this.baseUrl}/v1/chat/completions)`);
    }, 15_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      clearTimeout(slowConnectTimer);
      const elapsed = Date.now() - reqStart;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`LLM fetch 失败 (耗时 ${elapsed}ms): ${msg}`);
      throw err;
    }
    clearTimeout(slowConnectTimer);
    this.logger.debug(`LLM 响应头到达: status=${response.status}, 耗时 ${Date.now() - reqStart}ms`);

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
    let firstChunkLogged = false;
    const streamStart = Date.now();
    const streamStallTimer = setTimeout(() => {
      if (!firstChunkLogged) {
        this.logger.warn(`LLM 流停滞：响应头已到但 30s 仍未收到首帧 SSE`);
      }
    }, 30_000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          clearTimeout(streamStallTimer);
          this.logger.debug(`LLM 首帧到达: 耗时 ${Date.now() - streamStart}ms (从响应头算起)`);
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith('data: ')) continue;
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
                  // 每次 delta 都 yield 进度（不影响最终 done chunk）
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

            if (chunk.contentDelta || chunk.usage || chunk.toolCallProgress) {
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

    // If we get here without [DONE], yield done
    const toolCalls: ToolCall[] = [];
    for (const [, tc] of [...toolCallBuffers.entries()].sort((a, b) => a[0] - b[0])) {
      toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } });
    }
    yield { done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  private toAPIMessage(msg: Message): APIMessage {
    // 调用方已经 prepareLLMMessages 处理过：role 已是 WellKnownRole，
    // 自定义 role / kind 的前缀（[系统通知] / [跨会话委派] 等）已拼接进 content。
    // 这里只需透传。toLLMRole 作为防御性幂等调用。
    const apiMsg: APIMessage = {
      role: toLLMRole(msg.role),
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

const { Chat, ToolCalling, Streaming, Vision, Thinking } = LLMCapabilities;

const MODEL_CAPABILITIES: Record<string, LLMCapability[]> = {
  'gpt-4o': [Chat, ToolCalling, Streaming, Vision],
  'gpt-4o-mini': [Chat, ToolCalling, Streaming, Vision],
  'gpt-4-turbo': [Chat, ToolCalling, Streaming],
  'gpt-4': [Chat, ToolCalling, Streaming],
  'gpt-3.5-turbo': [Chat, ToolCalling, Streaming],
  o1: [Chat, Thinking],
  'o1-mini': [Chat, Thinking],
  'o1-preview': [Chat, Thinking],
  o3: [Chat, ToolCalling, Streaming, Thinking],
  'o3-mini': [Chat, ToolCalling, Streaming, Thinking],
  'o4-mini': [Chat, ToolCalling, Streaming, Thinking],
};

const DEFAULT_CAPABILITIES: LLMCapability[] = [Chat];

function resolveCapabilities(model: string, userOverride?: unknown, providerCaps?: LLMCapability[]): LLMCapability[] {
  const out = new Set<LLMCapability>(providerCaps ?? []);
  // 用户显式声明优先（覆盖启发式）
  if (Array.isArray(userOverride) && userOverride.length > 0) {
    for (const c of userOverride as LLMCapability[]) out.add(c);
    return [...out];
  }
  // 精确匹配
  if (MODEL_CAPABILITIES[model]) {
    for (const c of MODEL_CAPABILITIES[model]) out.add(c);
    return [...out];
  }
  // 模糊匹配
  const lower = model.toLowerCase();
  for (const [known, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (lower.startsWith(known)) {
      for (const c of caps) out.add(c);
      return [...out];
    }
  }
  for (const c of DEFAULT_CAPABILITIES) out.add(c);
  return [...out];
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

/**
 * 解析用户能力覆盖配置（textarea）。格式：每行 `<modelId>: cap1,cap2,...`。
 * 返回 Map，供 resolveCapabilities() 作为 userOverride（覆盖而非叠加）。
 */
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

/**
 * 解析适配器级别默认能力（逗号/空格/换行分隔）。
 */
function parseProviderCapabilities(raw: unknown): LLMCapability[] {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[,\s\n]/)
    .map(s => s.trim())
    .filter(Boolean) as LLMCapability[];
}

// ===== Per-model handle：每个 model 独立的 LLMModel entry =====

class OpenAIModelHandle implements LLMModel {
  constructor(
    private client: OpenAIClient,
    readonly id: string,
    readonly providerId: string,
    readonly contextLength: number,
    readonly maxOutputTokens: number,
    /** Provider 级共享的 refresh 闭包；webui 按 contextId 找到任一 entry 调一次即可。 */
    readonly refresh: () => Promise<{ added: string[]; removed: string[]; total: number }>,
  ) {}

  chat(request: ChatModelRequest): Promise<ChatResponse> {
    return this.client.chat(this.id, request);
  }

  chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
    return this.client.chatStream(this.id, request);
  }
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const openaiConfig: OpenAIConfig = {
    apiKey: (config.apiKey as string) ?? '',
    baseUrl: (config.baseUrl as string) ?? 'https://api.openai.com',
    customModels: parseCustomModels(config.customModels),
    modelCapabilities: parseModelCapabilities(config.modelCapabilities),
    providerCapabilities: parseProviderCapabilities(config.providerCapabilities),
    timeout: ((config.timeout as number) ?? 120) > 0 ? ((config.timeout as number) ?? 120) * 1000 : undefined,
    temperature: (config.temperature as number) ?? 0.7,
    maxTokens: (config.maxTokens as number) ?? 4096,
    contextLength: (config.contextLength as number) ?? 128000,
  };

  if (!openaiConfig.apiKey && openaiConfig.baseUrl === 'https://api.openai.com') {
    throw new Error('使用 OpenAI 官方 API 需要配置 apiKey');
  }

  const client = new OpenAIClient(openaiConfig, ctx.logger);
  const baseLabel = `OpenAI (${openaiConfig.baseUrl.replace(/^https?:\/\//, '')})`;

  // 已注册 model entry 的句柄表：modelId → dispose（来自 ctx.provide 返回值）
  const registered = new Map<string, () => void>();

  // refresh 闭包：apply 末尾装配；先占位以打破环依赖。
  let refreshFn: () => Promise<{ added: string[]; removed: string[]; total: number }> = async () => ({
    added: [],
    removed: [],
    total: registered.size,
  });
  const refresh = (): Promise<{ added: string[]; removed: string[]; total: number }> => refreshFn();

  function registerOne(modelId: string): void {
    if (registered.has(modelId)) return;
    const capabilities = resolveCapabilities(
      modelId,
      openaiConfig.modelCapabilities.get(modelId),
      openaiConfig.providerCapabilities,
    );
    const handle = new OpenAIModelHandle(
      client,
      modelId,
      ctx.id,
      openaiConfig.contextLength,
      openaiConfig.maxTokens,
      refresh,
    );
    const dispose = ctx.provide('llm', handle, {
      capabilities,
      label: `${baseLabel} / ${modelId}`,
      entryId: `${ctx.id}/${modelId}`,
    });
    registered.set(modelId, dispose);
  }

  function unregisterOne(modelId: string): void {
    const d = registered.get(modelId);
    if (!d) return;
    try {
      d();
    } catch (err) {
      ctx.logger.warn(`卸载 model entry "${modelId}" 失败: ${err}`);
    }
    registered.delete(modelId);
  }

  async function discoverAllModelIds(): Promise<string[]> {
    const remoteIds = await client.fetchRemoteModelIds();
    const remoteSet = new Set(remoteIds);
    for (const cm of openaiConfig.customModels) {
      if (remoteSet.has(cm)) {
        ctx.logger.warn(`自定义模型 "${cm}" 与自动发现的模型重复，请在配置中去重`);
      }
    }
    return [...remoteIds, ...openaiConfig.customModels.filter(id => !remoteSet.has(id))];
  }

  // 初次注册
  const initialIds = await discoverAllModelIds();
  if (initialIds.length === 0) {
    ctx.logger.warn(`已连接: ${openaiConfig.baseUrl}，但未发现任何可用模型；不注册任何 LLM entry`);
  } else {
    for (const modelId of initialIds) registerOne(modelId);
    ctx.logger.info(`已连接: ${openaiConfig.baseUrl}，注册 ${initialIds.length} 个 model entry`);
  }

  // 装配 refresh 真实实现
  refreshFn = async () => {
    const next = await discoverAllModelIds();
    const nextSet = new Set(next);
    const added: string[] = [];
    const removed: string[] = [];
    for (const id of next) {
      if (!registered.has(id)) {
        registerOne(id);
        added.push(id);
      }
    }
    for (const id of [...registered.keys()]) {
      if (!nextSet.has(id)) {
        unregisterOne(id);
        removed.push(id);
      }
    }
    if (added.length || removed.length) {
      ctx.logger.info(
        `OpenAI 模型列表已刷新: +${added.length} (${added.join(',') || '-'}) / -${removed.length} (${removed.join(',') || '-'}) / 现共 ${registered.size}`,
      );
    } else {
      ctx.logger.debug(`OpenAI 模型列表已刷新: 无变化 (共 ${registered.size})`);
    }
    return { added, removed, total: registered.size };
  };
}
