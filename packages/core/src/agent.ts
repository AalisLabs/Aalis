import type { Context } from './context.js';
import type {
  IncomingMessage,
  Message,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMService,
  MemoryService,
  PersonaService,
  ToolCallContext,
  ToolCall,
} from './types.js';
import type { Logger } from './logger.js';

const BASE_SYSTEM_PROMPT = `你是一个智能助手。请根据以下准则行动：
- 诚实、准确地回答用户的问题
- 当工具能够帮助回答问题时，主动使用工具
- 如果不确定，请坦诚说明而不是猜测
- 利用之前对话的上下文来提供连贯的体验
- 回答应当简洁清晰，除非用户要求详细解释`;

/**
 * 会话代理 —— 核心对话编排器
 *
 * 负责:
 * 1. 监听 message:received 事件
 * 2. 组装系统提示 (persona + base)
 * 3. 加载历史消息 (memory)
 * 4. 收集可用工具 (tools registry)
 * 5. 调用 LLM 服务
 * 6. 执行工具调用循环
 * 7. 发出 message:send 事件
 */
export class Agent {
  private ctx: Context;
  private logger: Logger;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.logger = ctx.logger.child('agent');

    // 监听传入的消息
    ctx.on('message:received', (msg) => this.handleMessage(msg));
    this.logger.info('会话代理已初始化');
  }

  /**
   * 消费流式 LLM 调用，累积完整响应，同时向前端推送增量事件
   */
  private async consumeStream(
    llm: LLMService,
    request: ChatRequest,
    sessionId: string,
    platform: string,
  ): Promise<ChatResponse> {
    let content = '';
    let reasoningContent = '';
    let toolCalls: ToolCall[] | undefined;
    let usage: ChatResponse['usage'] | undefined;

    for await (const chunk of llm.chatStream(request)) {
      if (chunk.contentDelta) {
        content += chunk.contentDelta;
        await this.ctx.emit('message:stream', {
          sessionId,
          platform,
          contentDelta: chunk.contentDelta,
        });
      }
      if (chunk.reasoningDelta) {
        reasoningContent += chunk.reasoningDelta;
        await this.ctx.emit('message:stream', {
          sessionId,
          platform,
          reasoningDelta: chunk.reasoningDelta,
        });
      }
      if (chunk.done) {
        toolCalls = chunk.toolCalls;
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    return {
      content,
      reasoningContent: reasoningContent || undefined,
      toolCalls,
      usage,
    };
  }

  private async handleMessage(incoming: IncomingMessage): Promise<void> {
    // Hook: message:before — 插件可以修改或拦截消息
    const msgHookData = { message: incoming };
    let aborted = false;
    await this.ctx.hooks.run('message:before', msgHookData, async () => {
      // 默认行为：继续处理
    });
    // 如果中间件未调用 next，msgHookData 不会变但流程不中断
    // 我们需要通过一个标记来判断是否被拦截
    // 更好的方式：使用 run 返回是否完成了管道
    // 但当前 run 总是 resolve，所以我们用一个 sentinel
    incoming = msgHookData.message; // 使用可能被修改的消息

    const llm = this.ctx.getService<LLMService>('llm');
    if (!llm) {
      this.logger.warn('LLM 服务不可用，无法处理消息');
      await this.ctx.emit('message:send', {
        content: '[系统] LLM 服务不可用，请检查配置。',
        sessionId: incoming.sessionId,
        platform: incoming.platform,
      });
      return;
    }

    // 从 LLM 服务读取参数
    const temperature = llm.getTemperature();
    const maxTokens = llm.getMaxTokens();
    const maxToolIterations = llm.getMaxToolIterations();

    try {
      const messages = await this.buildMessages(incoming);
      const tools = this.ctx.tools.getDefinitions();
      const toolCtx: ToolCallContext = {
        sessionId: incoming.sessionId,
        userId: incoming.userId,
        platform: incoming.platform,
      };

      // Hook: llm-call:before — 插件可以修改消息或工具列表
      const llmBeforeData = { messages, tools };
      await this.ctx.hooks.run('llm-call:before', llmBeforeData);

      let response = await this.consumeStream(llm, {
        messages: llmBeforeData.messages,
        tools: llmBeforeData.tools.length > 0 ? llmBeforeData.tools : undefined,
        temperature,
        maxTokens,
      }, incoming.sessionId, incoming.platform);

      // Hook: llm-call:after — 插件可以处理 LLM 返回结果
      const llmAfterData = { response, messages: llmBeforeData.messages };
      await this.ctx.hooks.run('llm-call:after', llmAfterData);
      response = llmAfterData.response;

      // 收集所有思考内容
      const allReasoning: string[] = [];
      if (response.reasoningContent) {
        allReasoning.push(response.reasoningContent);
      }

      // 工具调用循环
      let iterations = 0;
      while (response.toolCalls && response.toolCalls.length > 0 && iterations < maxToolIterations) {
        iterations++;
        this.logger.debug(`工具调用迭代 ${iterations}: ${response.toolCalls.map(tc => tc.function.name).join(', ')}`);

        // 将 assistant 消息 (含 toolCalls) 加入历史
        llmBeforeData.messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
          reasoningContent: response.reasoningContent,
        });

        // 执行每个工具调用
        for (const toolCall of response.toolCalls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          // Hook: tool-call:before — 插件可以拦截或修改工具调用
          const toolBeforeData = { name: toolCall.function.name, args, toolCallContext: toolCtx };
          await this.ctx.hooks.run('tool-call:before', toolBeforeData);

          // 通知平台：工具开始执行
          this.ctx.emit('tool:execute', {
            sessionId: incoming.sessionId,
            platform: incoming.platform,
            toolName: toolBeforeData.name,
            args: toolBeforeData.args,
            phase: 'start',
          });

          let result = await this.ctx.tools.execute(
            toolBeforeData.name,
            toolBeforeData.args,
            toolCtx,
          );

          // Hook: tool-call:after — 插件可以处理工具执行结果
          const toolAfterData = { name: toolBeforeData.name, result, toolCallContext: toolCtx };
          await this.ctx.hooks.run('tool-call:after', toolAfterData);
          result = toolAfterData.result;

          // 通知平台：工具执行完成
          this.ctx.emit('tool:execute', {
            sessionId: incoming.sessionId,
            platform: incoming.platform,
            toolName: toolBeforeData.name,
            args: toolBeforeData.args,
            phase: 'end',
            result,
          });

          llmBeforeData.messages.push({
            role: 'tool',
            content: result,
            toolCallId: toolCall.id,
          });
        }

        // 继续请求 LLM (再次经过 hooks)
        const nextLlmData = { messages: llmBeforeData.messages, tools: llmBeforeData.tools };
        await this.ctx.hooks.run('llm-call:before', nextLlmData);

        response = await this.consumeStream(llm, {
          messages: nextLlmData.messages,
          tools: nextLlmData.tools.length > 0 ? nextLlmData.tools : undefined,
          temperature,
          maxTokens,
        }, incoming.sessionId, incoming.platform);

        const nextLlmAfterData = { response, messages: nextLlmData.messages };
        await this.ctx.hooks.run('llm-call:after', nextLlmAfterData);
        response = nextLlmAfterData.response;

        if (response.reasoningContent) {
          allReasoning.push(response.reasoningContent);
        }
      }

      let replyContent = response.content ?? '';

      // Hook: response:before — 插件可以修改最终回复
      const responseData = { content: replyContent, sessionId: incoming.sessionId };
      await this.ctx.hooks.run('response:before', responseData);
      replyContent = responseData.content;

      // 保存消息到记忆
      await this.saveToMemory(incoming.sessionId, {
        role: 'user',
        content: incoming.content,
        timestamp: Date.now(),
      });
      await this.saveToMemory(incoming.sessionId, {
        role: 'assistant',
        content: replyContent,
        timestamp: Date.now(),
      });

      // 发出回复
      const combinedReasoning = allReasoning.length > 0
        ? allReasoning.join('\n\n---\n\n')
        : undefined;

      // 发出流结束标记
      await this.ctx.emit('message:stream', {
        sessionId: incoming.sessionId,
        platform: incoming.platform,
        done: true,
      });

      await this.ctx.emit('message:send', {
        content: replyContent,
        sessionId: incoming.sessionId,
        platform: incoming.platform,
        reasoningContent: combinedReasoning,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`处理消息失败: ${message}`);
      await this.ctx.emit('message:send', {
        content: `[错误] ${message}`,
        sessionId: incoming.sessionId,
        platform: incoming.platform,
      });
    }
  }

  /**
   * 构建发送给 LLM 的消息列表
   */
  private async buildMessages(incoming: IncomingMessage): Promise<Message[]> {
    const messages: Message[] = [];

    // 1. 系统提示
    const systemPrompt = this.buildSystemPrompt();
    messages.push({ role: 'system', content: systemPrompt });

    // 2. 历史消息
    const memory = this.ctx.getService<MemoryService>('memory');
    if (memory) {
      try {
        const history = await memory.getHistory(incoming.sessionId, 50);
        messages.push(...history);
      } catch (err) {
        this.logger.warn('获取历史消息失败:', err);
      }
    }

    // 3. 当前用户消息
    messages.push({
      role: 'user',
      content: incoming.content,
      timestamp: Date.now(),
    });

    return messages;
  }

  /**
   * 构建系统提示词
   */
  private buildSystemPrompt(): string {
    const persona = this.ctx.getService<PersonaService>('persona');
    if (persona) {
      const personaPrompt = persona.getSystemPrompt();
      return `${personaPrompt}\n\n${BASE_SYSTEM_PROMPT}`;
    }
    return BASE_SYSTEM_PROMPT;
  }

  /**
   * 保存消息到记忆服务
   */
  private async saveToMemory(sessionId: string, message: Message): Promise<void> {
    const memory = this.ctx.getService<MemoryService>('memory');
    if (memory) {
      try {
        await memory.saveMessage(sessionId, message);
      } catch (err) {
        this.logger.warn('保存消息到记忆失败:', err);
      }
    }
  }
}
