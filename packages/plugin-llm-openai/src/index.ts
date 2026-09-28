import type { ChatModelRequest, ChatResponse, ChatStreamChunk, LLMCapability, LLMModel } from '@aalis/api-llm';
import { LLMCapabilities, llm } from '@aalis/api-llm';
import type { ToolDefinition } from '@aalis/api-tools';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 的 secret 属性
import { type BoundOf, config, definePlugin, type Logger, lifecycle, logger, provide } from '@aalis/core';
import { type ConfigOf, configError, defineConfig, missingConfigError, parseConfig } from '@aalis/schema-config';
import type { Message, ToolCall } from '@aalis/schema-message';
import { prepareLLMMessages, toLLMRole } from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';

// ===== 插件元数据 =====

/** 已知的内容审查错误关键词 */
const CONTENT_FILTER_PATTERNS = [
  'content exists risk',
  'content_filter',
  'content_policy',
  'sensitive content',
  'risk control',
];

/** 错误信息与日志里附带的摘录上限（字符）。网关的 HTML 错误页可达数十 KB；截断按代理对安全，不留孤代理 */
const ERROR_BODY_MAX_CHARS = 500;

/** 错误信息与日志里附带的摘录：空白（含 HTML 错误页的换行）折叠成一个空格后截断，不把换行带进错误信息与日志 */
function bodyExcerpt(body: string): string {
  return truncateChars(body.replace(/\s+/g, ' ').trim(), ERROR_BODY_MAX_CHARS, '…');
}

/**
 * 读配置时校验 baseUrl，解析不了的与带用户名或密码的抛配置错误。带凭据的 URL fetch 拒发，凭据还会随报错与
 * 条目名称（WebUI 的模型下拉）显示出来；解析不了的无从判断有没有凭据，请求同样发不出去。消息不带 URL
 */
function checkBaseUrl(baseUrl: string): void {
  if (!URL.canParse(baseUrl)) {
    throw configError('baseUrl 不是有效的 URL，需写成完整地址，如 https://api.openai.com/v1');
  }
  const { username, password } = new URL(baseUrl);
  if (username || password) {
    throw configError('baseUrl 不能带用户名或密码（user:pass@），密钥请填在 apiKey');
  }
}

/**
 * 错误信息与日志里显示的 URL：去掉查询串（有的网关把密钥写在查询串里）。没有查询串时原样返回，保留配置里的写法。
 * 带用户名或密码的 baseUrl 读配置时已拒绝（见 checkBaseUrl）
 */
function redactUrl(url: string): string {
  const parsed = new URL(url);
  if (!parsed.search) return url;
  parsed.search = '';
  return parsed.href;
}

/**
 * 错误消息连同底层原因，写成一行。fetch 网络失败的消息固定是「fetch failed」，真实原因（DNS、拒绝连接、TLS）在
 * cause 上；连 localhost 时两个地址族都失败，cause 是消息为空的 AggregateError，原因在它的子错误上
 */
function describeError(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  const reasons: unknown[] = cause instanceof AggregateError ? cause.errors : cause instanceof Error ? [cause] : [];
  const detail = reasons.map(e => (e instanceof Error ? e.message : String(e))).join('; ');
  return `${err instanceof Error ? err.message : String(err)}${detail ? ` ← ${detail}` : ''}`;
}

/** 常见状态码的一句提示 */
function statusHint(status: number): string | undefined {
  if (status === 401 || status === 403) return '密钥无效或没有权限';
  if (status === 402) return '余额不足或需要付费';
  if (status === 404) return '模型或地址不对';
  if (status === 429) return '请求过多或额度不足';
  if (status >= 500) return '上游服务故障';
  return undefined;
}

/**
 * 上游 JSON 错误体里的说明：OpenAI 风格的 error.message、Ollama 风格的 error 字符串，或顶层 message，折成一行并截断。
 * 不是 JSON、没有这些字段或说明是空白时返回空串
 */
function upstreamMessage(body: string): string {
  let data: { error?: string | { message?: unknown }; message?: unknown } | null;
  try {
    data = JSON.parse(body);
  } catch {
    return '';
  }
  const error = data?.error;
  const message =
    typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : data?.message;
  return typeof message === 'string' ? bodyExcerpt(message) : '';
}

/**
 * 非 2xx 应答的错误信息（会经 agent 发回会话）：状态码、常见状态码的一句提示与上游 JSON 里的说明；没有说明时
 * （不是 JSON 或没有说明字段）写「详情见日志」。响应体本身只进日志，由调用方记
 */
function httpErrorMessage(provider: string, status: number, body: string): string {
  const hint = statusHint(status);
  const message = upstreamMessage(body);
  return `${provider} API 错误 (${status})${hint ? `：${hint}` : ''}；${message ? `上游说明：${message}` : '详情见日志'}`;
}

/** 解析 API 错误：内容审查类错误按完整响应体识别，给固定提示；其余见 httpErrorMessage */
function parseApiError(provider: string, status: number, body: string): string {
  const lower = body.toLowerCase();
  if (status === 400 && CONTENT_FILTER_PATTERNS.some(p => lower.includes(p))) {
    return `${provider} 拒绝了此次请求（内容安全策略），请尝试换一个话题或缩短上下文`;
  }
  return httpErrorMessage(provider, status, body);
}

const configSchema = defineConfig({
  apiKey: {
    type: 'string',
    label: 'API Key',
    secret: true,
    onInvalid: 'error',
    description: 'OpenAI API 密钥（本地服务可留空）',
  },
  baseUrl: {
    type: 'string',
    label: 'API 地址',
    default: 'https://api.openai.com/v1',
    onInvalid: 'error',
    description:
      'API 端点完整前缀（含版本段，如 https://api.openai.com/v1）；插件只在其后拼 /chat/completions 与 /models。' +
      '可替换为任何兼容服务（如 Gemini 的 https://generativelanguage.googleapis.com/v1beta/openai）。',
  },
  customModels: {
    type: 'textarea',
    label: '自定义模型',
    default: '',
    description:
      '手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。',
  },
  discoverModels: {
    type: 'boolean',
    label: '自动发现模型',
    default: true,
    description:
      '启动时请求 /models 发现可用模型，WebUI 可刷新模型列表。网关不提供 /models 时关闭：不发发现请求，只注册 customModels（此时必填），也不支持刷新。',
  },
  modelCapabilities: {
    type: 'textarea',
    label: '单模型能力覆盖',
    default: '',
    description:
      '按行指定某个模型的能力集。有该模型的表项时**覆盖**插件启发式推断，与 adapter 默认能力仍取并集。\n格式：`<modelId>: <cap1>,<cap2>,...`，每行一条。如：gpt-4o: chat,tool_calling,vision,streaming\n可用能力：chat / tool_calling / vision / streaming / thinking 等。',
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
  thinkingParam: {
    type: 'boolean',
    label: '透传 thinking 开关（DeepSeek 风格）',
    default: false,
    description:
      '开启后把请求的 think 开关编码为 DeepSeek 风格的 `thinking: {type: enabled|disabled}` 字段发给端点，' +
      '使会话级 /session.set -t 与平台档 think 对本 provider 生效。' +
      '仅在端点是 DeepSeek 或会原样透传该字段的中转时开启——OpenAI 官方端点不认此字段会拒收请求。' +
      '请求未指定 think 时不发送该字段（沿用端点默认）。',
  },
});

type OpenAIConfig = ConfigOf<typeof configSchema>;

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
    /**
     * OpenAI 自动前缀缓存的命中量（≥1024 token 的相同前缀自动生效，无需请求侧声明）。
     * 命中部分按折扣价计费，故上报以便评估缓存收益。兼容代理端点不返回该字段的情形。
     */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * OpenAI 推理模型(o 系列 o1/o3/o4… 与 gpt-5 系列 gpt-5/-mini/-nano/-chat…)：
 * 拒 max_tokens(需 max_completion_tokens)、拒非默认 temperature。
 */
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

// ===== OpenAI 客户端（不是 service、仅是底层 fetch 封装，多个 ModelHandle 共享） =====

class OpenAIClient {
  private apiKey: string | undefined;
  readonly baseUrl: string;
  private timeout: number;
  readonly temperature: number;
  readonly maxTokens: number;
  private thinkingParam: boolean;
  private logger;

  constructor(cfg: OpenAIConfig, logger: Logger) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    // schema 中 timeout 单位为「秒」，存储为毫秒；0 或负数视为不限制 → 用一个非常大的值
    this.timeout = cfg.timeout > 0 ? cfg.timeout * 1000 : 2_147_483_647;
    this.temperature = cfg.temperature;
    this.maxTokens = cfg.maxTokens;
    this.thinkingParam = cfg.thinkingParam;
    this.logger = logger;
  }

  /**
   * 请求的 think 开关 → 线上字段。本插件原本只按真 OpenAI 写（无思考开关，o 系列隐式推理），
   * request.think 一直被无视——走 OpenAI 兼容中转的 DeepSeek 因此收不到会话级开关。
   * DeepSeek 风格 `thinking: {type}` 由配置显式开启（真 OpenAI 端点不认此字段会 400）；
   * think 未指定时不发字段，端点默认行为不被触碰。
   */
  private applyThinking(body: Record<string, unknown>, request: ChatModelRequest): void {
    if (!this.thinkingParam || request.think === undefined) return;
    body.thinking = { type: request.think ? 'enabled' : 'disabled' };
  }

  /** 构造请求头（无 apiKey 时不发 Authorization） */
  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /** 对话请求的非 2xx 应答：截断后的响应体记 warn，抛出的错误见 parseApiError */
  private apiError(status: number, body: string): Error {
    this.logger.warn(`LLM API 错误 (${status}): ${bodyExcerpt(body)}`);
    return new Error(parseApiError('LLM', status, body));
  }

  /**
   * 对话请求没拿到完整应答（fetch 或读响应体时抛出）：原始错误连同原因记 warn，超时与连不上各换成一句说明，其它错误
   * 原样返回。调用方经 request.signal 中止时原样返回、不记日志，agent 按中止收尾
   */
  private requestError(err: unknown, request: ChatModelRequest, startedAt: number): unknown {
    if (request.signal?.aborted) return err;
    this.logger.warn(`LLM 请求失败 (耗时 ${Date.now() - startedAt}ms): ${describeError(err)}`);
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return new Error(`LLM 请求超时：${this.timeout / 1000} 秒内没有完成，可在配置里调大 timeout`);
    }
    if (err instanceof TypeError && err.message === 'fetch failed') {
      return new Error('LLM 连不上服务：检查 baseUrl 与网络，详情见日志');
    }
    return err;
  }

  /** 对话应答按 JSON 解析；不是 JSON 时截断后的应答体记 warn，抛出一行说明 */
  private parseJsonBody(status: number, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      this.logger.warn(`LLM 应答不是 JSON (${status}): ${bodyExcerpt(text)}`);
      throw new Error(`LLM 应答不是 JSON (${status})；详情见日志`);
    }
  }

  /**
   * 发现远端模型列表（仅含 id）。不可达、超时、非 2xx、响应不是 JSON 或不是模型列表时抛出，消息带 URL 与原因
   * （由调用方决定按空列表继续还是报错）；经 signal 中止时抛中止原因
   */
  async fetchRemoteModelIds(signal?: AbortSignal): Promise<string[]> {
    const url = `${this.baseUrl}/models`;
    try {
      // 无超时会让 apply() 里的 await 在「接连接不回包」的端点上停摆到 undici 兜底,
      // 插件按拓扑序串行卡住
      const timeout = AbortSignal.timeout(10_000);
      const res = await fetch(url, {
        headers: this.headers,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} - ${bodyExcerpt(body)}`);
      }
      // 先读成文本再解析：res.json() 的 SyntaxError 会把响应体开头连同换行带进消息
      const text = await res.text();
      let data: { data?: unknown } | null;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`响应不是 JSON: ${bodyExcerpt(text)}`);
      }
      const list = data?.data;
      if (!Array.isArray(list) || !list.every(m => typeof m?.id === 'string')) {
        throw new Error(`响应不是模型列表（需要 data 数组，每项带字符串 id）: ${bodyExcerpt(JSON.stringify(data))}`);
      }
      return list.map(m => m.id);
    } catch (err) {
      signal?.throwIfAborted();
      throw new Error(`模型发现失败 ${redactUrl(url)}: ${describeError(err)}`, { cause: err });
    }
  }

  async chat(model: string, request: ChatModelRequest): Promise<ChatResponse> {
    const messages = prepareLLMMessages(request.messages).map(m => this.toAPIMessage(m));
    const tools = request.tools?.map(t => this.toAPITool(t));

    const reasoning = isReasoningModel(model);
    const body: Record<string, unknown> = {
      model,
      messages,
      // 推理模型(o 系列 / gpt-5 系列)拒 max_tokens(需 max_completion_tokens)且只接受默认 temperature → 分支处理；
      // 缺省回退到配置的 this.maxTokens，而非字面量 4096（遵守 llm-api 契约）。
      [reasoning ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens ?? this.maxTokens,
      ...(reasoning ? {} : { temperature: request.temperature ?? this.temperature }),
    };
    this.applyThinking(body, request);

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    this.logger.debug(`请求 LLM: ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`);

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (request.signal) signals.push(request.signal);

    const startedAt = Date.now();
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      text = await response.text();
    } catch (err) {
      throw this.requestError(err, request, startedAt);
    }

    if (!response.ok) throw this.apiError(response.status, text);

    const data = this.parseJsonBody(response.status, text) as APIChatResponse;
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
        cachedPromptTokens: data.usage.prompt_tokens_details?.cached_tokens,
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
      // 同 chat()：推理模型分支 max_completion_tokens / 略去 temperature，缺省回退 this.maxTokens。
      [reasoning ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens ?? this.maxTokens,
      ...(reasoning ? {} : { temperature: request.temperature ?? this.temperature }),
      stream: true,
      // 流式必须显式声明才会在收尾帧返回 usage（真 OpenAI 端点无此开关则整条流不含 usage）。
      stream_options: { include_usage: true },
    };
    this.applyThinking(body, request);

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    this.logger.debug(`流式请求 LLM: ${body.model}, ${messages.length} 条消息`);

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (request.signal) signals.push(request.signal);

    const reqStart = Date.now();
    const slowConnectTimer = setTimeout(() => {
      this.logger.warn(`LLM 连接慢：已等待 15s 仍未收到响应头 (url=${this.baseUrl}/chat/completions)`);
    }, 15_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      clearTimeout(slowConnectTimer);
      throw this.requestError(err, request, reqStart);
    }
    clearTimeout(slowConnectTimer);
    this.logger.debug(`LLM 响应头到达: status=${response.status}, 耗时 ${Date.now() - reqStart}ms`);

    if (!response.ok) {
      const errorText = await response.text().catch((err: unknown) => {
        throw this.requestError(err, request, reqStart);
      });
      throw this.apiError(response.status, errorText);
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
            const chunk: ChatStreamChunk = {};

            // usage 必须在 delta 守卫**之前**取：OpenAI 的 include_usage 形态把
            // usage 挂在 `choices: []` 的收尾帧上，等到守卫之后再取整帧已被跳过。
            if (data.usage) {
              chunk.usage = {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.prompt_tokens + data.usage.completion_tokens,
                cachedPromptTokens: data.usage.prompt_tokens_details?.cached_tokens,
              };
            }

            const delta = data.choices?.[0]?.delta;
            if (!delta) {
              if (chunk.usage) yield chunk; // 纯 usage 收尾帧照样上报
              continue;
            }

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

            if (chunk.contentDelta || chunk.usage || chunk.toolCallProgress) {
              yield chunk;
            }
          } catch {
            /* skip malformed JSON */
          }
        }
      }
    } catch (err) {
      // 读流时超时或连接中断
      throw this.requestError(err, request, reqStart);
    } finally {
      clearTimeout(streamStallTimer);
      // cancel 而非仅 releaseLock：中止/提前退出时要主动关闭响应体。releaseLock 只是放锁，
      // 底层流仍开着——被打断的生成会让 undici 挂着半读的响应与套接字，直到请求超时兜底
      // 才释放（本地慢生成 + lane 中止高频后，这类残留一挂就是整个超时窗）。
      // cancel 自带放锁。三条退出路径的语义：读尽 EOF（done:true）→ 流已 closed，cancel 是
      // 真 no-op；收到终帧即 return（未读到 EOF）与消费方提前 break → cancel 中止残余响应体，
      // 这正是本修复要的「立即交还套接字」，代价是该连接不回 keep-alive 池。
      await reader.cancel().catch(() => {});
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

// resolveCapabilities 的前缀匹配按表序取第一个命中，更具体的前缀必须排在更短的前缀之前
// （gpt-4.1 在 gpt-4 之前，否则 gpt-4.1-mini 会命中 gpt-4、丢掉 Vision）。
// 表里的 Vision 影响 media 的视觉路由、vision.delivery=auto 的交付判定，以及 media 缺席时
// WebUI（/api/status）是否显示图片上传按钮；漏标只是退回识别模型转文字，误标会把原图直通给
// 不收图的模型，故只收确认全系支持看图的族。
const MODEL_CAPABILITIES: Record<string, LLMCapability[]> = {
  'gpt-4o': [Chat, ToolCalling, Streaming, Vision],
  'gpt-4o-mini': [Chat, ToolCalling, Streaming, Vision],
  'gpt-4.1': [Chat, ToolCalling, Streaming, Vision],
  'gpt-4-turbo': [Chat, ToolCalling, Streaming],
  'gpt-4': [Chat, ToolCalling, Streaming],
  'gpt-5': [Chat, ToolCalling, Streaming, Vision, Thinking],
  'gpt-3.5-turbo': [Chat, ToolCalling, Streaming],
  o1: [Chat, Thinking],
  'o1-mini': [Chat, Thinking],
  'o1-preview': [Chat, Thinking],
  o3: [Chat, ToolCalling, Streaming, Thinking],
  'o3-mini': [Chat, ToolCalling, Streaming, Thinking],
  'o4-mini': [Chat, ToolCalling, Streaming, Thinking],
  // Gemini chat 族（OpenAI 兼容端点/聚合网关）：全系多模态。用具体版本前缀而非裸
  // 'gemini-'，避免把 gemini-embedding-* 等非对话模型也误挂 Vision（media 视觉路由
  // vision.prefer 留空时会误选）。resolveCapabilities 做前缀匹配，故各写一条。
  'gemini-1.5': [Chat, ToolCalling, Streaming, Vision],
  'gemini-2': [Chat, ToolCalling, Streaming, Vision],
  'gemini-pro': [Chat, ToolCalling, Streaming, Vision],
  'gemini-flash': [Chat, ToolCalling, Streaming, Vision],
  'gemini-exp': [Chat, ToolCalling, Streaming, Vision],
  // 通义千问与智谱的视觉族（DashScope / 智谱开放平台的兼容端点）。只声明看图，工具调用各型号不一，不标
  'qwen-vl': [Chat, Streaming, Vision],
  'qwen2.5-vl': [Chat, Streaming, Vision],
  'qwen3-vl': [Chat, Streaming, Vision],
  'glm-4v': [Chat, Streaming, Vision],
  'glm-4.1v': [Chat, Streaming, Vision],
  'glm-4.5v': [Chat, Streaming, Vision],
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
function parseCustomModels(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 解析用户能力覆盖配置（textarea）。格式：每行 `<modelId>: cap1,cap2,...`。
 * 返回 Map，供 resolveCapabilities() 作为 userOverride（覆盖而非叠加）。
 *
 * 按**最后一个**冒号切分：兼容端点的模型 id 可能自带冒号（Ollama /v1 的 `qwen3:8b`、
 * OpenRouter 的 `xxx:free`、OpenAI 微调模型 `ft:gpt-4o-mini:org::id`），按首个冒号切会把 id
 * 截断、能力段变成 `8b: chat`，这行覆盖永远不命中。能力名本身不含冒号，故末位冒号即分隔符。
 */
function parseModelCapabilities(raw: string): Map<string, LLMCapability[]> {
  const out = new Map<string, LLMCapability[]>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.lastIndexOf(':');
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
function parseProviderCapabilities(raw: string): LLMCapability[] {
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
    /** 该 model 的能力元数据（供 media 发现/下拉展示读取，非 DI 选择机制）。 */
    readonly capabilities: readonly LLMCapability[],
    /** Provider 级共享的 refresh 闭包；webui 按 providerId 找到该 provider 的任一 entry 调一次即可。关闭模型发现时没有 */
    readonly refresh?: () => Promise<{ added: string[]; removed: string[]; total: number }>,
  ) {}

  chat(request: ChatModelRequest): Promise<ChatResponse> {
    return this.client.chat(this.id, request);
  }

  chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
    return this.client.chatStream(this.id, request);
  }
}

// ===== 插件定义 =====

const uses = { config, logger, lifecycle, provide };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-llm-openai',
  displayName: 'OpenAI',
  subsystem: 'llm',
  configSchema,
  reusable: true,
  provides: [llm],
  uses,
  apply: registerModels,
});

async function registerModels({ config, logger, lifecycle, provide }: Caps): Promise<void> {
  const cfg = parseConfig(configSchema, config, logger);
  const customModels = parseCustomModels(cfg.customModels);
  const modelCapabilities = parseModelCapabilities(cfg.modelCapabilities);
  const providerCapabilities = parseProviderCapabilities(cfg.providerCapabilities);

  checkBaseUrl(cfg.baseUrl);
  // 官方端点判定按 URL host（前缀字符串匹配会误伤 api.openai.com.cn 等镜像域名）
  const isOfficialOpenAI = new URL(cfg.baseUrl).hostname === 'api.openai.com';
  if (!cfg.apiKey && isOfficialOpenAI) {
    throw missingConfigError('apiKey', '使用 OpenAI 官方 API 时必填');
  }
  if (!cfg.discoverModels && customModels.length === 0) {
    throw missingConfigError('customModels', '关闭 discoverModels 时必填');
  }

  const client = new OpenAIClient(cfg, logger);
  const baseLabel = `OpenAI (${cfg.baseUrl.replace(/^https?:\/\//, '')})`;
  const shownBaseUrl = redactUrl(cfg.baseUrl);

  // 已注册 model entry 的句柄表：modelId → dispose（来自 provide 返回值）
  const registered = new Map<string, () => void>();

  // 关闭模型发现时不提供 refresh：没有可重新发现的列表
  const refresh = cfg.discoverModels ? refreshModels : undefined;

  function registerOne(modelId: string): void {
    if (registered.has(modelId)) return;
    const capabilities = resolveCapabilities(modelId, modelCapabilities.get(modelId), providerCapabilities);
    const handle = new OpenAIModelHandle(
      client,
      modelId,
      lifecycle.id,
      cfg.contextLength,
      cfg.maxTokens,
      capabilities,
      refresh,
    );
    const dispose = provide(llm, handle, {
      label: `${baseLabel} / ${modelId}`,
      entryId: `${lifecycle.id}/${modelId}`,
    });
    registered.set(modelId, dispose);
  }

  function unregisterOne(modelId: string): void {
    const d = registered.get(modelId);
    if (!d) return;
    try {
      d();
    } catch (err) {
      logger.warn(`卸载 model entry "${modelId}" 失败: ${err}`);
    }
    registered.delete(modelId);
  }

  /** 自动发现的模型并上 customModels（与自动发现重复的告警） */
  function withCustomModels(remoteIds: string[]): string[] {
    const remoteSet = new Set(remoteIds);
    for (const cm of customModels) {
      if (remoteSet.has(cm)) {
        logger.warn(`自定义模型 "${cm}" 与自动发现的模型重复，请在配置中去重`);
      }
    }
    return [...remoteIds, ...customModels.filter(id => !remoteSet.has(id))];
  }

  // 初次注册。停用或停机时中止探测（中止即抛出）；发现失败按未发现远端模型继续，customModels 照常注册；
  // 关闭模型发现时只注册 customModels。发现失败只留消息：消息里已带 URL 与原因（cause 也内联在内），
  // err 交给 logger 会按因果链把原因再记一遍
  let discoveryError: string | undefined;
  const remoteIds = cfg.discoverModels
    ? await client.fetchRemoteModelIds(lifecycle.signal).catch((err: unknown) => {
        discoveryError = err instanceof Error ? err.message : String(err);
        return [];
      })
    : [];
  lifecycle.signal.throwIfAborted();
  const initialIds = withCustomModels(remoteIds);
  // 一个模型都没有时抛配置错误，原因成为实例的错误信息；否则只剩 core 的「声明 provides [llm] 但未实际注册」。
  // 提示写在原因之前：原因里可能带着一段响应体
  if (initialIds.length === 0) {
    throw configError(
      discoveryError
        ? `未配置 customModels，没有可注册的模型；${discoveryError}`
        : `已连接 ${shownBaseUrl}，但未发现任何可用模型；可在 customModels 里写明要用的模型`,
    );
  }
  if (discoveryError) logger.warn(`启动时只注册 customModels 里的模型；${discoveryError}`);
  for (const modelId of initialIds) registerOne(modelId);
  logger.info(
    !cfg.discoverModels
      ? `未开启模型发现: ${shownBaseUrl}，注册 customModels 里的 ${initialIds.length} 个 model entry`
      : discoveryError
        ? `模型发现失败: ${shownBaseUrl}，注册 customModels 里的 ${initialIds.length} 个 model entry`
        : `已连接: ${shownBaseUrl}，注册 ${initialIds.length} 个 model entry`,
  );

  /**
   * 重新发现并按差异增删条目（WebUI 触发）。与初次注册一样随停用或停机中止：中止即抛出，不再增删条目。
   * 发现失败同样抛出（WebUI 据此报错）、不增删条目：按空列表处理会把自动发现的条目全部注销
   */
  async function refreshModels(): Promise<{ added: string[]; removed: string[]; total: number }> {
    const next = withCustomModels(await client.fetchRemoteModelIds(lifecycle.signal));
    lifecycle.signal.throwIfAborted();
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
      logger.info(
        `OpenAI 模型列表已刷新: +${added.length} (${added.join(',') || '-'}) / -${removed.length} (${removed.join(',') || '-'}) / 现共 ${registered.size}`,
      );
    } else {
      logger.debug(`OpenAI 模型列表已刷新: 无变化 (共 ${registered.size})`);
    }
    return { added, removed, total: registered.size };
  }
}
