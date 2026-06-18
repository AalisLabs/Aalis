import type { ConfigSchema, Context } from '@aalis/core';
import type { ChatModelRequest, ChatResponse, ChatStreamChunk, LLMCapability, LLMModel } from '@aalis/plugin-llm-api';
import { LLMCapabilities } from '@aalis/plugin-llm-api';
import type { Message, ToolCall } from '@aalis/plugin-message-api';
import { prepareLLMMessages, toLLMRole } from '@aalis/plugin-message-api';
import type { ToolDefinition } from '@aalis/plugin-tools-api';
import type {} from '@aalis/plugin-webui-api'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import { stripLeakedSpecialTokens } from '@aalis/util-text-normalize';
import { parseDsmlToolCalls } from './dsml-parser.js';

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
      { label: '自动（按模型推断，仅 thinking-capable 模型启用）', value: 'auto' },
      { label: '强制启用所有模型', value: 'enabled' },
      { label: '强制关闭所有模型', value: 'disabled' },
    ],
    description:
      '控制深度思考。auto 模式下，仅 thinking-capable 模型（v4 / reasoner 等）默认启用思考。enabled/disabled 会覆盖所有模型。',
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
  providerCapabilities: '',
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
  providerCapabilities: LLMCapability[];
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

// ===== DeepSeek 客户端（共享底层 fetch 封装，多个 ModelHandle 复用） =====

class DeepSeekClient {
  private apiKey: string;
  readonly baseUrl: string;
  private timeout: number;
  readonly temperature: number;
  readonly maxTokens: number;
  private reasoningEffort: 'auto' | 'high' | 'max';
  private strictToolCalls: boolean;
  private forceJsonOutput: boolean;
  private logger;

  constructor(config: DeepSeekConfig, logger: Context['logger']) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    // schema 中 timeout 单位为「秒」，存储为毫秒；0 视为不限制 → 用一个非常大的值
    this.timeout = config.timeout && config.timeout > 0 ? config.timeout * 1000 : 2_147_483_647;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.reasoningEffort = config.reasoningEffort;
    this.strictToolCalls = config.strictToolCalls;
    this.forceJsonOutput = config.forceJsonOutput;
    this.logger = logger;
  }

  /** 发现远端模型 id 列表 */
  async fetchRemoteModelIds(): Promise<string[]> {
    const url = `${this.baseUrl}/models`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`fetchRemoteModelIds 失败 ${url}: HTTP ${res.status} ${res.statusText} - ${body}`);
        return [];
      }
      const data = (await res.json()) as { data: { id: string }[] };
      return data.data.map(m => m.id);
    } catch (err) {
      this.logger.warn(`fetchRemoteModelIds 异常 ${url}: ${(err as Error).message}`);
      return [];
    }
  }

  async chat(model: string, request: ChatModelRequest, enableThinking: boolean): Promise<ChatResponse> {
    const messages = prepareLLMMessages(request.messages).map(m => this.toAPIMessage(m));
    const tools = request.tools?.map(t => this.toAPITool(t));

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? this.maxTokens,
    };

    const shouldThink = request.think !== undefined ? request.think : enableThinking;

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

    // 强制 JSON 输出。带 tools 时必须不加 response_format：json_object 与 tool_calls 互斥会破坏工具循环，
    // 兑现配置文案"工具调用阶段不受影响"的承诺(M16)。
    if (this.forceJsonOutput && !(tools && tools.length > 0)) {
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

    // DSML 泄漏处理（与流式分支对齐）：
    // 1) 用统一的 stripLeakedSpecialTokens 检测+剥离 DSML 文本（覆盖单/双竖线变体）
    // 2) 若服务端 tool_calls 为空但 content 含 DSML，调 parseDsmlToolCalls 本地恢复
    //    避免非流式路径下工具调用信息无声丢失
    let cleanContent: string | null = choice.message.content;
    let recoveredToolCalls: ToolCall[] | undefined;
    if (cleanContent) {
      const { sanitized, hadLeak } = stripLeakedSpecialTokens(cleanContent);
      if (hadLeak) {
        const hasServerToolCalls = !!(choice.message.tool_calls && choice.message.tool_calls.length > 0);
        if (!hasServerToolCalls) {
          const dsmlCalls = parseDsmlToolCalls(cleanContent);
          if (dsmlCalls.length > 0) {
            this.logger.info(
              `DeepSeek DSML 本地解析成功（非流式），恢复 ${dsmlCalls.length} 个 tool_call：${dsmlCalls.map(c => c.function.name).join(', ')}`,
            );
            recoveredToolCalls = dsmlCalls;
          } else {
            this.logger.warn(
              `DeepSeek DSML 本地解析未识别出完整 invoke 块（非流式），content 长度=${cleanContent.length}`,
            );
          }
        } else {
          this.logger.warn(
            `DeepSeek content 检测到 DSML 泄漏但服务端已返回 tool_calls，仅剥离文本（原长=${cleanContent.length} 净化后=${sanitized.length}）`,
          );
        }
      }
      cleanContent = sanitized;
    }

    const result: ChatResponse = {
      content: cleanContent,
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
    } else if (recoveredToolCalls) {
      result.toolCalls = recoveredToolCalls;
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

  async *chatStream(model: string, request: ChatModelRequest, enableThinking: boolean): AsyncIterable<ChatStreamChunk> {
    const messages = prepareLLMMessages(request.messages).map(m => this.toAPIMessage(m));
    const tools = request.tools?.map(t => this.toAPITool(t));

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? this.maxTokens,
      stream: true,
    };

    const shouldThink = request.think !== undefined ? request.think : enableThinking;

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

    // 强制 JSON 输出。带 tools 时必须不加 response_format：json_object 与 tool_calls 互斥会破坏工具循环，
    // 兑现配置文案"工具调用阶段不受影响"的承诺(M16)。
    if (this.forceJsonOutput && !(tools && tools.length > 0)) {
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
    /**
     * 跨 chunk 尾缓冲：当当前 delta 末尾形如未闭合的 special token 起始片段
     * （`<` 或 `<｜...` 等），暂存到下一帧再判定，避免半截 DSML 起始已经
     * emit 给下游、等下一帧匹配上完整 DSML 时已经收不回来。
     */
    let pendingTail = '';

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
            const toolCalls: ToolCall[] = [];
            for (const [, tc] of [...toolCallBuffers.entries()].sort((a, b) => a[0] - b[0])) {
              toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } });
            }
            // DSML 泄漏 best-effort 恢复：如果服务端未返回 tool_calls（解析失败）但
            // accContent 里有 DSML 文本，本地解析补上，让 agent 走正常工具调用流程
            if (dsmlDetected && toolCalls.length === 0) {
              const dsmlCalls = parseDsmlToolCalls(accContent);
              if (dsmlCalls.length > 0) {
                this.logger.info(
                  `DeepSeek DSML 本地解析成功，恢复 ${dsmlCalls.length} 个 tool_call：${dsmlCalls.map(c => c.function.name).join(', ')}`,
                );
                toolCalls.push(...dsmlCalls);
              } else {
                this.logger.warn(
                  `DeepSeek DSML 本地解析未识别出完整 invoke 块，accContent 长度=${accContent.length}，上游将收到空回复`,
                );
              }
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
              // 无论是否检测到 DSML，都要累积原始 content：
              // - 未检测时：用于 DSML 起始位置定位
              // - 已检测后：DSML 主体 + 闭合标记累积完成，[DONE] 时用于 best-effort 解析为 tool_calls
              accContent += delta.content;
              if (!dsmlDetected) {
                // 合并尾缓冲 + 本次 delta 作为本帧候选 emit 内容
                const candidate = pendingTail + delta.content;
                // 检测 DSML 起始标记。已知变体：
                //   - 单竖线（标准）：<｜DSML｜tool_calls>
                //   - 双竖线（畸形泄漏）：<｜｜DSML｜｜tool_calls>
                //   - 半角变体：<|DSML|...>
                // 使用 [｜|]+ 兼容任意数量的竖线
                const dsmlIdx = accContent.search(/<[｜|]+\s*DSML/);
                if (dsmlIdx !== -1) {
                  dsmlDetected = true;
                  this.logger.warn(
                    `DeepSeek 检测到 DSML 标记泄漏，模型 ${model} 输出原生 tool_call 标记到 content（服务端解析失败），将在流结束后尝试本地解析`,
                  );
                  // 输出 DSML 之前的部分（如果有）
                  const cleanPart = accContent.slice(0, dsmlIdx);
                  // 已发字节数 = accContent.length - candidate.length（candidate 即"本帧合并后待 emit"）
                  const prevEmitted = accContent.length - candidate.length;
                  const cleanDelta = cleanPart.slice(prevEmitted);
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
              // dsmlDetected = true 时不再 emit content，但 accContent 继续累积供后续解析
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

    // 流意外结束（未见 [DONE]）也要 flush 尾缓冲
    if (pendingTail && !dsmlDetected) {
      yield { contentDelta: pendingTail };
      pendingTail = '';
    }
    const toolCalls: ToolCall[] = [];
    for (const [, tc] of [...toolCallBuffers.entries()].sort((a, b) => a[0] - b[0])) {
      toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } });
    }
    // 同 [DONE] 分支：DSML 泄漏 best-effort 恢复
    if (dsmlDetected && toolCalls.length === 0) {
      const dsmlCalls = parseDsmlToolCalls(accContent);
      if (dsmlCalls.length > 0) {
        this.logger.info(`DeepSeek DSML 本地解析成功（流意外结束分支），恢复 ${dsmlCalls.length} 个 tool_call`);
        toolCalls.push(...dsmlCalls);
      }
    }

    yield { done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
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

/** 解析适配器级别默认能力（逗号/空格/换行分隔） */
function parseProviderCapabilities(raw: unknown): LLMCapability[] {
  if (!raw || typeof raw !== 'string') return [];
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
    private enableThinking: boolean,
  ) {}

  chat(request: ChatModelRequest): Promise<ChatResponse> {
    return this.client.chat(this.id, request, this.enableThinking);
  }

  chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
    return this.client.chatStream(this.id, request, this.enableThinking);
  }
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const deepseekConfig: DeepSeekConfig = {
    apiKey: (config.apiKey as string) ?? '',
    baseUrl: (config.baseUrl as string) ?? 'https://api.deepseek.com',
    customModels: parseCustomModels(config.customModels),
    modelCapabilities: parseModelCapabilities(config.modelCapabilities),
    providerCapabilities: parseProviderCapabilities(config.providerCapabilities),
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

  const thinkingMode = (config.thinkingMode as string) ?? 'auto';
  const client = new DeepSeekClient(deepseekConfig, ctx.logger);

  // 探测远端 + 合并自定义模型
  const remoteIds = await client.fetchRemoteModelIds();
  const remoteSet = new Set(remoteIds);
  for (const cm of deepseekConfig.customModels) {
    if (remoteSet.has(cm)) {
      ctx.logger.warn(`自定义模型 "${cm}" 与自动发现的模型重复，请在配置中去重`);
    }
  }
  const allModelIds = [...remoteIds, ...deepseekConfig.customModels.filter(id => !remoteSet.has(id))];

  if (allModelIds.length === 0) {
    ctx.logger.warn(`已连接: ${deepseekConfig.baseUrl}，但未发现任何可用模型；不注册任何 LLM entry`);
    return;
  }

  const baseLabel = `DeepSeek (${deepseekConfig.baseUrl.replace(/^https?:\/\//, '')})`;

  // 为每个 model 注册独立的 LLMModel entry
  for (const modelId of allModelIds) {
    const capabilities = resolveCapabilities(
      modelId,
      deepseekConfig.modelCapabilities.get(modelId),
      deepseekConfig.providerCapabilities,
    );
    // 思考开关：auto → 由模型 capability 决定；enabled/disabled → 强制覆盖
    let enableThinking: boolean;
    if (thinkingMode === 'enabled') {
      enableThinking = true;
    } else if (thinkingMode === 'disabled') {
      enableThinking = false;
    } else {
      enableThinking = capabilities.includes(Thinking);
    }

    const handle = new DeepSeekModelHandle(
      client,
      modelId,
      ctx.id,
      deepseekConfig.contextLength,
      deepseekConfig.maxTokens,
      enableThinking,
    );
    ctx.provide('llm', handle, {
      capabilities,
      label: `${baseLabel} / ${modelId}${enableThinking ? ' (thinking)' : ''}`,
      entryId: `${ctx.id}/${modelId}`,
    });
  }

  ctx.logger.info(
    `已连接: ${deepseekConfig.baseUrl}，注册 ${allModelIds.length} 个 model entry (thinkingMode=${thinkingMode})`,
  );
}
