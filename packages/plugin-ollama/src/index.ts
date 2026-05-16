import type { ConfigSchema, Context, Logger } from '@aalis/core';
import type { ChatModelRequest, ChatResponse, ChatStreamChunk, LLMCapability, LLMModel } from '@aalis/plugin-llm-api';
import { LLMCapabilities } from '@aalis/plugin-llm-api';
import type { Message } from '@aalis/plugin-message-api';
import type { ToolDefinition } from '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-ollama';
export const displayName = 'Ollama';
export const subsystem = 'llm';
export const provides = ['llm'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  baseUrl: {
    type: 'string',
    label: 'Ollama 地址',
    default: 'http://localhost:11434',
    description: '本地 Ollama 服务的 HTTP 地址',
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
      '按行指定某个模型的能力集。有该模型的表项时**覆盖**插件启发式推断，与 adapter 默认能力仍取并集。\n格式：`<modelId>: <cap1>,<cap2>,...`，每行一条。如：qwen2.5:7b: chat,tool_calling,streaming',
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
    description: 'LLM 请求超时时间（秒）。大模型或长上下文建议适当调大。0 = 不限制。',
  },
  temperature: { type: 'number', label: '温度', default: 0.7, description: '0-2，越高越随机' },
  maxTokens: {
    type: 'number',
    label: '最大 Token',
    default: 4096,
    description: '单次回复最大生成 token 数（num_predict）',
  },
  contextLength: { type: 'number', label: '上下文长度', default: 8192, description: '模型上下文窗口大小（num_ctx）' },
  keepAlive: {
    type: 'string',
    label: '模型保活时间',
    default: '5m',
    description: '模型在显存中保留的时间，如 5m、1h、0（立即卸载）',
  },
  thinking: {
    type: 'boolean',
    label: '启用思考',
    default: true,
    description: '为支持思考的模型启用扩展思考（think 参数）。无 thinking 能力的模型该参数无效。',
  },
};

export const defaultConfig = {
  baseUrl: 'http://localhost:11434',
  customModels: '',
  modelCapabilities: '',
  providerCapabilities: '',
  timeout: 120,
  temperature: 0.7,
  maxTokens: 4096,
  contextLength: 8192,
  keepAlive: '5m',
  thinking: true,
};

// ===== 配置 =====

interface OllamaConfig {
  baseUrl: string;
  customModels: string[];
  modelCapabilities: Map<string, LLMCapability[]>;
  providerCapabilities: LLMCapability[];
  timeout?: number;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  keepAlive: string;
  thinking: boolean;
}

// ===== Ollama API 消息格式 =====

interface OllamaMessage {
  role: string;
  content: string;
  thinking?: string;
  images?: string[];
  /**
   * 纯 base64 音频（不带 data: 前缀）。仅在“带音频”请求中使用：
   * 这种请求会被本插件自动改路到 OpenAI 兼容的 /v1/chat/completions +
   * input_audio 内容块（Ollama v0.20.0+）。原生 /api/chat 不支持音频。
   */
  audios?: string[];
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
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
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

  constructor(config: OllamaConfig, logger: Logger) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    // schema 中 timeout 单位为「秒」，存储为毫秒；0 视为不限制 → 用一个非常大的值
    this.timeout = config.timeout && config.timeout > 0 ? config.timeout * 1000 : 2_147_483_647;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.contextLength = config.contextLength;
    this.keepAlive = config.keepAlive;
    this.logger = logger;
  }

  /** 发现远端模型 id 列表 */
  async fetchRemoteModelIds(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as { models: { name: string }[] };
      return data.models.map(m => m.name);
    } catch {
      return [];
    }
  }

  async chat(model: string, request: ChatModelRequest, defaultThinking: boolean): Promise<ChatResponse> {
    // 包含音频输入 → 改走 OpenAI 兼容的 /v1/chat/completions（/api/chat 不支持 audios）
    if (request.messages.some(m => m.audios && m.audios.length > 0)) {
      return this.chatOpenAIWithAudio(model, request);
    }
    const messages = await Promise.all(request.messages.map(m => this.toOllamaMessage(m)));
    const tools = request.tools?.map(t => this.toOllamaTool(t));

    const body: Record<string, unknown> = {
      model,
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

    // 启用原生思考模式（Ollama API think 参数）
    // 调用方可通过 request.think === false 显式关闭
    // 必须显式传 think:false 才能关闭 gemma4:31b 等原生 thinking 模型的思考；
    // 仅省略字段会被模型默认启用思考，导致 content 为空。
    const shouldThink = request.think !== undefined ? request.think : defaultThinking;
    body.think = shouldThink;

    this.logger.debug(
      `请求 Ollama${shouldThink ? ' [think]' : ''}: ${body.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`,
    );

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
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

    // 优先使用原生 thinking 字段（Ollama think API），回退到 <think> 标签解析
    const nativeThinking = data.message.thinking || '';
    const rawContent = data.message.content || '';
    const { reasoning: tagReasoning, content: cleanContent } = extractThinkTags(rawContent);
    const allReasoning = [nativeThinking, tagReasoning].filter(Boolean).join('');

    const result: ChatResponse = {
      content: cleanContent || null,
      reasoningContent: allReasoning || null,
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

  async *chatStream(
    model: string,
    request: ChatModelRequest,
    defaultThinking: boolean,
  ): AsyncIterable<ChatStreamChunk> {
    // 包含音频输入 → 回退为非流式（OpenAI compat 路径不支持 SSE 交互）后以单 chunk 交付。
    if (request.messages.some(m => m.audios && m.audios.length > 0)) {
      const r = await this.chatOpenAIWithAudio(model, request);
      yield {
        contentDelta: r.content ?? '',
        reasoningDelta: r.reasoningContent ?? '',
        usage: r.usage,
        done: true,
      };
      return;
    }
    const messages = await Promise.all(request.messages.map(m => this.toOllamaMessage(m)));
    const tools = request.tools?.map(t => this.toOllamaTool(t));

    const body: Record<string, unknown> = {
      model,
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

    // 启用原生思考模式（调用方可通过 request.think === false 显式关闭）
    // 必须显式传 think:false 才能关闭原生 thinking 模型的思考。
    const shouldThink = request.think !== undefined ? request.think : defaultThinking;
    body.think = shouldThink;

    this.logger.debug(`流式请求 Ollama${shouldThink ? ' [think]' : ''}: ${body.model}, ${messages.length} 条消息`);

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (request.signal) signals.push(request.signal);

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
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      clearTimeout(slowConnectTimer);
      const elapsed = Date.now() - reqStart;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Ollama fetch 失败 (耗时 ${elapsed}ms): ${msg}`);
      throw err;
    }
    clearTimeout(slowConnectTimer);
    this.logger.debug(`Ollama 响应头到达: status=${response.status}, 耗时 ${Date.now() - reqStart}ms`);

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

            // 原生 thinking 字段（Ollama think API）—— 优先级高于 <think> 标签解析
            if (data.message?.thinking) {
              yield { reasoningDelta: data.message.thinking };
            }

            if (data.message?.content) {
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
    } finally {
      clearTimeout(streamStallTimer);
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
  private resolveImage(img: string): Promise<string | null> {
    return this.resolveBinary(img, 'image');
  }

  /**
   * 通用二进制资源解析（图片 / 音频）。
   * 支持 data URI、HTTP(S) URL、纯 base64、文件路径。返回 null 表示获取失败。
   */
  private async resolveBinary(data: string, label: 'image' | 'audio'): Promise<string | null> {
    // data URI → 提取 base64（兼容多参数格式如 data:image/png;charset=utf-8;base64,...）
    const dataMatch = data.match(/^data:[^,]*;base64,(.+)$/);
    if (dataMatch) return dataMatch[1];

    // HTTP(S) URL → 下载并转 base64
    if (/^https?:\/\//i.test(data)) {
      try {
        const res = await fetch(data, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) {
          this.logger.warn(`下载${label === 'image' ? '图片' : '音频'}失败 (${res.status}): ${data}`);
          return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.toString('base64');
      } catch (err) {
        this.logger.warn(`下载${label === 'image' ? '图片' : '音频'}异常: ${data}`, err);
        return null;
      }
    }

    // 其他情况：可能是本地文件路径，或者已经是裸 base64。
    // 先按"文件存在"探测一下——存在则读盘转 base64，避免把诸如
    // `data/images/onebot_xxx/abc.png` 这种相对路径当作 base64 送给 Ollama
    // 触发 `illegal base64 data` 错误。读盘失败则按裸 base64 透传。
    try {
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const path = data.startsWith('file://') ? data.slice('file://'.length) : resolve(process.cwd(), data);
      const buf = await readFile(path);
      return buf.toString('base64');
    } catch {
      return data;
    }
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

    // 传递思考内容（用于历史上下文）
    if (msg.role === 'assistant' && msg.reasoningContent) {
      ollamaMsg.thinking = msg.reasoningContent;
    }

    // 多模态：Ollama 支持 images 字段（base64 或文件路径）
    if (msg.images && msg.images.length > 0 && msg.role === 'user') {
      const resolved = await Promise.all(msg.images.map(img => this.resolveImage(img)));
      const valid = resolved.filter((r): r is string => r !== null);
      if (valid.length > 0) ollamaMsg.images = valid;
    }

    // 音频：Ollama 原生 /api/chat 不支持 audios，有音频时会在 chat() 中
    // 改走 OpenAI 兼容的 /v1/chat/completions 路径。这里只透传字段。
    if (msg.audios && msg.audios.length > 0 && msg.role === 'user') {
      ollamaMsg.audios = msg.audios.map(stripAudioDataPrefix);
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
  async chatOpenAIWithAudio(model: string, request: ChatModelRequest): Promise<ChatResponse> {
    // 将 Aalis Message 转为 OpenAI multimodal content blocks
    const oaiMessages = await Promise.all(
      request.messages.map(async m => {
        const role = m.role === 'tool' ? 'tool' : m.role;
        const blocks: Array<Record<string, unknown>> = [];
        // Modality order：Ollama 官方 best practice 要求 image/audio content
        // 必须在 text 之前。参见 /memories/repo/aalis-ollama-gemma4-audio.md
        if (m.images && m.images.length > 0 && m.role === 'user') {
          for (const img of m.images) {
            const url = await this.resolveImage(img);
            if (url)
              blocks.push({
                type: 'image_url',
                image_url: { url: url.startsWith('http') ? url : `data:image/png;base64,${url}` },
              });
          }
        }
        if (m.audios && m.audios.length > 0 && m.role === 'user') {
          for (const a of m.audios) {
            const { data, format } = decodeAudioForOpenAI(a);
            blocks.push({ type: 'input_audio', input_audio: { data, format } });
          }
        }
        if (m.content) blocks.push({ type: 'text', text: m.content });
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
    // Ollama 0.20+ thinking 控制：OpenAI 兼容路径只认 reasoning_effort，
    // 不认 /api/chat 的 think 字段。think=false → reasoning_effort: "none"
    // 节省 ~5-8x completion tokens（实测 935 → 155）。
    // 详见 /memories/repo/aalis-ollama-gemma4-audio.md
    if (request.think === false) {
      body.reasoning_effort = 'none';
    }

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

    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)];
    if (request.signal) signals.push(request.signal);

    const httpT0 = Date.now();
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      this.logger.warn(`[ollama-audio] HTTP ${resp.status} 失败 ${Date.now() - httpT0}ms: ${errText.slice(0, 400)}`);
      throw new Error(`Ollama /v1/chat/completions 错误 (${resp.status}): ${errText.slice(0, 400)}`);
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const rawContent = data.choices?.[0]?.message?.content ?? '';
    const finishReason = data.choices?.[0]?.finish_reason ?? '?';
    const text = rawContent.trim();
    if (audioCount > 0) {
      this.logger.info(
        `[ollama-audio] ${model} HTTP ${Date.now() - httpT0}ms, finish=${finishReason}, ` +
          `raw=${rawContent.length}字 trim=${text.length}字, ` +
          `tokens prompt=${data.usage?.prompt_tokens ?? '?'} completion=${data.usage?.completion_tokens ?? '?'}` +
          (rawContent.length > 0
            ? `, 原文前300字="${rawContent.slice(0, 300).replace(/\n/g, ' ')}"`
            : ' [模型返回空字符串]'),
      );
    }
    const result: ChatResponse = { content: text || null, reasoningContent: null };
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

/** 去掉 base64 音频的 data: 前缀，返回纯 payload。 */
function stripAudioDataPrefix(s: string): string {
  const m = s.match(/^data:[^;]+;base64,(.+)$/);
  return m ? m[1] : s;
}

/**
 * 将 Aalis 传过来的 audio payload（可能带 data: 前缀也可能不带）解析为
 * OpenAI input_audio 需要的 `{ data, format }`。format 推断优先级：
 * data URL 的 mime 后缀 → 默认 wav。
 */
function decodeAudioForOpenAI(payload: string): { data: string; format: string } {
  const m = payload.match(/^data:audio\/([^;]+);base64,(.+)$/);
  if (m) {
    const fmt = m[1].toLowerCase();
    const norm =
      fmt === 'mpeg' || fmt === 'mp3'
        ? 'mp3'
        : fmt === 'x-wav' || fmt === 'wave' || fmt === 'wav'
          ? 'wav'
          : fmt === 'ogg' || fmt === 'oga' || fmt === 'opus'
            ? 'ogg'
            : fmt === 'm4a' || fmt === 'mp4' || fmt === 'aac'
              ? 'm4a'
              : 'wav';
    return { data: m[2], format: norm };
  }
  return { data: stripAudioDataPrefix(payload), format: 'wav' };
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ===== 模型能力映射 =====

const { Chat, ToolCalling, Streaming, Vision, Audio } = LLMCapabilities;

const MODEL_CAPABILITIES: Record<string, LLMCapability[]> = {
  'llama3.1': [Chat, ToolCalling, Streaming],
  'llama3.2': [Chat, ToolCalling, Streaming],
  'llama3.3': [Chat, ToolCalling, Streaming],
  llava: [Chat, Streaming, Vision],
  'llava-llama3': [Chat, Streaming, Vision],
  gemma2: [Chat, Streaming],
  gemma3: [Chat, ToolCalling, Streaming, Vision],
  gemma4: [Chat, ToolCalling, Streaming, Vision],
  'qwen2.5': [Chat, ToolCalling, Streaming],
  'qwen2.5-coder': [Chat, ToolCalling, Streaming],
  qwen3: [Chat, ToolCalling, Streaming],
  mistral: [Chat, ToolCalling, Streaming],
  'deepseek-r1': [Chat, Streaming],
  phi4: [Chat, Streaming],
  'command-r': [Chat, ToolCalling, Streaming],
};

const DEFAULT_CAPABILITIES: LLMCapability[] = [Chat];

function resolveCapabilities(model: string, userOverride?: unknown, providerCaps?: LLMCapability[]): LLMCapability[] {
  const out = new Set<LLMCapability>(providerCaps ?? []);
  if (Array.isArray(userOverride) && userOverride.length > 0) {
    for (const c of userOverride as LLMCapability[]) out.add(c);
    return [...out];
  }
  // 去掉 tag 部分（如 llama3.1:8b → llama3.1）
  const baseName = model.split(':')[0].toLowerCase();

  // Gemma 4 E 系列（e2b / e4b）原生支持音频输入（约 300M Audio encoder）。
  // 参考 https://ollama.com/library/gemma4
  const isGemma4Audio = /^gemma4:e[24]b/.test(model.toLowerCase());

  if (MODEL_CAPABILITIES[baseName]) {
    for (const c of MODEL_CAPABILITIES[baseName]) out.add(c);
    if (isGemma4Audio) out.add(Audio);
    return [...out];
  }
  for (const [known, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (baseName.startsWith(known)) {
      for (const c of caps) out.add(c);
      if (isGemma4Audio) out.add(Audio);
      return [...out];
    }
  }
  if (baseName.includes('llava') || baseName.includes('vision')) {
    for (const c of [Chat, Streaming, Vision]) out.add(c);
    return [...out];
  }
  for (const c of DEFAULT_CAPABILITIES) out.add(c);
  if (isGemma4Audio) out.add(Audio);
  return [...out];
}

/** 解析适配器级别默认能力（逗号/空格/换行分隔） */
function parseProviderCapabilities(raw: unknown): LLMCapability[] {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[,\s\n]/)
    .map(s => s.trim())
    .filter(Boolean) as LLMCapability[];
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

// ===== Per-model handle：每个 model 独立的 LLMModel entry =====

class OllamaModelHandle implements LLMModel {
  constructor(
    private client: OllamaClient,
    readonly id: string,
    readonly providerId: string,
    readonly contextLength: number,
    readonly maxOutputTokens: number,
    private defaultThinking: boolean,
  ) {}

  chat(request: ChatModelRequest): Promise<ChatResponse> {
    return this.client.chat(this.id, request, this.defaultThinking);
  }

  chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
    return this.client.chatStream(this.id, request, this.defaultThinking);
  }
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const ollamaConfig: OllamaConfig = {
    baseUrl: (config.baseUrl as string) ?? 'http://localhost:11434',
    customModels: parseCustomModels(config.customModels),
    modelCapabilities: parseModelCapabilities(config.modelCapabilities),
    providerCapabilities: parseProviderCapabilities(config.providerCapabilities),
    timeout: ((config.timeout as number) ?? 120) > 0 ? ((config.timeout as number) ?? 120) * 1000 : undefined,
    temperature: (config.temperature as number) ?? 0.7,
    maxTokens: (config.maxTokens as number) ?? 4096,
    contextLength: (config.contextLength as number) ?? 8192,
    keepAlive: (config.keepAlive as string) ?? '5m',
    thinking: config.thinking !== false,
  };

  const client = new OllamaClient(ollamaConfig, ctx.logger);

  // 探测远端 + 合并自定义模型
  const remoteIds = await client.fetchRemoteModelIds();
  const remoteSet = new Set(remoteIds);
  for (const cm of ollamaConfig.customModels) {
    if (remoteSet.has(cm)) {
      ctx.logger.warn(`自定义模型 "${cm}" 与自动发现的模型重复，请在配置中去重`);
    }
  }
  const allModelIds = [...remoteIds, ...ollamaConfig.customModels.filter(id => !remoteSet.has(id))];

  if (allModelIds.length === 0) {
    ctx.logger.warn(`Ollama 已连接: ${ollamaConfig.baseUrl}，但未发现任何可用模型；不注册任何 LLM entry`);
    return;
  }

  const baseLabel = `Ollama (${ollamaConfig.baseUrl.replace(/^https?:\/\//, '')})`;

  // 为每个 model 注册独立的 LLMModel entry
  for (const modelId of allModelIds) {
    const capabilities = resolveCapabilities(
      modelId,
      ollamaConfig.modelCapabilities.get(modelId),
      ollamaConfig.providerCapabilities,
    );
    const handle = new OllamaModelHandle(
      client,
      modelId,
      ctx.id,
      ollamaConfig.contextLength,
      ollamaConfig.maxTokens,
      ollamaConfig.thinking,
    );
    ctx.provide('llm', handle, {
      capabilities,
      label: `${baseLabel} / ${modelId}`,
      entryId: `${ctx.id}/${modelId}`,
    });
  }

  ctx.logger.info(`Ollama 已连接: ${ollamaConfig.baseUrl}，注册 ${allModelIds.length} 个 model entry`);
}
