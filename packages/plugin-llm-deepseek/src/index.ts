import type {
  ChatModelRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMCapability,
  LLMModel,
  ThinkingLevel,
  ThinkingLevels,
  ToolCallProgress,
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
import type { ToolDefinition } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, events, type Logger, lifecycle, logger, provide } from '@aalis/core';
import { type ConfigOf, configError, defineConfig, missingConfigError, parseConfig } from '@aalis/schema-config';
import type { Message, ToolCall } from '@aalis/schema-message';
import { DIRECTIVE_KINDS, prepareLLMMessages, toLLMRole } from '@aalis/schema-message';
import { stripLeakedSpecialTokens, truncateChars } from '@aalis/util-text-normalize';
import { Agent, errors } from 'undici';

// ===== 错误解析 =====

/** 错误信息与日志里附带的摘录上限（字符）。网关的 HTML 错误页可达数十 KB；截断按代理对安全，不留孤代理 */
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
    throw configError('baseUrl 不是有效的 URL，需写成完整地址，如 https://api.deepseek.com');
  }
  if (/[?#]/.test(baseUrl)) {
    throw configError('baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径');
  }
  const { username, password } = new URL(baseUrl);
  if (username || password) {
    throw configError('baseUrl 不能带用户名或密码（user:pass@），密钥请填在 apiKey');
  }
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

// ===== 深度思考的档位 =====

/**
 * 能思考的模型（能力里有 thinking 的）允许的档位，由浅到深，各带它的请求体字段。自动：开启思考，强度由 DeepSeek 按场景
 * 在高与最高之间选。v4 系列不发 thinking 会保持开启，所以关也要明说
 */
const LEVELS = {
  off: { label: '关', fields: { thinking: { type: 'disabled' } } },
  high: { label: '高', fields: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
  auto: { label: '自动', fields: { thinking: { type: 'enabled' } } },
  max: { label: '最高', fields: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } },
} as const;

const THINKING_LEVELS: ThinkingLevel[] = Object.entries(LEVELS).map(([id, { label }]) => ({ id, label }));

// ===== 配置 schema =====

const configSchema = defineConfig({
  apiKey: {
    type: 'string',
    label: 'API Key',
    required: true,
    secret: true,
    onInvalid: 'error',
    description: 'DeepSeek API 密钥',
  },
  baseUrl: {
    type: 'string',
    label: 'API 地址',
    default: 'https://api.deepseek.com',
    onInvalid: 'error',
    description: 'API 端点完整前缀（官方无版本段）；插件只在其后拼 /chat/completions 与 /models',
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
      '启动时请求 /models 发现可用模型。网关不提供 /models 时关闭：不发发现请求，只注册 customModels（此时必填）。',
  },
  modelCapabilities: {
    type: 'textarea',
    label: '单模型能力覆盖',
    default: '',
    description:
      '按行指定某个模型的能力集。有该模型的表项时**覆盖**插件启发式推断，与 adapter 默认能力仍取并集。\n格式：`<modelId>: <cap1>,<cap2>,...`，每行一条。如：deepseek-chat: chat,tool_calling,streaming',
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
    label: '停顿超时 (秒)',
    default: 120,
    description:
      '多久收不到新的生成内容算超时（秒）。一直在输出（含思考内容）不算超时；不流式的请求要在这段时间内收到整份回复。0 = 不限制。',
  },
  temperature: { type: 'number', label: '温度', default: 0.7, description: '0-2，越高越随机' },
  maxTokens: {
    type: 'number',
    label: '最大 Token',
    default: 8192,
    min: 1,
    integer: true,
    onInvalid: 'error',
    description: '单次回复最大生成 token 数，须为正整数，否则实例转为出错',
  },
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
  thinking: {
    type: 'select',
    label: '默认思考档位',
    default: 'auto',
    options: THINKING_LEVELS.map(level => ({ label: level.label, value: level.id })),
    description:
      '能思考的模型（v4、reasoner 等，或单模型能力覆盖里写了 thinking 的）在请求没指定档位时用这一档，会话设置的「深度思考」压过它。' +
      '自动：开启思考，强度由 DeepSeek 按场景在高与最高之间选。不能思考的模型一律按关发。',
  },
});

// ===== 配置 =====

type DeepSeekConfig = ConfigOf<typeof configSchema>;

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
    /**
     * 上下文缓存命中的输入 token 数（DeepSeek 自动硬盘缓存，无需请求侧声明）。
     * 命中部分按远低于常规输入的价格计费，故必须上报，否则无法评估缓存收益。
     * hit + miss = prompt_tokens。
     */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

// ===== 消息角色归一化（前缀缓存关键） =====

/**
 * 把「首个非 system 消息之后」出现的所有 system 消息转为 user 角色，内容一律补一个 `[系统提示]` 标记，让模型知道这不是
 * 用户在说话。头部连续 system 区（人设/技能/摘要）原样保留。
 *
 * 原因：DeepSeek 渲染时把 messages 里**所有** system 消息提升合并到上下文最前部，与数组位置无关。于是刻意排在历史之后的
 * 每轮易变块（当前状态/焦点/检索材料等），渲染后实际落在 append-only 历史**之前**——内容每轮一变，历史整段前缀缓存作废，
 * 跨回合命中恒等于头部大小（实测 ~30%）；历史中段的通知（notice→system）同理，每来一条打断一次。转为 user 后按数组位置
 * 顺序渲染：头部稳定区+历史可跨回合命中，每轮材料真正落在决策点旁（实测同历史换尾块，system 形态命中 10112/62330，user
 * 形态命中 61184/61623）。
 */
export function normalizeSystemPlacement(messages: Message[]): Message[] {
  let leadingEnd = 0;
  while (leadingEnd < messages.length && messages[leadingEnd].role === 'system') leadingEnd++;
  return messages.map((m, i) => {
    if (i < leadingEnd || m.role !== 'system') return m;
    // 本轮指令块（proactive 代发任务、宿主通知、空闲开话题的提示）豁免：它必须以 system 呈现，转 user 模型会把它当成
    // 真实用户在指挥。代价是 DeepSeek 渲染时把它提到上下文最前部、离决策点远；这类回合低频，牺牲该轮缓存可接受。
    // injector 只存在于请求期构造的消息上，不会命中历史记录。
    const injector = m.metadata?.injector;
    if (typeof injector === 'string' && DIRECTIVE_KINDS.includes(injector)) return m;
    const content = m.content ?? '';
    // 空内容块保持原样，不产出「[系统提示] 」空壳 user 消息
    if (!content.trim()) return m;
    // 标记用换行拼接：块首若是 markdown 标题（# 开头），空格拼接会让 # 脱离行首失去语义
    return { ...m, role: 'user', content: `[系统提示]\n${content}` };
  });
}

// ===== DeepSeek 客户端（共享底层 fetch 封装，多个 ModelHandle 复用） =====

class DeepSeekClient {
  private apiKey: string;
  readonly baseUrl: string;
  private timeout: number;
  readonly temperature: number;
  readonly maxTokens: number;
  private strictToolCalls: boolean;
  private forceJsonOutput: boolean;
  private logger;
  /**
   * 生成请求的连接池：不设等响应头与读响应体的时限（默认各 300 秒），timeout 是唯一的时限。dispatcher 是 Node 自带 fetch
   * 认的扩展字段，DOM 的 RequestInit 里没有（测试的类型检查带 DOM），带它的选项按 RequestInit 断言
   */
  private readonly dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

  constructor(config: DeepSeekConfig, logger: Logger) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    // schema 中 timeout 单位为「秒」，存储为毫秒；0 或负数不限，超过定时器上限按上限计，报错里的秒数是生效的值（见 idleTimeout）
    this.timeout = Math.min(config.timeout * 1000, IDLE_TIMEOUT_MAX_MS);
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.strictToolCalls = config.strictToolCalls;
    this.forceJsonOutput = config.forceJsonOutput;
    this.logger = logger;
  }

  /** 停用时关掉生成请求的连接池，之后的请求被拒（报插件已停用或重载）。不等在飞的请求读完：它们是调用方的，等它们会让重载卡到回复写完 */
  close(): void {
    void this.dispatcher.close();
  }

  /** 对话请求的非 2xx 应答：截断后的响应体记 warn，抛出的错误见 httpErrorMessage */
  private apiError(status: number, body: string): Error {
    this.logger.warn(`DeepSeek API 错误 (${status}): ${bodyExcerpt(body)}`);
    return new Error(httpErrorMessage('DeepSeek', status, body));
  }

  /**
   * 对话请求没拿到完整应答（fetch 或读响应体时抛出）：原始错误连同原因记 warn，超时、连不上与连接池已关闭（插件停用或重载）
   * 各换成一句说明，其它错误原样返回。调用方经 request.signal 中止时原样返回、不记日志，agent 按中止收尾
   */
  private requestError(err: unknown, request: ChatModelRequest, startedAt: number): unknown {
    if (request.signal?.aborted) return err;
    this.logger.warn(`DeepSeek 请求失败 (耗时 ${Date.now() - startedAt}ms): ${describeError(err)}`);
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return new Error(`DeepSeek 请求超时：${this.timeout / 1000} 秒内没有收到新的生成内容，可在配置里调大 timeout`);
    }
    if (err instanceof TypeError && err.message === 'fetch failed') {
      if (err.cause instanceof errors.ClientClosedError || err.cause instanceof errors.ClientDestroyedError) {
        return new Error('DeepSeek 插件已停用或重载，这次请求没有发出');
      }
      return new Error('DeepSeek 连不上服务：检查 baseUrl 与网络，详情见日志');
    }
    return err;
  }

  /** 对话应答按 JSON 解析；不是 JSON 时截断后的应答体记 warn，抛出一行说明 */
  private parseJsonBody(status: number, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      this.logger.warn(`DeepSeek 应答不是 JSON (${status}): ${bodyExcerpt(text)}`);
      throw new Error(`DeepSeek 应答不是 JSON (${status})；详情见日志`);
    }
  }

  /**
   * 发现远端模型 id 列表。不可达、超时、非 2xx、响应不是 JSON 或不是模型列表时抛出，消息带 URL 与原因
   * （由调用方决定按空列表继续还是报错）；经 signal 中止时抛中止原因
   */
  async fetchRemoteModelIds(signal?: AbortSignal): Promise<string[]> {
    const url = `${this.baseUrl}/models`;
    try {
      // 无超时会让 apply() 里的 await 在「接连接不回包」的端点上停摆到 undici 兜底,
      // 插件按拓扑序串行卡住
      const timeout = AbortSignal.timeout(10_000);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
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
      throw new Error(`模型发现失败 ${url}: ${describeError(err)}`, { cause: err });
    }
  }

  /**
   * chat / chatStream 共用的请求体（两侧只差 stream 标志；分开写曾让两侧漂移）。level 是这次的思考档位，不能调的模型
   * 没有，按关发
   */
  private buildRequestBody(
    model: string,
    request: ChatModelRequest,
    level: string | undefined,
    stream: boolean,
  ): { body: Record<string, unknown>; messages: APIMessage[]; tools?: APITool[] } {
    const messages = normalizeSystemPlacement(prepareLLMMessages(request.messages)).map(m => this.toAPIMessage(m));
    const tools = request.tools?.map(t => this.toAPITool(t));

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? this.maxTokens,
    };
    if (stream) body.stream = true;

    // 档位已经 requestedThinking 核过、是 LEVELS 里的一档；不能调的模型没有档位，按关
    const { fields } = LEVELS[(level ?? 'off') as keyof typeof LEVELS];
    Object.assign(body, fields);
    // 思考模式下 temperature 不生效，只在关闭时带
    if (fields.thinking.type === 'disabled') body.temperature = request.temperature ?? this.temperature;

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    // 强制 JSON 输出。带 tools 时必须不加 response_format：json_object 与 tool_calls 互斥会破坏工具循环，
    // 兑现配置文案"工具调用阶段不受影响"的承诺。
    if (this.forceJsonOutput && !(tools && tools.length > 0)) {
      body.response_format = { type: 'json_object' };
    }
    return { body, messages, tools };
  }

  async chat(model: string, request: ChatModelRequest, level: string | undefined): Promise<ChatResponse> {
    const { body, messages, tools } = this.buildRequestBody(model, request, level, false);

    this.logger.debug(
      `请求 DeepSeek (思考 ${level ?? 'off'}): ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`,
    );

    const startedAt = Date.now();
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: idleTimeout(this.timeout, request.signal).signal,
        dispatcher: this.dispatcher,
      } as RequestInit);
      text = await response.text();
    } catch (err) {
      throw this.requestError(err, request, startedAt);
    }

    if (!response.ok) throw this.apiError(response.status, text);

    const data = this.parseJsonBody(response.status, text) as APIChatResponse;
    const choice = data.choices[0];

    if (!choice) {
      throw new Error('DeepSeek 返回了空的 choices');
    }

    // 服务端没解析出工具调用时，模型的工具调用标记（DSML）会漏进正文：只剥离、不当调用执行（与流式分支对齐），
    // 工具调用只取服务端给的
    let cleanContent: string | null = choice.message.content;
    if (cleanContent) {
      const { sanitized, hadLeak } = stripLeakedSpecialTokens(cleanContent);
      if (hadLeak) {
        this.logger.warn(
          `DeepSeek 正文里漏出了 DSML 工具调用标记，已剥离（原长=${cleanContent.length} 净化后=${sanitized.length}）` +
            (choice.message.tool_calls?.length ? '' : '；服务端没给 tool_calls，这次的工具调用丢了'),
        );
      }
      cleanContent = sanitized;
    }

    const result: ChatResponse = {
      content: cleanContent,
      reasoningContent: choice.message.reasoning_content ?? undefined,
      finishReason: finishReasonOf(choice.finish_reason),
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
        cachedPromptTokens: data.usage.prompt_cache_hit_tokens,
      };
    }

    return result;
  }

  async *chatStream(
    model: string,
    request: ChatModelRequest,
    level: string | undefined,
  ): AsyncIterable<ChatStreamChunk> {
    const { body, messages } = this.buildRequestBody(model, request, level, true);

    this.logger.debug(`流式请求 DeepSeek (思考 ${level ?? 'off'}): ${body.model}, ${messages.length} 条消息`);

    // 交出一段期间不计时：调用方处理一段的时间不算停顿
    const timer = idleTimeout(this.timeout, request.signal);
    for await (const chunk of this.readStream(model, body, request, timer)) {
      timer.pause();
      yield chunk;
      timer.resume();
    }
  }

  /** 发出流式请求并逐段解析，timer 管这次请求的停顿超时 */
  private async *readStream(
    model: string,
    body: Record<string, unknown>,
    request: ChatModelRequest,
    timer: ReturnType<typeof idleTimeout>,
  ): AsyncIterable<ChatStreamChunk> {
    const reqStart = Date.now();
    // 守护：超过 15 秒还没拿到响应头，提示可能是网络/上游慢
    const slowConnectTimer = setTimeout(() => {
      this.logger.warn(`DeepSeek 连接慢：已等待 15s 仍未收到响应头 (url=${this.baseUrl}/chat/completions)`);
    }, 15_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: timer.signal,
        dispatcher: this.dispatcher,
      } as RequestInit);
    } catch (err) {
      clearTimeout(slowConnectTimer);
      throw this.requestError(err, request, reqStart);
    }
    clearTimeout(slowConnectTimer);
    this.logger.debug(`DeepSeek 响应头到达: status=${response.status}, 耗时 ${Date.now() - reqStart}ms`);

    if (!response.ok) {
      const errorText = await response.text().catch((err: unknown) => {
        throw this.requestError(err, request, reqStart);
      });
      throw this.apiError(response.status, errorText);
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: ChatStreamChunk['finishReason'];
    let dsmlDetected = false;
    /**
     * 跨 chunk 尾缓冲：当当前 delta 末尾形如未闭合的 special token 起始片段
     * （`<` 或 `<｜...` 等），暂存到下一帧再判定，避免半截 DSML 起始已经
     * emit 给下游、等下一帧匹配上完整 DSML 时已经收不回来。
     */
    let pendingTail = '';

    /** 收尾组装 toolCalls，[DONE] 与流意外结束两处共用。只取服务端给的：漏进正文的工具调用标记只剥离、不当调用执行 */
    const finalizeToolCalls = (): ToolCall[] | undefined => {
      const toolCalls: ToolCall[] = [];
      for (const [, tc] of [...toolCallBuffers.entries()].sort((a, b) => a[0] - b[0])) {
        toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } });
      }
      return toolCalls.length > 0 ? toolCalls : undefined;
    };

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
            // Flush 残留尾缓冲：流结束后 pendingTail 已不可能是 DSML 起始
            // （DSML 都没等到下一帧），按合法字符 emit 出去
            if (pendingTail && !dsmlDetected) {
              yield { contentDelta: pendingTail };
              pendingTail = '';
            }
            yield { done: true, toolCalls: finalizeToolCalls(), finishReason };
            return;
          }

          try {
            const data = JSON.parse(payload);
            const chunk: ChatStreamChunk = {};

            // usage 与结束原因必须在 delta 守卫**之前**取：兼容端点可能把 usage 挂在 `choices: []` 的收尾帧上、把结束
            // 原因放在不带 delta 的末帧上，等到守卫之后再取整帧已被跳过。
            // （DeepSeek 自身把 usage 挂在带 delta 的帧上，本重排对它是无害冗余。）
            const reason = finishReasonOf(data.choices?.[0]?.finish_reason);
            if (reason) finishReason = reason;
            if (data.usage) {
              chunk.usage = {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.prompt_tokens + data.usage.completion_tokens,
                cachedPromptTokens: data.usage.prompt_cache_hit_tokens,
              };
            }

            const delta = data.choices?.[0]?.delta;
            if (!delta) {
              if (chunk.usage) yield chunk; // 纯 usage 收尾帧照样上报
              continue;
            }

            // 带生成内容的增量重新计时：留在尾缓冲里、DSML 泄漏后不交出的正文也算
            if (delta.content || delta.reasoning_content) timer.touch();
            // 检测到 DSML 泄漏之后的正文不再交出
            if (delta.content && !dsmlDetected) {
              // 合并尾缓冲 + 本次 delta 作为本帧候选 emit 内容。可能是标记开头的尾巴都留在尾缓冲里，只在候选上找起始就够
              const candidate = pendingTail + delta.content;
              // 检测 DSML 起始标记。已知变体：
              //   - 单竖线（标准）：<｜DSML｜tool_calls>
              //   - 双竖线（畸形泄漏）：<｜｜DSML｜｜tool_calls>
              //   - 半角变体：<|DSML|...>
              // 使用 [｜|]+ 兼容任意数量的竖线
              const dsmlIdx = candidate.search(/<[｜|]+\s*DSML/);
              if (dsmlIdx !== -1) {
                dsmlDetected = true;
                this.logger.warn(
                  `DeepSeek 检测到 DSML 泄漏：模型 ${model} 把工具调用标记写进了正文，已剥离，之后的正文不交出`,
                );
                // 输出 DSML 之前的部分（如果有）
                const cleanDelta = candidate.slice(0, dsmlIdx);
                if (cleanDelta) chunk.contentDelta = cleanDelta;
                pendingTail = '';
              } else {
                // 未检测到完整 DSML：识别 candidate 尾部是否是"可能的 special token 起始"
                // - 形如 `<` 单独
                // - 形如 `<｜...` 或 `<|...`（即 special token 前缀，还未闭合 `>`）
                // 命中则把这段尾部留到下一帧再判，避免漏出半截 `<｜｜DS` 这种碎片
                const tailMatch = candidate.match(/<$|<[｜|]+[^<>]{0,20}$/);
                if (tailMatch) {
                  pendingTail = tailMatch[0];
                  const emitPart = candidate.slice(0, candidate.length - pendingTail.length);
                  if (emitPart) chunk.contentDelta = emitPart;
                } else {
                  pendingTail = '';
                  chunk.contentDelta = candidate;
                }
              }
            }
            if (delta.reasoning_content) chunk.reasoningDelta = delta.reasoning_content;

            // 累积工具调用；同一帧里有几个调用，进度就各报一次
            const progress: ToolCallProgress[] = [];
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name || tc.function?.arguments) timer.touch();
                const idx = tc.index ?? 0;
                if (tc.id) {
                  toolCallBuffers.set(idx, { id: tc.id, name: tc.function?.name ?? '', args: '' });
                }
                const entry = toolCallBuffers.get(idx);
                if (entry) {
                  if (tc.function?.name) entry.name = tc.function.name;
                  if (tc.function?.arguments) entry.args += tc.function.arguments;
                  progress.push({ index: idx, name: entry.name, charsAccumulated: entry.args.length });
                }
              }
            }

            if (chunk.contentDelta || chunk.reasoningDelta || chunk.usage) yield chunk;
            for (const toolCallProgress of progress) yield { toolCallProgress };
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
      // 才释放（本地慢生成时回合常被停下，这类残留一挂就是整个超时窗）。
      // cancel 自带放锁。三条退出路径的语义：读尽 EOF（done:true）→ 流已 closed，cancel 是
      // 真 no-op；收到终帧即 return（未读到 EOF）与消费方提前 break → cancel 中止残余响应体，
      // 这正是本修复要的「立即交还套接字」，代价是该连接不回 keep-alive 池。
      await reader.cancel().catch(() => {});
    }

    // 流意外结束（未见 [DONE]）也要 flush 尾缓冲
    if (pendingTail && !dsmlDetected) {
      yield { contentDelta: pendingTail };
      pendingTail = '';
    }
    yield { done: true, toolCalls: finalizeToolCalls(), finishReason };
  }

  /**
   * 转换为 DeepSeek API 消息格式
   * 关键：在工具调用循环中保留 reasoning_content，
   * 但历史消息（从 memory 加载）不含 reasoning_content
   */
  private toAPIMessage(msg: Message): APIMessage {
    // 调用方已经 prepareLLMMessages 处理过：role 已是 WellKnownRole，自定义 role / kind
    // 对应的前缀已拼接进 content。这里只需透传。
    const apiMsg: APIMessage = {
      role: toLLMRole(msg.role),
      content: msg.content ?? null,
    };

    // DeepSeek API 不支持 image_url content 类型
    // 图片应由 plugin-media 预处理为文本描述，不传递给 API

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
  // 模糊匹配：模型名包含关键词
  const lower = model.toLowerCase();
  if (lower.includes('reasoner')) {
    for (const c of [Chat, ToolCalling, Streaming, Thinking]) out.add(c);
    return [...out];
  }
  // v4 及后续主线模型默认启用思考
  if (/\bv[4-9]\b/.test(lower) || lower.includes('-pro') || lower.includes('-flash')) {
    for (const c of [Chat, ToolCalling, Streaming, Thinking]) out.add(c);
    return [...out];
  }
  if (lower.includes('chat')) {
    for (const c of [Chat, ToolCalling, Streaming]) out.add(c);
    return [...out];
  }
  for (const c of DEFAULT_CAPABILITIES) out.add(c);
  return [...out];
}

// ===== 配置解析 =====

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
 * 按**最后一个**冒号切分：自定义 baseUrl 指向兼容网关时模型 id 可能自带冒号（如 `qwen3:8b`、
 * `xxx:free`），按首个冒号切会把 id 截断、能力段变成 `8b: chat`，这行覆盖永远不命中。
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

/** 解析适配器级别默认能力（逗号/空格/换行分隔） */
function parseProviderCapabilities(raw: string): LLMCapability[] {
  return raw
    .split(/[,\s\n]/)
    .map(s => s.trim())
    .filter(Boolean) as LLMCapability[];
}

// ===== Per-model handle：每个 model 独立的 LLMModel entry =====

class DeepSeekModelHandle implements LLMModel {
  constructor(
    private client: DeepSeekClient,
    readonly id: string,
    readonly providerId: string,
    readonly contextLength: number,
    readonly maxOutputTokens: number,
    /** 该 model 的能力元数据（供 media 发现/下拉展示读取，非 DI 选择机制）。 */
    readonly capabilities: readonly LLMCapability[],
    /** 能思考的模型才有：默认档取实例配置 */
    readonly thinking?: ThinkingLevels,
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

// ===== 插件定义 =====

const uses = { config, logger, lifecycle, provide, events };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-llm-deepseek',
  displayName: 'DeepSeek',
  subsystem: 'llm',
  configSchema,
  reusable: true,
  provides: [llm],
  uses,
  apply: registerModels,
});

async function registerModels({ config, logger, lifecycle, provide, events }: Caps): Promise<void> {
  const cfg = parseConfig(configSchema, config.use, logger.use);
  const customModels = parseCustomModels(cfg.customModels);
  const modelCapabilities = parseModelCapabilities(cfg.modelCapabilities);
  const providerCapabilities = parseProviderCapabilities(cfg.providerCapabilities);

  checkBaseUrl(cfg.baseUrl);
  if (!cfg.discoverModels && customModels.length === 0) {
    throw missingConfigError('customModels', '关闭 discoverModels 时必填');
  }

  const client = new DeepSeekClient(cfg, logger.use);
  lifecycle.use.onDispose(() => client.close(), '关闭生成请求的连接池');

  // 探测远端 + 合并自定义模型。停用或停机时中止探测（中止即抛出）；发现失败按未发现远端模型继续，customModels
  // 照常注册；关闭模型发现时只注册 customModels。发现失败只留消息：消息里已带 URL 与原因（cause 也内联在内），
  // err 交给 logger 会按因果链把原因再记一遍
  let discoveryError: string | undefined;
  const remoteIds = cfg.discoverModels
    ? await client.fetchRemoteModelIds(lifecycle.use.signal).catch((err: unknown) => {
        discoveryError = err instanceof Error ? err.message : String(err);
        return [];
      })
    : [];
  lifecycle.use.signal.throwIfAborted();
  const remoteSet = new Set(remoteIds);
  for (const cm of customModels) {
    if (remoteSet.has(cm)) {
      logger.use.warn(`自定义模型 "${cm}" 与自动发现的模型重复，请在配置中去重`);
    }
  }
  const allModelIds = [...remoteIds, ...customModels.filter(id => !remoteSet.has(id))];

  // 一个模型都没有时抛配置错误，原因成为实例的错误信息；否则只剩 core 的「声明 provides [llm] 但未实际注册」。
  // 提示写在原因之前：原因里可能带着一段响应体
  if (allModelIds.length === 0) {
    throw configError(
      discoveryError
        ? `取不到模型列表，没有可注册的模型：检查 apiKey、baseUrl 与网络后重载本插件，或在 customModels 里写明要用的模型。原因：${discoveryError}`
        : `已连接 ${cfg.baseUrl}，但未发现任何可用模型；可在 customModels 里写明要用的模型`,
    );
  }
  if (discoveryError) logger.use.warn(`启动时只注册 customModels 里的模型；${discoveryError}`);

  const baseLabel = `DeepSeek (${cfg.baseUrl.replace(/^https?:\/\//, '')})`;

  // 为每个 model 注册独立的 LLMModel entry
  for (const modelId of allModelIds) {
    const capabilities = resolveCapabilities(modelId, modelCapabilities.get(modelId), providerCapabilities);
    const handle = new DeepSeekModelHandle(
      client,
      modelId,
      lifecycle.use.id,
      cfg.contextLength,
      cfg.maxTokens,
      capabilities,
      capabilities.includes(Thinking) ? { levels: THINKING_LEVELS, default: cfg.thinking } : undefined,
    );
    provide.use(llm, metered(handle, events.use), {
      label: `${baseLabel} / ${modelId}`,
      entryId: `${lifecycle.use.id}/${modelId}`,
    });
  }

  logger.use.info(
    !cfg.discoverModels
      ? `未开启模型发现: ${cfg.baseUrl}，注册 customModels 里的 ${allModelIds.length} 个 model entry (默认思考档位 ${cfg.thinking})`
      : discoveryError
        ? `模型发现失败: ${cfg.baseUrl}，注册 customModels 里的 ${allModelIds.length} 个 model entry (默认思考档位 ${cfg.thinking})`
        : `已连接: ${cfg.baseUrl}，注册 ${allModelIds.length} 个 model entry (默认思考档位 ${cfg.thinking})`,
  );
}
