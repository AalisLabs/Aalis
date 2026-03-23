import type {
  Context,
  ChatRequest,
  ChatResponse,
  LLMService,
  ModelInfo,
  Message,
  ToolDefinition,
  ToolCall,
} from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-deepseek';
export const provides = ['llm'];

// ===== 配置 =====

interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeout?: number;
}

// ===== DeepSeek API 消息格式 =====

interface APIMessage {
  role: string;
  content: string | null;
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
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeout: number;
  private logger;

  constructor(config: DeepSeekConfig, logger: Context['logger']) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.model = config.model;
    this.timeout = config.timeout ?? 120000;
    this.logger = logger;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
    this.logger.info(`模型已切换: ${model}`);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map(m => ({ id: m.id }));
    } catch {
      this.logger.warn('获取模型列表失败');
      return [];
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = request.messages.map(m => this.toAPIMessage(m));
    const tools = request.tools?.map(t => this.toAPITool(t));

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      // 启用思考模式
      thinking: { type: 'enabled' },
    };
    // 思考模式下 temperature 等参数不生效，但不会报错

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    this.logger.debug(`请求 DeepSeek (思考模式): ${this.model}, ${messages.length} 条消息, ${tools?.length ?? 0} 个工具`);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API 错误 (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as APIChatResponse;
    const choice = data.choices[0];

    if (!choice) {
      throw new Error('DeepSeek 返回了空的 choices');
    }

    const result: ChatResponse = {
      content: choice.message.content,
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

  /**
   * 转换为 DeepSeek API 消息格式
   * 关键：在工具调用循环中保留 reasoning_content，
   * 但历史消息（从 memory 加载）不含 reasoning_content
   */
  private toAPIMessage(msg: Message): APIMessage {
    const apiMsg: APIMessage = {
      role: msg.role,
      content: msg.content,
    };

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
        strict: tool.function.strict,
        description: tool.function.description,
        parameters: tool.function.parameters as Record<string, unknown>,
      },
    };
  }
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const deepseekConfig: DeepSeekConfig = {
    apiKey: (config.apiKey as string) ?? '',
    baseUrl: (config.baseUrl as string) ?? 'https://api.deepseek.com',
    model: (config.model as string) ?? 'deepseek-chat',
    timeout: config.timeout as number | undefined,
  };

  if (!deepseekConfig.apiKey) {
    ctx.logger.error('未配置 apiKey，DeepSeek 插件无法启动');
    return;
  }

  const service = new DeepSeekLLMService(deepseekConfig, ctx.logger);

  // 注册 LLM 服务，声明能力（含 thinking 能力标记）
  ctx.provide('llm', service, {
    capabilities: ['chat', 'tool_calling', 'thinking'],
  });

  ctx.logger.info(`DeepSeek 思考模式已连接: ${deepseekConfig.baseUrl} (${deepseekConfig.model})`);
}
