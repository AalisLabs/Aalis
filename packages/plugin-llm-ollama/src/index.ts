import type {
  ChatModelRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMCapability,
  LLMModel,
  ThinkingLevel,
  ThinkingLevels,
} from '@aalis/api-llm';
import {
  finishReasonOf,
  IDLE_TIMEOUT_MAX_MS,
  idleTimeout,
  LLMCapabilities,
  llm,
  metered,
  requestedThinking,
} from '@aalis/api-llm';
import { type ProcessService, processService } from '@aalis/api-process';
import type { ToolDefinition } from '@aalis/api-tools';
import {
  type BoundOf,
  config,
  definePlugin,
  events,
  type Logger,
  lifecycle,
  logger,
  optional,
  provide,
} from '@aalis/core';
import { type ConfigOf, configError, defineConfig, missingConfigError, parseConfig } from '@aalis/schema-config';
import { TextError, type TextRef, textClauses, textOf, toSource } from '@aalis/schema-i18n';
import type { Message, ToolCall } from '@aalis/schema-message';
import { prepareLLMMessages, toLLMRole } from '@aalis/schema-message';
import { safeFetch } from '@aalis/util-network-guard';
import { truncateChars } from '@aalis/util-text-normalize';
import { Agent } from 'undici';
import { t } from './texts.js';

// ===== 插件元数据 =====

/** 远程图片/音频下载硬上限（附件缓存默认 10MiB 且可配；此处是缓存失败回退直下时的兜底硬顶）。 */
const MAX_REMOTE_BINARY_BYTES = 20 * 1024 * 1024;

/** 错误信息与日志里附带的摘录上限（字符）。反向代理的 HTML 错误页可达数十 KB；截断按代理对安全，不留孤代理 */
const ERROR_BODY_MAX_CHARS = 500;

/** 错误信息与日志里附带的摘录：空白（含 HTML 错误页的换行）折叠成一个空格后截断，不把换行带进错误信息与日志 */
function bodyExcerpt(body: string): string {
  return truncateChars(body.replace(/\s+/g, ' ').trim(), ERROR_BODY_MAX_CHARS, '…');
}

/**
 * 读配置时校验 baseUrl，解析不了的、带查询串或片段的与带用户名或密码的抛配置错误。插件在 baseUrl 后面拼路径，带查询串或
 * 片段时路径落进查询串或片段，请求地址是坏的；末尾只有一个 ? 时解析后查询串为空，拼出来照样是坏的，所以按原文判。带凭据
 * 的 URL fetch 拒发，凭据还会随报错与条目名称（WebUI 的模型下拉）显示出来；解析不了的无从判断有没有凭据，请求同样发不
 * 出去。消息不带 URL
 */
function checkBaseUrl(baseUrl: string): void {
  if (!URL.canParse(baseUrl)) {
    throw configError(t('baseUrlInvalid'));
  }
  if (/[?#]/.test(baseUrl)) {
    throw configError(t('baseUrlQuery'));
  }
  const { username, password } = new URL(baseUrl);
  if (username || password) {
    throw configError(t('baseUrlCredentials'));
  }
}

/**
 * 错误连同底层原因，写成一行（日志取 toSource）。fetch 网络失败的消息固定是「fetch failed」，真实原因（DNS、拒绝连接、TLS）
 * 在 cause 上；连 localhost 时两个地址族都失败，cause 是消息为空的 AggregateError，原因在它的子错误上
 */
function describeError(err: unknown): string | TextRef {
  const cause = err instanceof Error ? err.cause : undefined;
  const reasons: unknown[] = cause instanceof AggregateError ? cause.errors : cause instanceof Error ? [cause] : [];
  const detail = reasons.map(e => (e instanceof Error ? e.message : String(e))).join('; ');
  return detail ? t('withCause', { error: textOf(err), detail }) : textOf(err);
}

/** 常见状态码的一句提示 */
function statusHint(status: number): TextRef | undefined {
  if (status === 401 || status === 403) return t('hintAuth');
  if (status === 402) return t('hintPayment');
  if (status === 404) return t('hintNotFound');
  if (status === 429) return t('hintRateLimit');
  if (status >= 500) return t('hintUpstream');
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
function httpErrorMessage(provider: string, status: number, body: string): TextRef {
  const hint = statusHint(status);
  const message = upstreamMessage(body);
  return textClauses([
    hint ? t('apiErrorHint', { provider, status, hint }) : t('apiError', { provider, status }),
    message ? t('upstreamMessage', { message }) : t('seeLogs'),
  ]);
}

/**
 * 流式读取响应体并限额：Content-Length 头超限即拒；流式累计超限即断，返回 null。
 * 不能用 res.arrayBuffer()——无 Content-Length 的响应会全量缓冲后才可见大小。
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) return null;
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** 报告了思考能力的模型允许的档位：开关型，翻成 think 开关 */
const THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'off', label: t('levelOff') },
  { id: 'on', label: t('levelOn') },
];

const configSchema = defineConfig({
  baseUrl: {
    type: 'string',
    label: t('baseUrlLabel'),
    default: 'http://localhost:11434',
    onInvalid: 'error',
    description: t('baseUrlDescription'),
  },
  customModels: {
    type: 'textarea',
    label: t('customModelsLabel'),
    default: '',
    description: t('customModelsDescription'),
  },
  discoverModels: {
    type: 'boolean',
    label: t('discoverModelsLabel'),
    default: true,
    description: t('discoverModelsDescription'),
  },
  modelCapabilities: {
    type: 'textarea',
    label: t('modelCapabilitiesLabel'),
    default: '',
    description: t('modelCapabilitiesDescription'),
  },
  providerCapabilities: {
    type: 'string',
    label: t('providerCapabilitiesLabel'),
    default: '',
    description: t('providerCapabilitiesDescription'),
  },
  timeout: {
    type: 'number',
    label: t('timeoutLabel'),
    default: 120,
    description: t('timeoutDescription'),
  },
  temperature: { type: 'number', label: t('temperatureLabel'), default: 0.7, description: t('temperatureDescription') },
  maxTokens: {
    type: 'number',
    label: t('maxTokensLabel'),
    default: 4096,
    min: 1,
    integer: true,
    onInvalid: 'error',
    description: t('maxTokensDescription'),
  },
  contextLength: {
    type: 'number',
    label: t('contextLengthLabel'),
    default: 8192,
    description: t('contextLengthDescription'),
  },
  keepAlive: {
    type: 'string',
    label: t('keepAliveLabel'),
    default: '5m',
    description: t('keepAliveDescription'),
  },
  thinking: {
    type: 'select',
    label: t('thinkingLabel'),
    default: 'on',
    options: THINKING_LEVELS.map(level => ({ label: level.label, value: level.id })),
    description: t('thinkingDescription'),
  },
});

// ===== 配置 =====

type OllamaConfig = ConfigOf<typeof configSchema>;

// ===== Ollama API 消息格式 =====

interface OllamaMessage {
  role: string;
  content: string;
  thinking?: string;
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
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  /** 结束原因（stop、length、load 等），只在 done 那一帧上 */
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama 原生 tool_calls → ToolCall。Ollama 不给调用 id，由这里现造；非流式、流式终帧与
 * 流意外结束三条路径共用，id 统一带时间戳——下游按 id 配对调用与结果（tool-search、
 * memory-summary 的工具名映射），跨回合撞 id 会把工具名或结果配错。无调用时返回 undefined。
 */
function finalizeToolCalls(calls: OllamaToolCall[] | undefined): ToolCall[] | undefined {
  if (!calls || calls.length === 0) return undefined;
  return calls.map((tc, i) => ({
    id: `call_ollama_${Date.now()}_${i}`,
    type: 'function' as const,
    function: {
      name: tc.function.name,
      arguments: JSON.stringify(tc.function.arguments),
    },
  }));
}

// ===== <think> 标签解析辅助 =====

/**
 * 检查 text 末尾是否有不完整的 tag 前缀。
 * 返回匹配到的部分长度（0 = 无匹配）。
 *
 * 例如 findPartialTag("hello<th", "<think>") → 3（匹配 "<th"）
 */
function findPartialTag(text: string, tag: string): number {
  // 从 tag 长度 -1 开始向下检查，直到 1
  const maxCheck = Math.min(tag.length - 1, text.length);
  for (let len = maxCheck; len >= 1; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

/**
 * 从完整文本中提取 <think>...</think> 内容。
 * 返回 { reasoning, content }，reasoning 为思考内容，content 为剩余内容。
 */
function extractThinkTags(text: string): { reasoning: string; content: string } {
  let reasoning = '';
  let content = '';
  let remaining = text;

  while (remaining.length > 0) {
    const openIdx = remaining.indexOf('<think>');
    if (openIdx === -1) {
      content += remaining;
      break;
    }
    content += remaining.slice(0, openIdx);
    remaining = remaining.slice(openIdx + 7);
    const closeIdx = remaining.indexOf('</think>');
    if (closeIdx === -1) {
      // 未闭合的 think 标签，剩余全部视为 reasoning
      reasoning += remaining;
      break;
    }
    reasoning += remaining.slice(0, closeIdx);
    remaining = remaining.slice(closeIdx + 8);
  }

  return { reasoning, content };
}

// ===== Ollama 客户端（共享底层 fetch 封装，多个 ModelHandle 复用） =====

class OllamaClient {
  readonly baseUrl: string;
  private timeout: number;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly contextLength: number;
  readonly keepAlive: string;
  private logger: Logger;
  private proc: ProcessService | null;
  /**
   * 生成请求的连接池：不设等响应头与读响应体的时限（默认各 300 秒），timeout 是唯一的时限。dispatcher 是 Node 自带 fetch
   * 认的扩展字段，DOM 的 RequestInit 里没有（测试的类型检查带 DOM），带它的选项按 RequestInit 断言
   */
  private readonly dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

  constructor(
    config: OllamaConfig,
    logger: Logger,
    proc: ProcessService | null,
    private readonly activation: AbortSignal,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    // schema 中 timeout 单位为「秒」，存储为毫秒；0 或负数不限，超过定时器上限按上限计，报错里的秒数是生效的值（见 idleTimeout）
    this.timeout = Math.min(config.timeout * 1000, IDLE_TIMEOUT_MAX_MS);
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.contextLength = config.contextLength;
    this.keepAlive = config.keepAlive;
    this.logger = logger;
    this.proc = proc;
  }

  /**
   * 停用时关掉生成请求的连接池。在飞的请求不用等：它们的信号合着本插件这次激活的（见 signalOf），停用开始时已经中止；
   * 停用之后发来的请求由入口的 refuseIfClosed 拒绝（报插件已停用或重载）
   */
  close(): void {
    void this.dispatcher.close();
  }

  /** 对话请求的非 2xx 应答：截断后的响应体记 warn，抛出的错误见 httpErrorMessage */
  private apiError(status: number, body: string): Error {
    this.logger.warn(`Ollama API 错误 (${status}): ${bodyExcerpt(body)}`);
    return new TextError(httpErrorMessage('Ollama', status, body));
  }

  /** 本插件已停用或重载（停用之后还拿着旧句柄发来的请求）：不发，报插件已停用或重载、这次请求没有发出 */
  private refuseIfClosed(): void {
    if (this.activation.aborted) throw new TextError(t('pluginClosed'));
  }

  /** 这次请求的中止信号：调用方的与本插件这次激活的合起来，调用方没中止、本插件停用或重载时请求同样停下 */
  private signalOf(request: ChatModelRequest): AbortSignal {
    return request.signal ? AbortSignal.any([request.signal, this.activation]) : this.activation;
  }

  /** 这次请求已中止时抛出：调用方中止的抛它的中止原因，本插件停用或重载的报中途停下 */
  private throwIfAborted(request: ChatModelRequest): void {
    request.signal?.throwIfAborted();
    if (this.activation.aborted) throw new TextError(t('pluginStopped'));
  }

  /**
   * 对话请求没拿到完整应答（fetch 或读响应体时抛出）：原始错误连同原因记 warn，超时与连不上各换成一句说明，其它错误原样
   * 返回。调用方经 request.signal 中止时原样返回、不记日志，agent 按中止收尾；本插件停用或重载时中止的报中途停下，不记日志
   */
  private requestError(err: unknown, request: ChatModelRequest, startedAt: number): unknown {
    if (request.signal?.aborted) return err;
    if (this.activation.aborted) return new TextError(t('pluginStopped'));
    this.logger.warn(`Ollama 请求失败 (耗时 ${Date.now() - startedAt}ms): ${toSource(describeError(err))}`);
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return new TextError(t('requestTimeout', { seconds: this.timeout / 1000 }));
    }
    if (err instanceof TypeError && err.message === 'fetch failed') return new TextError(t('unreachable'));
    return err;
  }

  /** 对话应答按 JSON 解析；不是 JSON 时截断后的应答体记 warn，抛出一行说明 */
  private parseJsonBody(status: number, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      this.logger.warn(`Ollama 应答不是 JSON (${status}): ${bodyExcerpt(text)}`);
      throw new TextError(t('notJson', { status }));
    }
  }

  /**
   * 发现远端模型 id 列表。不可达、超时、非 2xx、响应不是 JSON 或不是模型列表时抛出，消息带 URL 与原因
   * （由调用方决定按空列表继续还是报错）；经 signal 中止时抛中止原因
   */
  async fetchRemoteModelIds(signal?: AbortSignal): Promise<string[]> {
    const url = `${this.baseUrl}/api/tags`;
    try {
      // 无超时会让 apply() 里的 await 在「接连接不回包」的端点上停摆到 undici 兜底,
      // 插件按拓扑序串行卡住
      const timeout = AbortSignal.timeout(10_000);
      const res = await fetch(url, {
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} - ${bodyExcerpt(body)}`);
      }
      // 先读成文本再解析：res.json() 的 SyntaxError 会把响应体开头连同换行带进消息
      const text = await res.text();
      let data: { models?: unknown } | null;
      try {
        data = JSON.parse(text);
      } catch {
        throw new TextError(t('discoveryNotJson', { excerpt: bodyExcerpt(text) }));
      }
      const list = data?.models;
      if (!Array.isArray(list) || !list.every(m => typeof m?.name === 'string')) {
        throw new TextError(t('discoveryNotList', { excerpt: bodyExcerpt(JSON.stringify(data)) }));
      }
      return list.map(m => m.name);
    } catch (err) {
      signal?.throwIfAborted();
      throw new TextError(t('discoveryFailed', { url, error: describeError(err) }), { cause: err });
    }
  }

  /**
   * 查某模型的真实能力(Ollama /api/show 的 `capabilities`,如 completion/vision/audio/tools/thinking）。
   * 失败（含经 signal 中止）返回 null → 调用方回退家族表。fetch 不读 proxy 环境变量,本机调用不受 SOCKS 影响。
   */
  async fetchModelCapabilities(modelId: string, signal?: AbortSignal): Promise<string[] | null> {
    try {
      const timeout = AbortSignal.timeout(10000);
      const res = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { capabilities?: string[] };
      return Array.isArray(data.capabilities) ? data.capabilities : null;
    } catch {
      return null;
    }
  }

  /**
   * chat / chatStream 共用的 /api/chat 请求体（两侧只差 stream 标志；分开写曾让两侧漂移）。
   * 先走 prepareLLMMessages（归一 role + 拼 kind/自定义 role 内容前缀），否则丢
   * [系统通知]/[跨会话委派] 等前缀。level 是这次的思考档位，不能调的模型没有
   */
  private async buildRequestBody(
    model: string,
    request: ChatModelRequest,
    level: string | undefined,
    stream: boolean,
  ): Promise<{ body: Record<string, unknown>; messages: OllamaMessage[]; tools?: OllamaTool[] }> {
    const messages = await Promise.all(prepareLLMMessages(request.messages).map(m => this.toOllamaMessage(m, request)));
    const tools = request.tools?.map(t => this.toOllamaTool(t));

    const body: Record<string, unknown> = {
      model,
      messages,
      stream,
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

    // 能思考的模型总是明说 think：gemma4:31b 等原生思考模型省略字段会默认思考，content 可能为空。没有思考能力的模型不发
    if (level !== undefined) body.think = level === 'on';
    return { body, messages, tools };
  }

  async chat(model: string, request: ChatModelRequest, level: string | undefined): Promise<ChatResponse> {
    this.refuseIfClosed();
    // 包含音频输入 → 改走 OpenAI 兼容的 /v1/chat/completions（/api/chat 不支持 audios）
    if (request.messages.some(m => m.audios && m.audios.length > 0)) {
      return this.chatOpenAIWithAudio(model, request, level);
    }
    const { body, messages, tools } = await this.buildRequestBody(model, request, level, false);

    this.logger.debug(
      `请求 Ollama${level ? ` (思考 ${level})` : ''}: ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`,
    );

    const startedAt = Date.now();
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: idleTimeout(this.timeout, this.signalOf(request)).signal,
        dispatcher: this.dispatcher,
      } as RequestInit);
      text = await response.text();
    } catch (err) {
      throw this.requestError(err, request, startedAt);
    }

    if (!response.ok) throw this.apiError(response.status, text);

    const data = this.parseJsonBody(response.status, text) as OllamaChatResponse;

    // 发了 think 时思考由 Ollama 管、走原生 thinking 字段，正文照原样；没发时才把正文里 <think> 标签之间的内容当思考
    const nativeThinking = data.message.thinking || '';
    const rawContent = data.message.content || '';
    const { reasoning: tagReasoning, content: cleanContent } =
      level === undefined ? extractThinkTags(rawContent) : { reasoning: '', content: rawContent };
    const allReasoning = [nativeThinking, tagReasoning].filter(Boolean).join('');

    const result: ChatResponse = {
      content: cleanContent || null,
      reasoningContent: allReasoning || null,
      finishReason: finishReasonOf(data.done_reason),
    };

    const toolCalls = finalizeToolCalls(data.message.tool_calls);
    if (toolCalls) result.toolCalls = toolCalls;

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

  async *chatStream(
    model: string,
    request: ChatModelRequest,
    level: string | undefined,
  ): AsyncIterable<ChatStreamChunk> {
    this.refuseIfClosed();
    // 包含音频输入 → 回退为非流式（OpenAI compat 路径不支持 SSE 交互）后以单 chunk 交付。
    if (request.messages.some(m => m.audios && m.audios.length > 0)) {
      const r = await this.chatOpenAIWithAudio(model, request, level);
      yield {
        contentDelta: r.content ?? '',
        reasoningDelta: r.reasoningContent ?? '',
        usage: r.usage,
        done: true,
        finishReason: r.finishReason,
      };
      return;
    }
    const { body, messages } = await this.buildRequestBody(model, request, level, true);

    this.logger.debug(`流式请求 Ollama${level ? ` (思考 ${level})` : ''}: ${body.model}, ${messages.length} 条消息`);

    // 交出一段期间不计时：调用方处理一段的时间不算停顿
    const timer = idleTimeout(this.timeout, this.signalOf(request));
    for await (const chunk of this.readStream(body, request, timer, level === undefined)) {
      timer.pause();
      yield chunk;
      timer.resume();
    }
  }

  /**
   * 发出流式请求并逐段解析，timer 管这次请求的停顿超时。parseThinkTags 为真（这次没发 think）时把正文里 <think> 标签之间的
   * 内容当思考交出，为假时正文照原样交出
   */
  private async *readStream(
    body: Record<string, unknown>,
    request: ChatModelRequest,
    timer: ReturnType<typeof idleTimeout>,
    parseThinkTags: boolean,
  ): AsyncIterable<ChatStreamChunk> {
    const reqStart = Date.now();
    const slowConnectTimer = setTimeout(() => {
      this.logger.warn(`Ollama 连接慢：已等待 15s 仍未收到响应头 (url=${this.baseUrl}/api/chat)`);
    }, 15_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: timer.signal,
        dispatcher: this.dispatcher,
      } as RequestInit);
    } catch (err) {
      clearTimeout(slowConnectTimer);
      throw this.requestError(err, request, reqStart);
    }
    clearTimeout(slowConnectTimer);
    this.logger.debug(`Ollama 响应头到达: status=${response.status}, 耗时 ${Date.now() - reqStart}ms`);

    if (!response.ok) {
      const errorText = await response.text().catch((err: unknown) => {
        throw this.requestError(err, request, reqStart);
      });
      throw this.apiError(response.status, errorText);
    }

    if (!response.body) {
      throw new TextError(t('emptyBody'));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCallBuffers: OllamaToolCall[] = [];

    // <think> 标签流式解析状态
    let inThink = false; // 当前是否在 <think> 块内
    let tagBuffer = ''; // 未确定的部分标签缓冲（如 "<", "<th", "</thi" 等）
    let firstChunkLogged = false;
    const streamStart = Date.now();
    const streamStallTimer = setTimeout(() => {
      if (!firstChunkLogged) {
        this.logger.warn(`Ollama 流停滞：响应头已到但 30s 仍未收到首帧`);
      }
    }, 30_000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          clearTimeout(streamStallTimer);
          this.logger.debug(`Ollama 首帧到达: 耗时 ${Date.now() - streamStart}ms (从响应头算起)`);
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const data = JSON.parse(trimmed) as OllamaChatResponse;
            // 带生成内容的帧重新计时：正文（含按标签解析出的思考）、原生思考、工具调用
            if (data.message?.content || data.message?.thinking || data.message?.tool_calls?.length) timer.touch();

            // 累积工具调用
            if (data.message?.tool_calls) {
              toolCallBuffers.push(...data.message.tool_calls);
              // Ollama 是非增量地一次性返回 tool_calls，但我们仍 emit 一次 progress
              // 让上层 UI 知道「已检测到工具调用」（与 OpenAI/DeepSeek 行为对齐）
              for (let i = 0; i < data.message.tool_calls.length; i++) {
                const tc = data.message.tool_calls[i];
                yield {
                  toolCallProgress: {
                    index: toolCallBuffers.length - data.message.tool_calls.length + i,
                    name: tc.function.name,
                    charsAccumulated: JSON.stringify(tc.function.arguments).length,
                  },
                };
              }
            }

            if (data.done) {
              // 刷出残留的 tagBuffer
              if (tagBuffer) {
                if (inThink) yield { reasoningDelta: tagBuffer };
                else yield { contentDelta: tagBuffer };
                tagBuffer = '';
              }

              // 最后一个 chunk
              const chunk: ChatStreamChunk = { done: true, finishReason: finishReasonOf(data.done_reason) };
              const toolCalls = finalizeToolCalls(toolCallBuffers);
              if (toolCalls) chunk.toolCalls = toolCalls;

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

            // 原生 thinking 字段（Ollama think API）
            if (data.message?.thinking) {
              yield { reasoningDelta: data.message.thinking };
            }

            // 发了 think：思考由 Ollama 管，正文照原样交出
            if (data.message?.content && !parseThinkTags) {
              yield { contentDelta: data.message.content };
            } else if (data.message?.content) {
              // 解析 <think> / </think> 标签，将内部内容路由为 reasoningDelta
              let text = tagBuffer + data.message.content;
              tagBuffer = '';

              while (text.length > 0) {
                if (inThink) {
                  // 在 think 块内：查找 </think>
                  const closeIdx = text.indexOf('</think>');
                  if (closeIdx !== -1) {
                    // 找到关闭标签
                    const reasoning = text.slice(0, closeIdx);
                    if (reasoning) yield { reasoningDelta: reasoning };
                    text = text.slice(closeIdx + 8); // '</think>'.length === 8
                    inThink = false;
                  } else {
                    // 未找到完整关闭标签，检查末尾是否有不完整的 "</thi..." 等
                    const partialClose = findPartialTag(text, '</think>');
                    if (partialClose > 0) {
                      const safe = text.slice(0, text.length - partialClose);
                      tagBuffer = text.slice(text.length - partialClose);
                      if (safe) yield { reasoningDelta: safe };
                    } else {
                      yield { reasoningDelta: text };
                    }
                    text = '';
                  }
                } else {
                  // 不在 think 块：查找 <think>
                  const openIdx = text.indexOf('<think>');
                  if (openIdx !== -1) {
                    // 找到开启标签
                    const before = text.slice(0, openIdx);
                    if (before) yield { contentDelta: before };
                    text = text.slice(openIdx + 7); // '<think>'.length === 7
                    inThink = true;
                  } else {
                    // 未找到完整开启标签，检查末尾是否有不完整的 "<thi..." 等
                    const partialOpen = findPartialTag(text, '<think>');
                    if (partialOpen > 0) {
                      const safe = text.slice(0, text.length - partialOpen);
                      tagBuffer = text.slice(text.length - partialOpen);
                      if (safe) yield { contentDelta: safe };
                    } else {
                      yield { contentDelta: text };
                    }
                    text = '';
                  }
                }
              }
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
      // 底层流仍开着——被打断的生成会让 undici 一直持有半读的响应与套接字，直到请求超时兜底
      // 才释放（本地慢生成时回合常被停下，这类残留一挂就是整个超时窗）。
      // cancel 自带放锁。三条退出路径的语义：读尽 EOF（done:true）→ 流已 closed，cancel 是
      // 真 no-op；收到终帧即 return（未读到 EOF）与消费方提前 break → cancel 中止残余响应体，
      // 这正是本修复要的「立即交还套接字」，代价是该连接不回 keep-alive 池。
      await reader.cancel().catch(() => {});
    }

    // 流意外结束时补发 done
    const finalChunk: ChatStreamChunk = { done: true };
    const toolCalls = finalizeToolCalls(toolCallBuffers);
    if (toolCalls) finalChunk.toolCalls = toolCalls;
    yield finalChunk;
  }

  /**
   * 将图片字符串解析为 Ollama 所需的纯 base64 格式。
   * 支持 data URI、HTTP(S) URL、纯 base64、文件路径。返回 null 表示图片无法获取。
   * 所有返回都会去除空白字符（Ollama 校验时不容忍 base64 内的换行/空格，
   * 否则会返回 `illegal base64 data at input byte N` 错误）。
   * 网址的下载随这次请求的中止信号（见 signalOf）停下，中止时按 throwIfAborted 抛出。
   */
  private async resolveImage(img: string, request: ChatModelRequest): Promise<string | null> {
    const sanitize = (b64: string) => b64.replace(/[\s\r\n]+/g, '');
    const trimmed = img.trim();

    // data URI → 提取 base64（兼容多参数格式如 data:image/png;charset=utf-8;base64,...）
    const dataMatch = trimmed.match(/^data:[^,]*;base64,(.+)$/);
    if (dataMatch) return sanitize(dataMatch[1]);

    // HTTP(S) URL → 下载并转 base64（流式限额：超限即断，防超大/恶意资源耗尽内存——
    // 附件缓存侧有 maxBytes 上限，但缓存失败回退原 URL 时会走到这里，此前这一侧不限量）
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const res = await safeFetch(trimmed, {
          signal: AbortSignal.any([AbortSignal.timeout(30000), this.signalOf(request)]),
        });
        if (!res.ok) {
          this.logger.warn(`下载图片失败 (${res.status}): ${trimmed}`);
          return null;
        }
        const buf = await readBodyCapped(res, MAX_REMOTE_BINARY_BYTES);
        if (!buf) {
          this.logger.warn(`下载图片超过体积上限 (${MAX_REMOTE_BINARY_BYTES}B)，已放弃: ${trimmed}`);
          return null;
        }
        return buf.toString('base64');
      } catch (err) {
        // 中止不是图片取不到：这次调用随之停下
        this.throwIfAborted(request);
        this.logger.warn(`下载图片异常: ${trimmed}`, err);
        return null;
      }
    }

    // 其他情况：可能是本地文件路径（file:// 或绝对路径），或者已经是裸 base64。
    // 走 ProcessService.readExternalFile 探测是否为文件，避免把路径当作 base64 送给 Ollama
    // 触发 `illegal base64 data` 错误。读盘失败则按裸 base64 透传。
    // 注意：不治「相对 cwd 路径」场景——该场景脆弱且需要插件层读 process.cwd，
    // 请上游只传绝对路径或 file://。
    if (this.proc && (trimmed.startsWith('file://') || trimmed.startsWith('/'))) {
      try {
        const bytes = await this.proc.readExternalFile(trimmed);
        return Buffer.from(bytes).toString('base64');
      } catch {
        return sanitize(trimmed);
      }
    }
    return sanitize(trimmed);
  }

  /**
   * 解析一条消息里的全部图片，返回成功的那些。
   *
   * `requireImages` 为真时一张都拿不到就抛：视觉识别这类调用里图片就是全部内容，
   * 省掉它降级成纯文本，模型只看得到 prompt 里的占位文字，会照着编出一段描述，
   * 而调用方拿到非空内容便记成识别成功——失败被伪装成幻觉，比报错难查得多。
   * 为假时（同时带图）保持宽松，warn 后按剩余的继续，不打断这一轮。
   */
  private async resolveImages(images: string[], request: ChatModelRequest): Promise<string[]> {
    const resolved = await Promise.all(images.map(img => this.resolveImage(img, request)));
    const valid = resolved.filter((r): r is string => r !== null);
    if (valid.length === images.length) return valid;
    if (valid.length === 0 && request.requireImages === true) {
      throw new TextError(t('imagesUnavailable', { count: images.length }));
    }
    this.logger.warn(`图片获取失败 ${images.length - valid.length}/${images.length} 张，按剩余的继续`);
    return valid;
  }

  /**
   * 转换为 Ollama API 消息格式
   * Ollama 的图片通过 images 字段传递 base64 数据（或 URL）
   * 工具调用结果通过 role: tool 传递
   */
  private async toOllamaMessage(msg: Message, request: ChatModelRequest): Promise<OllamaMessage> {
    // 调用方已经 prepareLLMMessages 处理过：role 已是 WellKnownRole，自定义 role / kind
    // 对应的前缀已拼接进 content。这里只需透传。
    const ollamaMsg: OllamaMessage = {
      role: toLLMRole(msg.role),
      content: msg.content ?? '',
    };

    // 传递思考内容（用于历史上下文）
    if (msg.role === 'assistant' && msg.reasoningContent) {
      ollamaMsg.thinking = msg.reasoningContent;
    }

    // 多模态：Ollama 支持 images 字段（base64 或文件路径）
    if (msg.images && msg.images.length > 0 && msg.role === 'user') {
      const valid = await this.resolveImages(msg.images, request);
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

  /**
   * 调用 Ollama 的 OpenAI 兼容 /v1/chat/completions 端点。当 messages 包含
   * audios 字段时，/api/chat 原生路径不支持，必须走这里。
   * 文本与工具调用等其它能力仍由 chat() 走原生路径。
   */
  async chatOpenAIWithAudio(
    model: string,
    request: ChatModelRequest,
    level: string | undefined,
  ): Promise<ChatResponse> {
    // 将 Aalis Message 转为 OpenAI multimodal content blocks
    const oaiMessages = await Promise.all(
      prepareLLMMessages(request.messages).map(async m => {
        const role = toLLMRole(m.role);
        const blocks: Array<Record<string, unknown>> = [];
        // Modality order：Ollama 官方 best practice 要求 image/audio content
        // 必须在 text 之前。
        if (m.images && m.images.length > 0 && m.role === 'user') {
          for (const b64 of await this.resolveImages(m.images, request)) {
            blocks.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
          }
        }
        if (m.audios && m.audios.length > 0 && m.role === 'user') {
          for (const a of m.audios) {
            const { data, format } = decodeAudioForOpenAI(a);
            blocks.push({ type: 'input_audio', input_audio: { data, format } });
          }
        }
        if (m.content) {
          blocks.push({ type: 'text', text: m.content });
        }
        // 纯文本 → string；有多模态 → array
        const content = blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks;
        return { role, content };
      }),
    );

    const body: Record<string, unknown> = {
      model,
      messages: oaiMessages,
      stream: false,
      max_tokens: request.maxTokens ?? this.maxTokens,
      temperature: request.temperature ?? this.temperature,
    };
    // Ollama 0.20+ 的兼容路径只认 reasoning_effort、不认 /api/chat 的 think：关 → reasoning_effort: "none"，
    // 节省 ~5-8x completion tokens（实测 935 → 155）；开按模型默认，不发
    if (level === 'off') body.reasoning_effort = 'none';

    this.logger.debug(`请求 Ollama (OpenAI compat, audio): ${model}, ${oaiMessages.length} 条消息`);

    // 统计本次发送的音频载荷大小，便于诊断模型是否真的收到了音频
    let totalAudioBytes = 0;
    let audioCount = 0;
    for (const m of oaiMessages) {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          const b = block as { type?: string; input_audio?: { data?: string; format?: string } };
          if (b.type === 'input_audio' && b.input_audio?.data) {
            audioCount++;
            totalAudioBytes += Math.floor((b.input_audio.data.length * 3) / 4);
          }
        }
      }
    }
    if (audioCount > 0) {
      this.logger.info(`[ollama-audio] 发送 ${audioCount} 段音频，合计 ${(totalAudioBytes / 1024).toFixed(1)}KB`);
    }

    const httpT0 = Date.now();
    let resp: Response;
    let respText: string;
    try {
      resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: idleTimeout(this.timeout, this.signalOf(request)).signal,
        dispatcher: this.dispatcher,
      } as RequestInit);
      respText = await resp.text();
    } catch (err) {
      throw this.requestError(err, request, httpT0);
    }
    if (!resp.ok) {
      this.logger.warn(`[ollama-audio] HTTP ${resp.status} 失败 ${Date.now() - httpT0}ms: ${bodyExcerpt(respText)}`);
      throw new TextError(httpErrorMessage('Ollama', resp.status, respText));
    }
    const data = this.parseJsonBody(resp.status, respText) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const rawContent = data.choices?.[0]?.message?.content ?? '';
    const finishReason = data.choices?.[0]?.finish_reason;
    // 与 /api/chat 同一条规则：这次没管思考（level 为 undefined）时才把正文里 <think> 标签之间的内容当思考
    const { reasoning, content } =
      level === undefined ? extractThinkTags(rawContent) : { reasoning: '', content: rawContent };
    const text = content.trim();
    if (audioCount > 0) {
      this.logger.info(
        `[ollama-audio] ${model} HTTP ${Date.now() - httpT0}ms, finish=${finishReason ?? '?'}, ` +
          `raw=${rawContent.length}字 trim=${text.length}字, ` +
          `tokens prompt=${data.usage?.prompt_tokens ?? '?'} completion=${data.usage?.completion_tokens ?? '?'}` +
          (rawContent.length > 0 ? `, 原文="${rawContent.replace(/\n/g, ' ')}"` : ' [模型返回空字符串]'),
      );
    }
    const result: ChatResponse = {
      content: text || null,
      reasoningContent: reasoning || null,
      finishReason: finishReasonOf(finishReason),
    };
    if (data.usage) {
      result.usage = {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      };
    }
    return result;
  }
}

/**
 * data URL 的音频类型（audio/ 之后的部分）→ OpenAI 兼容接口 input_audio 的 format。只收 wav 与 mp3：Ollama 的兼容接口不看
 * format、只把 data 按 base64 解码（ollama 仓的 openai/openai.go），之后按文件头认音频，只认 wav 与 mp3（llm/media.go 的
 * AudioFormat；mlxrunner/model/audio/audio.go 的 Decode 只认 wav）
 */
const AUDIO_FORMATS = new Map([
  ['mpeg', 'mp3'],
  ['mp3', 'mp3'],
  ['wav', 'wav'],
  ['x-wav', 'wav'],
  ['wave', 'wav'],
]);

/**
 * 把 `data:audio/<类型>[;参数];base64,…` 解析为 OpenAI input_audio 需要的 `{ data, format }`。format 只按写明的类型映射；
 * 认不出的类型与不是 data URL 的（本地路径、链接、裸 base64）在发请求前报错：猜成 wav 时上游只回一句解码失败，看不出是格式的事
 */
function decodeAudioForOpenAI(payload: string): { data: string; format: string } {
  const m = payload.match(/^data:audio\/([^;,]+)(?:;[^;,]+)*;base64,(.+)$/);
  if (!m) throw new TextError(t('audioDataUrlOnly'));
  const format = AUDIO_FORMATS.get(m[1].toLowerCase());
  if (!format) throw new TextError(t('audioFormatUnsupported', { format: m[1] }));
  return { data: m[2], format };
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ===== 模型能力映射 =====

const { Chat, ToolCalling, Streaming, Vision, Audio, Thinking } = LLMCapabilities;

// 能力探测（/api/show）失败时的回退。前缀匹配按表序取第一个命中，更具体的前缀排在更短的之前（qwen3-coder 在 qwen3 之前）。
// 原生思考的族标 Thinking：探测失败时照样声明档位、明说 think，省略字段它们会默认思考
const MODEL_CAPABILITIES: Record<string, LLMCapability[]> = {
  'llama3.1': [Chat, ToolCalling, Streaming],
  'llama3.2': [Chat, ToolCalling, Streaming],
  'llama3.3': [Chat, ToolCalling, Streaming],
  llava: [Chat, Streaming, Vision],
  'llava-llama3': [Chat, Streaming, Vision],
  gemma2: [Chat, Streaming],
  gemma3: [Chat, ToolCalling, Streaming, Vision],
  gemma4: [Chat, ToolCalling, Streaming, Vision, Thinking],
  'qwen2.5': [Chat, ToolCalling, Streaming],
  'qwen2.5-coder': [Chat, ToolCalling, Streaming],
  'qwen3-coder': [Chat, ToolCalling, Streaming],
  qwen3: [Chat, ToolCalling, Streaming, Thinking],
  mistral: [Chat, ToolCalling, Streaming],
  'deepseek-r1': [Chat, Streaming, Thinking],
  phi4: [Chat, Streaming],
  'command-r': [Chat, ToolCalling, Streaming],
};

const DEFAULT_CAPABILITIES: LLMCapability[] = [Chat];

/** Ollama /api/show 的 capabilities 字符串 → Aalis LLMCapability(无关项忽略)。 */
function mapOllamaCapabilities(caps: string[]): LLMCapability[] {
  const out = new Set<LLMCapability>();
  for (const c of caps) {
    switch (c.toLowerCase()) {
      case 'completion':
        out.add(Chat);
        break;
      case 'tools':
        out.add(ToolCalling);
        break;
      case 'vision':
        out.add(Vision);
        break;
      case 'audio':
        out.add(Audio);
        break;
      case 'thinking':
        out.add(Thinking);
        break;
      // insert / embedding / 其它:与对话能力无关,忽略
    }
  }
  // Ollama 对话模型一律支持流式
  if (out.size > 0) out.add(Streaming);
  return [...out];
}

/**
 * 解析某模型能力。优先级(高→低):
 *   1. 用户 per-model 覆盖(modelCapabilities,∪ provider 默认)——逃生舱,最高
 *   2. Ollama /api/show 真实能力(detected)——权威;不再叠加 provider 默认,避免误标
 *   3. 家族表启发式(MODEL_CAPABILITIES)——detected 不可用时的回退
 *   4. provider 默认(providerCapabilities) + DEFAULT_CAPABILITIES——最后兜底
 */
function resolveCapabilities(
  model: string,
  userOverride?: unknown,
  providerCaps?: LLMCapability[],
  detected?: string[] | null,
): LLMCapability[] {
  // 1. 用户逐模型覆盖(沿用原语义:与 provider 默认取并集)
  if (Array.isArray(userOverride) && userOverride.length > 0) {
    const out = new Set<LLMCapability>(userOverride as LLMCapability[]);
    for (const c of providerCaps ?? []) out.add(c);
    return [...out];
  }
  // 2. /api/show 真实能力(权威)
  if (detected && detected.length > 0) {
    const mapped = mapOllamaCapabilities(detected);
    // 探测成功但映射不出对话能力(embedding/insert 专用模型):不回退家族表/兜底,
    // 返回空能力让调用方跳过注册——否则 ['embedding'] 会被兜底成 [Chat],
    // 污染 /model 与 WebUI 模型列表,甚至被无 ref 解析选中
    return mapped.includes(Chat) ? mapped : [];
  }
  // 去掉 tag 部分（如 llama3.1:8b → llama3.1）
  const baseName = model.split(':')[0].toLowerCase();
  // Gemma 4 E 系列（e2b / e4b）原生支持音频输入。参考 https://ollama.com/library/gemma4
  const isGemma4Audio = /^gemma4:e[24]b/.test(model.toLowerCase());
  // 3. 家族表启发式回退
  if (MODEL_CAPABILITIES[baseName]) {
    const out = new Set<LLMCapability>(MODEL_CAPABILITIES[baseName]);
    if (isGemma4Audio) out.add(Audio);
    return [...out];
  }
  // 名称明示视觉（llava / vision / vl）的先于前缀匹配判定：否则 llama3.2-vision 会先命中
  // llama3.2、qwen2.5vl 先命中 qwen2.5，丢掉 Vision
  if (baseName.includes('llava') || baseName.includes('vision') || /(?:^|[\d._-])vl(?:$|[\d._-])/.test(baseName)) {
    return [Chat, Streaming, Vision];
  }
  for (const [known, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (baseName.startsWith(known)) {
      const out = new Set<LLMCapability>(caps);
      if (isGemma4Audio) out.add(Audio);
      return [...out];
    }
  }
  // 4. 最后兜底:provider 默认 + Chat
  const out = new Set<LLMCapability>(providerCaps ?? []);
  for (const c of DEFAULT_CAPABILITIES) out.add(c);
  if (isGemma4Audio) out.add(Audio);
  return [...out];
}

/** 解析适配器级别默认能力（逗号/空格/换行分隔） */
function parseProviderCapabilities(raw: string): LLMCapability[] {
  return raw
    .split(/[,\s\n]/)
    .map(s => s.trim())
    .filter(Boolean) as LLMCapability[];
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
 * 解析能力覆盖 textarea：每行 `<modelId>: cap1,cap2,...`
 *
 * 按**最后一个**冒号切分：Ollama 模型 id 自带 tag（`qwen3:8b`、`bge-m3:latest`），
 * 按首个冒号切会把 id 截成 `qwen3`、能力段变成 `8b: chat`，整行报废。
 * 能力名本身不含冒号，故末位冒号即分隔符。
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

// ===== Per-model handle：每个 model 独立的 LLMModel entry =====

class OllamaModelHandle implements LLMModel {
  constructor(
    private client: OllamaClient,
    readonly id: string,
    readonly providerId: string,
    readonly contextLength: number,
    readonly maxOutputTokens: number,
    /** 该 model 的能力元数据（供 media 发现/下拉展示读取，非 DI 选择机制）。 */
    readonly capabilities: readonly LLMCapability[],
    /** 能思考的模型才有：默认档取实例配置 */
    readonly thinking: ThinkingLevels | undefined,
    /** Provider 级共享的 refresh 闭包；webui 按 providerId 找到该 provider 的任一 entry 调一次即可。关闭模型发现时没有 */
    readonly refresh?: () => Promise<{ added: string[]; removed: string[]; total: number }>,
  ) {}

  async chat(request: ChatModelRequest): Promise<ChatResponse> {
    return this.client.chat(this.id, request, this.levelOf(request));
  }

  async *chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
    yield* this.client.chatStream(this.id, request, this.levelOf(request));
  }

  /** 这次的档位：请求带了按请求，没带按默认档；不能调的模型没有 */
  private levelOf(request: ChatModelRequest): string | undefined {
    return requestedThinking(this, request) ?? this.thinking?.default;
  }
}

const uses = { config, logger, lifecycle, provide, events, proc: optional(processService) };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-llm-ollama',
  displayName: 'Ollama',
  subsystem: 'llm',
  configSchema,
  reusable: true,
  provides: [llm],
  uses,
  apply: start,
});

async function start({ config, logger, lifecycle, provide, events, proc }: Caps): Promise<void> {
  const cfg = parseConfig(configSchema, config.use, logger.use);
  const customModels = parseCustomModels(cfg.customModels);
  const modelCapabilities = parseModelCapabilities(cfg.modelCapabilities);
  const providerCapabilities = parseProviderCapabilities(cfg.providerCapabilities);

  checkBaseUrl(cfg.baseUrl);
  if (!cfg.discoverModels && customModels.length === 0) {
    throw missingConfigError('customModels', t('customModelsRequired'));
  }

  const client = new OllamaClient(cfg, logger.use, proc.use, lifecycle.use.signal);
  lifecycle.use.onDispose(() => client.close(), '关闭生成请求的连接池');
  const baseLabel = `Ollama (${cfg.baseUrl.replace(/^https?:\/\//, '')})`;

  // 已注册 model entry 的句柄表：modelId → 该 entry 的退订
  const registered = new Map<string, () => void>();

  // 同 provider 下所有 OllamaModelHandle 共享同一份 refresh。关闭模型发现时不提供：没有可重新发现的列表
  const refresh = cfg.discoverModels ? refreshModels : undefined;

  /** 登记一个 model entry；已登记（如并发的另一次刷新先登记了）或被跳过时返回 false */
  function registerOne(modelId: string, detected?: string[] | null): boolean {
    if (registered.has(modelId)) return false;
    const capabilities = resolveCapabilities(modelId, modelCapabilities.get(modelId), providerCapabilities, detected);
    if (capabilities.length === 0) {
      logger.use.debug(`跳过 model entry "${modelId}": /api/show 未报告对话能力(embedding 等非对话模型)`);
      return false;
    }
    const handle = new OllamaModelHandle(
      client,
      modelId,
      lifecycle.use.id,
      cfg.contextLength,
      cfg.maxTokens,
      capabilities,
      capabilities.includes(Thinking) ? { levels: THINKING_LEVELS, default: cfg.thinking } : undefined,
      refresh,
    );
    const dispose = provide.use(llm, metered(handle, events.use), {
      label: `${baseLabel} / ${modelId}`,
      entryId: `${lifecycle.use.id}/${modelId}`,
    });
    registered.set(modelId, dispose);
    return true;
  }

  function unregisterOne(modelId: string): void {
    const d = registered.get(modelId);
    if (!d) return;
    try {
      d();
    } catch (err) {
      logger.use.warn(`卸载 model entry "${modelId}" 失败: ${err}`);
    }
    registered.delete(modelId);
  }

  /** 自动发现的模型并上 customModels（与自动发现重复的告警） */
  function withCustomModels(remoteIds: string[]): string[] {
    const remoteSet = new Set(remoteIds);
    for (const cm of customModels) {
      if (remoteSet.has(cm)) {
        logger.use.warn(`自定义模型 "${cm}" 与自动发现的模型重复，请在配置中去重`);
      }
    }
    return [...remoteIds, ...customModels.filter(id => !remoteSet.has(id))];
  }

  // 初次注册。停用或停机时中止探测：模型发现中止即抛出，能力探测把中止吞成空结果，所以每次 await 之后自己查。
  // 模型发现失败按未发现远端模型继续，customModels 照常注册；关闭模型发现时只注册 customModels。
  // 发现失败只留消息：消息里已带 URL 与原因（cause 也内联在内），err 交给 logger 会按因果链把原因再记一遍
  let discoveryError: string | TextRef | undefined;
  const remoteIds = cfg.discoverModels
    ? await client.fetchRemoteModelIds(lifecycle.use.signal).catch((err: unknown) => {
        discoveryError = textOf(err);
        return [];
      })
    : [];
  lifecycle.use.signal.throwIfAborted();
  const initialIds = withCustomModels(remoteIds);
  // 一个模型都没有时抛配置错误，原因成为实例的错误信息；否则只剩 core 的「声明 provides [llm] 但未实际注册」。
  // 提示写在原因之前：原因里可能带着一段响应体
  if (initialIds.length === 0) {
    throw configError(
      discoveryError
        ? t('noModelsDiscoveryFailed', { error: discoveryError })
        : t('noModels', { baseUrl: cfg.baseUrl }),
    );
  }
  if (discoveryError) logger.use.warn(`启动时只注册 customModels 里的模型；${toSource(discoveryError)}`);
  // 并行查每个模型的真实能力(顺序保留→注册顺序稳定→优先级稳定);失败者回退家族表。
  const detectedCaps = await Promise.all(initialIds.map(id => client.fetchModelCapabilities(id, lifecycle.use.signal)));
  lifecycle.use.signal.throwIfAborted();
  for (let i = 0; i < initialIds.length; i++) registerOne(initialIds[i], detectedCaps[i]);
  // 模型都被当作非对话模型跳过（如只装了嵌入模型）时同样抛配置错误。只有 /api/show 答复过才会跳过，所以是已连接
  if (registered.size === 0) {
    throw configError(t('noChatModels', { baseUrl: cfg.baseUrl, models: initialIds.join(', ') }));
  }
  logger.use.info(
    !cfg.discoverModels
      ? `Ollama 未开启模型发现: ${cfg.baseUrl}，注册 customModels 里的 ${registered.size} 个 model entry`
      : discoveryError
        ? `Ollama 模型发现失败: ${cfg.baseUrl}，注册 customModels 里的 ${registered.size} 个 model entry`
        : `Ollama 已连接: ${cfg.baseUrl}，注册 ${registered.size} 个 model entry`,
  );

  /**
   * 重新发现并按差异增删条目（WebUI 触发，无需重启插件）。与初次注册一样随停用或停机中止：每次 await 之后自己查，
   * 中止即抛出，不再增删条目。模型发现失败同样抛出（WebUI 据此报错）、不增删条目：按空列表处理会把自动发现的
   * 条目全部注销
   */
  async function refreshModels(): Promise<{ added: string[]; removed: string[]; total: number }> {
    const next = withCustomModels(await client.fetchRemoteModelIds(lifecycle.use.signal));
    lifecycle.use.signal.throwIfAborted();
    const nextSet = new Set(next);
    const added: string[] = [];
    const removed: string[] = [];
    // 新模型的能力并行探测（与初次注册一致），再按发现顺序登记
    const fresh = next.filter(id => !registered.has(id));
    const detectedCaps = await Promise.all(fresh.map(id => client.fetchModelCapabilities(id, lifecycle.use.signal)));
    lifecycle.use.signal.throwIfAborted();
    for (let i = 0; i < fresh.length; i++) {
      // 非对话模型被跳过、等能力探测期间并发的刷新已登记，都不算本次新增
      if (registerOne(fresh[i], detectedCaps[i])) added.push(fresh[i]);
    }
    for (const id of [...registered.keys()]) {
      if (!nextSet.has(id)) {
        unregisterOne(id);
        removed.push(id);
      }
    }
    if (added.length || removed.length) {
      logger.use.info(
        `Ollama 模型列表已刷新: +${added.length} (${added.join(',') || '-'}) / -${removed.length} (${removed.join(',') || '-'}) / 现共 ${registered.size}`,
      );
    } else {
      logger.use.debug(`Ollama 模型列表已刷新: 无变化 (共 ${registered.size})`);
    }
    return { added, removed, total: registered.size };
  }
}
