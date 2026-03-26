import type {
  Context,
  AgentService,
  IncomingMessage,
  Message,
  ChatRequest,
  ChatResponse,
  LLMService,
  MemoryService,
  PersonaService,
  ToolCallContext,
  ToolCall,
  ConfigSchema,
  PluginModule,
} from '@aalis/core';
import type { Logger } from '@aalis/core';

/**
 * 默认 Agent 实现 —— 对话编排器
 *
 * 负责:
 * 1. 组装系统提示 (persona + base)
 * 2. 加载历史消息 (memory)
 * 3. 收集可用工具 (tools registry)
 * 4. 调用 LLM 服务
 * 5. 执行工具调用循环
 * 6. 发出 message:send 事件
 *
 * 外部插件可以注册高优先级的 AgentService 来完全替换此默认实现。
 */
class DefaultAgent implements AgentService {
  private ctx: Context;
  private logger: Logger;
  private systemPrompt: string;
  private memoryTokenBudget: number;
  /** 平台 → 启用的工具分组映射 */
  private toolGroups: Record<string, string[]>;

  /**
   * 活跃 AbortController 表
   *
   * key = `${sessionId}::${source}` — 同一 session 不同来源（user / scheduler）
   * 独立管理，互不打断；同来源新消息会中止旧的生成。
   */
  private activeControllers = new Map<string, AbortController>();

  constructor(ctx: Context, config: Record<string, unknown>) {
    this.ctx = ctx;
    this.logger = ctx.logger.child('agent');
    this.systemPrompt = (config.systemPrompt as string) || '';
    this.memoryTokenBudget = (config.memoryTokenBudget as number) ?? 4096;
    this.toolGroups = parseToolGroups(config.toolGroups);
    this.logger.info('默认对话代理已初始化');
  }

  /** 生成 lane key：同 session + 同 source 共用一个 lane */
  private laneKey(sessionId: string, source?: string): string {
    return `${sessionId}::${source ?? 'user'}`;
  }

  /**
   * 中止指定会话的当前生成（所有 lane）
   */
  abort(sessionId: string): void {
    for (const [key, controller] of this.activeControllers) {
      if (key.startsWith(`${sessionId}::`)) {
        controller.abort();
        this.activeControllers.delete(key);
      }
    }
    this.logger.info(`生成已中止: session=${sessionId}`);
  }

  /**
   * 消费流式 LLM 调用，累积完整响应，同时向前端推送增量事件
   */
  private async consumeStream(
    llm: LLMService,
    request: ChatRequest,
    sessionId: string,
    platform: string,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    let content = '';
    let reasoningContent = '';
    let toolCalls: ToolCall[] | undefined;
    let usage: ChatResponse['usage'] | undefined;

    for await (const chunk of llm.chatStream(request)) {
      // 检查中止信号
      if (signal?.aborted) {
        throw new DOMException('Generation aborted', 'AbortError');
      }
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

  /**
   * Debug 模式下格式化输出 LLM 响应详情
   */
  private debugLogResponse(response: ChatResponse, elapsedMs: number, iteration?: number): void {
    const tag = iteration != null ? `LLM 响应 (工具迭代 #${iteration})` : 'LLM 响应';
    const sep = '━'.repeat(52);
    const lines: string[] = ['', sep, `  ${tag}  (${elapsedMs}ms)`, sep];

    // 内容
    if (response.content) {
      lines.push('  内容:');
      for (const line of response.content.split('\n')) {
        lines.push(`    ${line}`);
      }
    } else {
      lines.push('  内容: (空)');
    }

    // 推理
    if (response.reasoningContent) {
      lines.push('');
      lines.push('  推理:');
      for (const line of response.reasoningContent.split('\n')) {
        lines.push(`    ${line}`);
      }
    }

    // 工具调用
    if (response.toolCalls?.length) {
      lines.push('');
      lines.push('  工具调用:');
      for (const tc of response.toolCalls) {
        lines.push(`    -> ${tc.function.name}`);
        // 格式化 JSON 参数
        try {
          const pretty = JSON.stringify(JSON.parse(tc.function.arguments), null, 2);
          for (const pLine of pretty.split('\n')) {
            lines.push(`       ${pLine}`);
          }
        } catch {
          lines.push(`       ${tc.function.arguments}`);
        }
      }
    }

    // Token 用量
    if (response.usage) {
      const u = response.usage;
      lines.push('');
      lines.push(`  Token: 输入 ${u.promptTokens} / 输出 ${u.completionTokens} / 总计 ${u.totalTokens}`);
    }

    lines.push(sep);
    this.logger.debug(lines.join('\n'));
  }

  async handleMessage(incoming: IncomingMessage): Promise<void> {
    const lane = this.laneKey(incoming.sessionId, incoming.source);

    // 仅中止同一 lane（同 session + 同 source）的旧生成；不同来源互不打断
    const prev = this.activeControllers.get(lane);
    if (prev) prev.abort();

    const controller = new AbortController();
    this.activeControllers.set(lane, controller);

    try {
      await this._handleMessageInner(incoming, controller.signal);
    } finally {
      // 仅清理自己创建的 controller（避免清掉后续新请求的）
      if (this.activeControllers.get(lane) === controller) {
        this.activeControllers.delete(lane);
      }
    }
  }

  private async _handleMessageInner(incoming: IncomingMessage, signal: AbortSignal): Promise<void> {
    // Hook: message:before — 插件可以修改或拦截消息
    // 中间件不调用 next() 即可中断整个流程（包括 LLM 调用）
    const msgHookData: { message: IncomingMessage; metadata: Record<string, unknown> } = {
      message: incoming,
      metadata: {},
    };

    let handled = false;

    await this.ctx.hooks.run('message:before', msgHookData, async () => {
      handled = true;
      // ===== defaultAction: 全部消息处理逻辑在此 =====
      // 中间件不调用 next() → 此处永远不执行 → 消息被拦截
      incoming = msgHookData.message;

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
      const contextLength = llm.getContextLength();
      // 预留 token 预算 = 上下文长度 - 最大输出 token - 安全余量
      const tokenBudget = Math.max(1024, contextLength - maxTokens - 512);

      try {
        const messages = await this.buildMessages(incoming);
        // 根据平台筛选工具分组
        const enabledGroups = this.toolGroups[incoming.platform] ?? this.toolGroups['default'];
        const tools = this.ctx.tools?.getDefinitions(
          enabledGroups ? { groups: enabledGroups } : undefined,
        ) ?? [];
        const toolCtx: ToolCallContext = {
          sessionId: incoming.sessionId,
          userId: incoming.userId,
          platform: incoming.platform,
          enabledGroups,
        };

        // Hook: llm-call:before — 插件可以修改消息或工具列表
        const llmBeforeData = { messages, tools };
        await this.ctx.hooks.run('llm-call:before', llmBeforeData);

        // 裁剪消息以确保不超过上下文窗口
        llmBeforeData.messages = this.trimMessages(llmBeforeData.messages, tokenBudget);

        this.logger.debug(
          `LLM 请求: ${llmBeforeData.messages.length} 条消息, ` +
          `${llmBeforeData.tools.length} 个工具, ` +
          `temperature=${temperature}, maxTokens=${maxTokens}`,
        );
        const t0 = Date.now();
        let response = await this.consumeStream(llm, {
          messages: llmBeforeData.messages,
          tools: llmBeforeData.tools.length > 0 ? llmBeforeData.tools : undefined,
          temperature,
          maxTokens,
          signal,
        }, incoming.sessionId, incoming.platform, signal);

        this.debugLogResponse(response, Date.now() - t0);

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
          if (signal.aborted) throw new DOMException('Generation aborted', 'AbortError');
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
            await this.ctx.emit('tool:execute', {
              sessionId: incoming.sessionId,
              platform: incoming.platform,
              toolName: toolBeforeData.name,
              args: toolBeforeData.args,
              phase: 'start',
            });

            this.logger.debug(`工具执行: ${toolBeforeData.name} 参数=${JSON.stringify(toolBeforeData.args)}`);
            const toolT0 = Date.now();
            let result = await (this.ctx.tools?.execute(
              toolBeforeData.name,
              toolBeforeData.args,
              toolCtx,
            ) ?? Promise.resolve(JSON.stringify({ error: 'tools 服务不可用' })));

            // Hook: tool-call:after — 插件可以处理工具执行结果
            const toolAfterData = { name: toolBeforeData.name, result, toolCallContext: toolCtx };
            await this.ctx.hooks.run('tool-call:after', toolAfterData);
            result = toolAfterData.result;
            this.logger.debug(`工具完成: ${toolBeforeData.name} (${Date.now() - toolT0}ms) 结果=${result}`);

            // 通知平台：工具执行完成
            await this.ctx.emit('tool:execute', {
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

          // 裁剪消息以确保不超过上下文窗口
          nextLlmData.messages = this.trimMessages(nextLlmData.messages, tokenBudget);

          const tN = Date.now();
          response = await this.consumeStream(llm, {
            messages: nextLlmData.messages,
            tools: nextLlmData.tools.length > 0 ? nextLlmData.tools : undefined,
            temperature,
            maxTokens,
            signal,
          }, incoming.sessionId, incoming.platform, signal);

          this.debugLogResponse(response, Date.now() - tN, iterations);

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

        // 保存用户消息到记忆
        await this.saveToMemory(incoming.sessionId, {
          role: 'user',
          content: incoming.content,
          timestamp: Date.now(),
        });

        // 发出流结束标记
        await this.ctx.emit('message:stream', {
          sessionId: incoming.sessionId,
          platform: incoming.platform,
          done: true,
        });

        // 空回复（outputFormat 中 reply 字段为空字符串）时静默，不发送消息
        if (replyContent.length === 0) {
          this.logger.debug(`空回复，跳过发送 (session=${incoming.sessionId})`);
        } else {
          await this.saveToMemory(incoming.sessionId, {
            role: 'assistant',
            content: replyContent,
            timestamp: Date.now(),
          });

          const combinedReasoning = allReasoning.length > 0
            ? allReasoning.join('\n\n---\n\n')
            : undefined;

          await this.ctx.emit('message:send', {
            content: replyContent,
            sessionId: incoming.sessionId,
            platform: incoming.platform,
            reasoningContent: combinedReasoning,
          });
        }

        // Hook: message:after — 插件可以在完整消息周期结束后做后处理
        await this.ctx.hooks.run('message:after', {
          message: incoming,
          response: replyContent,
          sessionId: incoming.sessionId,
          metadata: msgHookData.metadata,
        });
      } catch (err) {
        // 中止错误 — 静默退出，已生成的流内容保留在前端
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.logger.info(`生成已中止: session=${incoming.sessionId}`);
          await this.ctx.emit('message:stream', {
            sessionId: incoming.sessionId,
            platform: incoming.platform,
            done: true,
          });
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`处理消息失败: ${message}`);
        await this.ctx.emit('message:send', {
          content: `[错误] ${message}`,
          sessionId: incoming.sessionId,
          platform: incoming.platform,
        });
      }
    });

    // 消息被中间件拦截（如 chat-flow 缓冲），通知前端结束 loading
    if (!handled) {
      await this.ctx.emit('message:stream', {
        sessionId: incoming.sessionId,
        platform: incoming.platform,
        done: true,
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
      // persona 已包含身份信息，仅追加行为准则
      return this.systemPrompt
        ? `${personaPrompt}\n\n${this.systemPrompt}`
        : personaPrompt;
    }
    // 无 persona 时仅使用用户配置的提示词
    return this.systemPrompt;
  }

  /**
   * 粗略估算消息列表的总 token 数
   */
  private estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateMsgTokens(msg);
    }
    return total;
  }

  /**
   * 估算单条消息的 token 数
   */
  private estimateMsgTokens(msg: Message): number {
    let t = 4;
    if (msg.content) t += Math.ceil(msg.content.length / 3);
    if (msg.toolCalls) t += Math.ceil(JSON.stringify(msg.toolCalls).length / 3);
    if (msg.reasoningContent) t += Math.ceil(msg.reasoningContent.length / 3);
    return t;
  }

  /**
   * 裁剪消息列表，使总 token 数不超过预算
   *
   * 保护策略：
   *  1. 首条 system（主提示词）和末条（当前用户消息）永不删除
   *  2. hook 注入的 system 消息（长期记忆等）有独立的 memoryTokenBudget 保护额度
   *  3. 优先从最旧的非 system 历史消息开始删除
   *  4. 如果还不够，按比例缩减超长的 tool 结果内容
   *  5. 最后才动 system 消息（长期记忆）
   */
  private trimMessages(messages: Message[], budget: number): Message[] {
    const result = messages.map(m => ({ ...m }));
    let estimated = this.estimateTokens(result);
    if (estimated <= budget) return result;

    // 计算 system 消息（首条之外的，即 hook 注入的长期记忆等）的 token 总量
    const systemIndices: number[] = [];
    let systemTokens = 0;
    for (let i = 1; i < result.length - 1; i++) {
      if (result[i].role === 'system') {
        systemIndices.push(i);
        systemTokens += this.estimateMsgTokens(result[i]);
      }
    }
    // 如果长期记忆超出预留额度，截断长期记忆内容本身
    if (systemTokens > this.memoryTokenBudget && systemIndices.length > 0) {
      // 按比例缩减每条 system 消息的 content
      const ratio = this.memoryTokenBudget / systemTokens;
      for (const idx of systemIndices) {
        const msg = result[idx];
        if (msg.content && msg.content.length > 200) {
          const oldTokens = this.estimateMsgTokens(msg);
          const targetLen = Math.max(200, Math.floor(msg.content.length * ratio));
          msg.content = msg.content.slice(0, targetLen) + '\n... [记忆内容已缩减]';
          estimated -= (oldTokens - this.estimateMsgTokens(msg));
        }
      }
    }
    if (estimated <= budget) return result;

    // 第一轮：从最旧的非 system 历史消息开始删除（跳过末条）
    // 注意：assistant(含toolCalls) + 紧跟的 tool 消息必须成组删除
    let i = 1;
    while (estimated > budget && i < result.length - 1) {
      if (result[i].role === 'system') {
        i++;
        continue;
      }
      // 如果是 assistant 且含 toolCalls，连同后续的 tool 消息一起删除
      if (result[i].role === 'assistant' && result[i].toolCalls && result[i].toolCalls!.length > 0) {
        estimated -= this.estimateMsgTokens(result[i]);
        result.splice(i, 1);
        for (let s = 0; s < systemIndices.length; s++) {
          if (systemIndices[s] > i) systemIndices[s]--;
        }
        // 继续删除紧跟的 tool 消息
        while (i < result.length - 1 && result[i].role === 'tool') {
          estimated -= this.estimateMsgTokens(result[i]);
          result.splice(i, 1);
          for (let s = 0; s < systemIndices.length; s++) {
            if (systemIndices[s] > i) systemIndices[s]--;
          }
        }
        continue;
      }
      // 如果是孤立的 tool 消息（其 assistant 已删），也删除
      estimated -= this.estimateMsgTokens(result[i]);
      result.splice(i, 1);
      for (let s = 0; s < systemIndices.length; s++) {
        if (systemIndices[s] > i) systemIndices[s]--;
      }
    }
    if (estimated <= budget) {
      this.logger.info(`上下文截断: ${messages.length} → ${result.length} 条消息 (约 ${estimated} tokens)`);
      return result;
    }

    // 第二轮（极端情况）：删除 hook 注入的 system 消息
    for (let j = systemIndices.length - 1; j >= 0 && estimated > budget; j--) {
      const idx = systemIndices[j];
      if (idx > 0 && idx < result.length - 1) {
        estimated -= this.estimateMsgTokens(result[idx]);
        result.splice(idx, 1);
      }
    }

    if (result.length < messages.length) {
      this.logger.info(`上下文截断: ${messages.length} → ${result.length} 条消息 (约 ${estimated} tokens)`);
    }
    return result;
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

// ----- 插件导出 -----

export const name = '@aalis/plugin-agent-default';

export const provides = ['agent'];

export const inject = {
  optional: ['llm', 'memory', 'persona'],
};

export const configSchema: ConfigSchema = {
  systemPrompt: {
    type: 'string',
    label: '行为准则提示词',
    description: '定义 Agent 的行为准则。当人设插件存在时，身份描述由人设提供，此处仅作为行为指令追加。',
  },
  memoryTokenBudget: {
    type: 'number',
    label: '长期记忆预留 Token',
    default: 4096,
    description: '为长期记忆注入的 system 消息预留的 token 额度，截断时不会删除这些消息',
  },
  toolGroups: {
    type: 'array',
    label: '工具分组',
    description: '按平台配置启用的工具分组。每条指定一个平台标识（如 onebot、web）或 default（默认），以及该平台启用的分组名列表。未配置的平台使用所有工具。',
    items: {
      platform: {
        type: 'string',
        label: '平台标识',
        description: '平台名（如 onebot、webui）或 default 表示默认',
      },
      groups: {
        type: 'multiselect',
        label: '启用的工具组',
        dynamicOptions: 'toolGroups',
        allowCustom: true,
      },
    },
  },
};

export const defaultConfig = {
  systemPrompt: '',
  memoryTokenBudget: 4096,
  toolGroups: [],
};

/** 将 SchemaArray 格式或旧 Record 格式的 toolGroups 统一转为 Record<string, string[]> */
function parseToolGroups(raw: unknown): Record<string, string[]> {
  if (!raw) return {};
  // 新格式: Array<{ platform: string; groups: string[] }>
  if (Array.isArray(raw)) {
    const result: Record<string, string[]> = {};
    for (const entry of raw) {
      if (entry && typeof entry === 'object' && typeof entry.platform === 'string' && Array.isArray(entry.groups)) {
        result[entry.platform] = entry.groups;
      }
    }
    return result;
  }
  // 旧格式兼容: Record<string, string[]>
  if (typeof raw === 'object') {
    return raw as Record<string, string[]>;
  }
  return {};
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const agent = new DefaultAgent(ctx, config);
  ctx.provide('agent', agent);
}
