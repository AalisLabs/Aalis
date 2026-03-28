import type {
  Context,
  AgentService,
  IncomingMessage,
  Message,
  ToolCallContext,
  ToolCall,
  ToolDefinition,
  ConfigSchema,
  PreprocessorFn,
  PreprocessorInfo,
  PluginGroupInfo,
  App,
  ChatRequest,
  ChatResponse,
  LLMService,
  MemoryService,
  PersonaService,
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
  private historyLimit: number;
  /** 平台 → 启用的工具分组映射 */
  private toolGroups: Record<string, string[]>;
  /** 用户指定的对话模型（空字符串 = 使用默认提供者的默认模型） */
  private preferredModel: string;
  /** 模型 ID → 提供者 contextId 映射缓存 */
  private modelProviderMap: Map<string, string> | null = null;

  /**
   * 活跃 AbortController 表
   *
   * key = `${sessionId}::${source}` — 同一 session 不同来源（user / scheduler）
   * 独立管理，互不打断；同来源新消息会中止旧的生成。
   */
  private activeControllers = new Map<string, AbortController>();

  /** 已注册的预处理器（name → { priority, dispose }） */
  private preprocessors = new Map<string, { priority: number; dispose: () => void }>();

  constructor(ctx: Context, config: Record<string, unknown>) {
    this.ctx = ctx;
    this.logger = ctx.logger.child('agent');
    this.systemPrompt = (config.systemPrompt as string) || '';
    this.memoryTokenBudget = (config.memoryTokenBudget as number) ?? 4096;
    this.historyLimit = (config.historyLimit as number) ?? 50;
    this.toolGroups = parseToolGroups(config.toolGroups);
    this.preferredModel = (config.preferredModel as string) || '';
    this.logger.info('默认对话代理已初始化');

    // 异步构建模型→提供者映射
    if (this.preferredModel) {
      this.buildModelProviderMap();
    }
  }

  /** 构建模型→提供者映射缓存 */
  private async buildModelProviderMap(): Promise<void> {
    const map = new Map<string, string>();
    const allProviders = this.ctx.getAllServices<LLMService>('llm');
    for (const p of allProviders) {
      if (typeof p.instance.listModels === 'function') {
        try {
          const models = await p.instance.listModels();
          for (const m of models) map.set(m.id, p.contextId);
        } catch { /* ignore */ }
      }
    }
    this.modelProviderMap = map;
    this.logger.debug(`Agent 模型映射已构建: ${map.size} 个模型`);
  }

  /**
   * 根据 preferredModel 配置获取 LLM 服务
   * - 有 preferredModel → 找到对应提供者并返回
   * - 无 preferredModel → 返回默认（首个）提供者
   */
  private resolveLLM(): { llm: LLMService; modelOverride?: string } | undefined {
    if (!this.preferredModel) {
      const llm = this.ctx.getService<LLMService>('llm');
      return llm ? { llm } : undefined;
    }
    // 有指定模型：查找拥有该模型的提供者
    const allProviders = this.ctx.getAllServices<LLMService>('llm');
    if (allProviders.length === 0) return undefined;

    if (this.modelProviderMap) {
      const targetContextId = this.modelProviderMap.get(this.preferredModel);
      if (targetContextId) {
        const found = allProviders.find(p => p.contextId === targetContextId);
        if (found) return { llm: found.instance, modelOverride: this.preferredModel };
      }
    }
    // 映射未命中：回退到默认提供者，但仍传递 model override
    return { llm: allProviders[0].instance, modelOverride: this.preferredModel };
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
   * 注册消息预处理器
   *
   * 底层通过 message:before 中间件实现。
   * 同名注册会自动替换旧的预处理器。
   */
  registerPreprocessor(name: string, handler: PreprocessorFn, priority = 500): () => void {
    // 同名替换
    const existing = this.preprocessors.get(name);
    if (existing) existing.dispose();

    const dispose = this.ctx.middleware('message:before', async (data, next) => {
      await handler(data.message, next);
    }, priority);

    const cleanup = () => {
      dispose();
      this.preprocessors.delete(name);
      this.logger.info(`预处理器已注销: ${name}`);
    };

    this.preprocessors.set(name, { priority, dispose: cleanup });
    this.logger.info(`预处理器已注册: ${name} (priority: ${priority})`);
    return cleanup;
  }

  /**
   * 获取当前所有已注册预处理器的元信息
   */
  getPreprocessors(): PreprocessorInfo[] {
    return [...this.preprocessors.entries()]
      .map(([name, { priority }]) => ({ name, priority }))
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取 Agent 子系统的插件分组
   *
   * 找出所有 provides 与 Agent inject.optional 有交集的插件。
   */
  getPluginGroups(): PluginGroupInfo[] {
    const app = this.ctx.getService<App>('app');
    if (!app) return [];

    const targetServices = new Set(inject.optional ?? []);
    const grouped: string[] = [];

    for (const p of app.plugins.getStatus()) {
      if (p.provides?.some(s => targetServices.has(s))) {
        grouped.push(p.instanceId);
      }
    }

    return [{ label: 'Agent', plugins: grouped }];
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

    // 检查是否期望结构化输出
    const persona = this.ctx.getService<PersonaService>('persona');
    const expectJson = !!persona?.getOutputFormat?.();

    // 尝试解析结构化输出 (outputFormat JSON)
    let parsedFormat: Record<string, unknown> | null = null;
    if (response.content) {
      const raw = response.content.trim();
      const jsonStr = raw.startsWith('{')
        ? raw
        : raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      try {
        const obj = JSON.parse(jsonStr);
        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
          parsedFormat = obj;
        }
      } catch { /* 非 JSON，正常文本 */ }
    }

    if (parsedFormat) {
      // 结构化输出：先展示原始 JSON，再逐字段展示
      lines.push('  原始 JSON:');
      try {
        const compact = JSON.stringify(parsedFormat);
        if (compact.length <= 200) {
          lines.push(`    ${compact}`);
        } else {
          for (const pLine of JSON.stringify(parsedFormat, null, 2).split('\n')) {
            lines.push(`    ${pLine}`);
          }
        }
      } catch { /* ignore */ }
      lines.push('');
      lines.push('  结构化输出:');
      for (const [key, value] of Object.entries(parsedFormat)) {
        const valStr = typeof value === 'string' ? value : JSON.stringify(value);
        if (valStr.includes('\n')) {
          lines.push(`    ${key}:`);
          for (const vLine of valStr.split('\n')) {
            lines.push(`      ${vLine}`);
          }
        } else {
          lines.push(`    ${key}: ${valStr}`);
        }
      }
    } else if (response.content) {
      // 普通文本
      lines.push('  内容:');
      for (const line of response.content.split('\n')) {
        lines.push(`    ${line}`);
      }
      // 期望 JSON 但模型返回了纯文本
      if (expectJson) {
        lines.push('');
        lines.push('  ⚠ 期望结构化输出(JSON)但模型返回了纯文本');
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

      const resolved = this.resolveLLM();
      if (!resolved) {
        this.logger.warn('LLM 服务不可用，无法处理消息');
        await this.ctx.emit('message:send', {
          content: '[系统] LLM 服务不可用，请检查配置。',
          sessionId: incoming.sessionId,
          platform: incoming.platform,
        });
        return;
      }
      const { llm, modelOverride } = resolved;

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
        const llmBeforeData = { messages, tools, sessionId: incoming.sessionId, userId: incoming.userId, platform: incoming.platform };
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
          model: modelOverride,
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

        // 收集工具调用摘要
        const toolCallSummaries: string[] = [];

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

            // 记录工具调用摘要（工具名 + 关键结果概要）
            const resultPreview = result.length > 200 ? result.slice(0, 200) + '...' : result;
            toolCallSummaries.push(`[${toolBeforeData.name}] ${resultPreview}`);

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
          const nextLlmData = { messages: llmBeforeData.messages, tools: llmBeforeData.tools, sessionId: incoming.sessionId, userId: incoming.userId, platform: incoming.platform };
          await this.ctx.hooks.run('llm-call:before', nextLlmData);

          // 裁剪消息以确保不超过上下文窗口
          nextLlmData.messages = this.trimMessages(nextLlmData.messages, tokenBudget);

          const tN = Date.now();
          response = await this.consumeStream(llm, {
            messages: nextLlmData.messages,
            tools: nextLlmData.tools.length > 0 ? nextLlmData.tools : undefined,
            temperature,
            maxTokens,
            model: modelOverride,
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

        // 回退：如果回复仍是 JSON 包裹（outputFormat 钩子不存在或未处理），尝试提取回复字段
        replyContent = this.extractJsonReply(replyContent);

        // 重复检测：如果回复与最近一条 assistant 消息完全相同，视为模型"卡壳"，静默跳过
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        if (replyContent && lastAssistant?.content && replyContent === lastAssistant.content) {
          this.logger.warn(`检测到重复回复，跳过发送 (session=${incoming.sessionId})`);
          replyContent = '';
        }

        // 保存用户消息到记忆（带发送者前缀，便于模型区分群聊中的不同成员）
        const senderLabel = incoming.nickname ?? incoming.userId;
        const userContentToSave = senderLabel
          ? `[${senderLabel}]: ${incoming.content}`
          : incoming.content;
        await this.saveToMemory(incoming.sessionId, {
          role: 'user',
          content: userContentToSave,
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
          // 如果有工具调用，将摘要附加到保存的消息中，便于长期记忆回溯
          let savedContent = replyContent;
          if (toolCallSummaries.length > 0) {
            const toolSummary = toolCallSummaries.join('\n');
            savedContent = `${replyContent}\n\n[工具调用过程]\n${toolSummary}`;
          }

          await this.saveToMemory(incoming.sessionId, {
            role: 'assistant',
            content: savedContent,
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
        const history = await memory.getHistory(incoming.sessionId, this.historyLimit);
        messages.push(...history);
      } catch (err) {
        this.logger.warn('获取历史消息失败:', err);
      }
    }

    // 3. 当前用户消息（带发送者前缀，与历史消息格式一致）
    const senderLabel = incoming.nickname ?? incoming.userId;
    let currentContent = senderLabel
      ? `[${senderLabel}]: ${incoming.content}`
      : incoming.content;

    // 附加引用回复上下文
    if (incoming.replyTo?.content) {
      const replyLabel = incoming.replyTo.nickname ?? incoming.replyTo.userId ?? '?';
      currentContent += `\n[引用 ${replyLabel} 的消息: ${incoming.replyTo.content}]`;
    }

    const userMessage: Message = {
      role: 'user',
      content: currentContent,
      timestamp: Date.now(),
    };

    // 多模态：将图片传递给 LLM（未被图像识别中间件消费的图片）
    if (incoming.images && incoming.images.length > 0) {
      userMessage.images = incoming.images;
    }

    messages.push(userMessage);

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
   * 渐进式压缩策略（保证 agent 在长工具链中无限运行）：
   *  1. 首条 system（主提示词）和末条消息永不删除
   *  2. 缩减超出预留额度的 system 消息（长期记忆）
   *  3. 截断过长的 tool 输出内容（保留头部关键信息）
   *  4. 将最旧的 assistant+tool 组压缩为紧凑摘要（保留决策上下文）
   *  5. 删除最旧的非 system 消息
   *  6. 最后手段：删除 hook 注入的 system 消息
   */
  private trimMessages(messages: Message[], budget: number): Message[] {
    const result = messages.map(m => ({ ...m }));
    let estimated = this.estimateTokens(result);
    if (estimated <= budget) return result;

    /** 重新扫描 system 消息索引（首条和末条之间） */
    const findSystemIndices = (): number[] => {
      const indices: number[] = [];
      for (let i = 1; i < result.length - 1; i++) {
        if (result[i].role === 'system') indices.push(i);
      }
      return indices;
    };

    // === Phase 1: 缩减超出预留额度的 system 消息 ===
    {
      const sysIdx = findSystemIndices();
      let sysTokens = sysIdx.reduce((s, i) => s + this.estimateMsgTokens(result[i]), 0);
      if (sysTokens > this.memoryTokenBudget && sysIdx.length > 0) {
        const ratio = this.memoryTokenBudget / sysTokens;
        for (const idx of sysIdx) {
          const msg = result[idx];
          if (msg.content && msg.content.length > 200) {
            const oldTokens = this.estimateMsgTokens(msg);
            const targetLen = Math.max(200, Math.floor(msg.content.length * ratio));
            msg.content = msg.content.slice(0, targetLen) + '\n... [记忆内容已缩减]';
            estimated -= (oldTokens - this.estimateMsgTokens(msg));
          }
        }
      }
    }
    if (estimated <= budget) return result;

    // === Phase 2: 截断过长的 tool 输出 ===
    for (let i = 1; i < result.length - 1; i++) {
      if (estimated <= budget) break;
      if (result[i].role === 'tool' && result[i].content && result[i].content!.length > 1500) {
        const oldTokens = this.estimateMsgTokens(result[i]);
        result[i].content = result[i].content!.slice(0, 500) + '\n... [工具输出已截断]';
        estimated -= (oldTokens - this.estimateMsgTokens(result[i]));
      }
    }
    if (estimated <= budget) return result;

    // === Phase 3: 将旧的 assistant+tool 组压缩为摘要 ===
    // 识别所有工具调用组 (assistant(toolCalls) + 紧跟的 tool 消息)
    {
      const groups: Array<{ start: number; end: number }> = [];
      for (let j = 1; j < result.length; j++) {
        if (result[j].role === 'assistant' && result[j].toolCalls?.length) {
          let end = j + 1;
          while (end < result.length && result[end].role === 'tool') end++;
          groups.push({ start: j, end });
          j = end - 1;
        }
      }

      // 从最旧开始压缩，保护最后一组（当前工具链需要完整结果）
      let offset = 0;
      for (let g = 0; g < groups.length - 1 && estimated > budget; g++) {
        const start = groups[g].start - offset;
        const end = groups[g].end - offset;
        const groupLen = end - start;

        // 计算当前组的 token
        let groupTokens = 0;
        const toolPreviews: string[] = [];
        for (let j = start; j < end; j++) {
          groupTokens += this.estimateMsgTokens(result[j]);
          if (result[j].role === 'tool') {
            const c = result[j].content ?? '';
            toolPreviews.push(c.length > 100 ? c.slice(0, 100) + '...' : c);
          }
        }

        // 构建紧凑摘要
        const aMsg = result[start];
        const names = aMsg.toolCalls!.map(tc => tc.function.name);
        const parts = names.map((n, idx) => `${n} → ${toolPreviews[idx] ?? '(无结果)'}`);
        let text = `[历史工具调用] ${parts.join(' | ')}`;
        if (aMsg.content) text = `${aMsg.content}\n${text}`;

        const summaryMsg: Message = { role: 'assistant', content: text };
        const summaryTokens = this.estimateMsgTokens(summaryMsg);

        // 仅在确实能节省 token 时压缩
        if (summaryTokens < groupTokens) {
          result.splice(start, groupLen, summaryMsg);
          estimated -= (groupTokens - summaryTokens);
          offset += groupLen - 1;
        }
      }
    }
    if (estimated <= budget) {
      if (result.length < messages.length) {
        this.logger.info(`上下文压缩: ${messages.length} → ${result.length} 条消息 (约 ${estimated} tokens)`);
      }
      return result;
    }

    // === Phase 4: 删除最旧的非 system 消息 ===
    {
      let i = 1;
      while (estimated > budget && i < result.length - 1) {
        if (result[i].role === 'system') { i++; continue; }
        // assistant(含toolCalls) + 紧跟的 tool 消息成组删除
        if (result[i].role === 'assistant' && result[i].toolCalls?.length) {
          estimated -= this.estimateMsgTokens(result[i]);
          result.splice(i, 1);
          while (i < result.length - 1 && result[i].role === 'tool') {
            estimated -= this.estimateMsgTokens(result[i]);
            result.splice(i, 1);
          }
          continue;
        }
        estimated -= this.estimateMsgTokens(result[i]);
        result.splice(i, 1);
      }
    }
    if (estimated <= budget) {
      this.logger.info(`上下文截断: ${messages.length} → ${result.length} 条消息 (约 ${estimated} tokens)`);
      return result;
    }

    // === Phase 5: 极端情况 — 删除 hook 注入的 system 消息 ===
    {
      const sysIdx = findSystemIndices();
      for (let j = sysIdx.length - 1; j >= 0 && estimated > budget; j--) {
        const idx = sysIdx[j];
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
   * 如果内容是 JSON 包裹的回复则提取纯文本，否则原样返回
   */
  private extractJsonReply(content: string): string {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return content;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return content;
      for (const key of ['response', 'reply', 'content', 'answer', 'text', 'msg', 'message']) {
        if (typeof parsed[key] === 'string') return parsed[key];
      }
    } catch { /* 非 JSON，原样返回 */ }
    return content;
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
export const displayName = '默认 Agent';

export const provides = ['agent'];

export const inject = {
  optional: ['llm', 'memory', 'persona'],
};

export const configSchema: ConfigSchema = {
  preferredModel: {
    type: 'select',
    label: '对话模型',
    description: '选择用于对话的模型。留空则使用默认（首个）LLM 提供者的默认模型。',
    default: '',
    options: [{ label: '默认', value: '' }],
    dynamicOptions: 'llm',
  },
  systemPrompt: {
    type: 'textarea',
    label: '行为准则提示词',
    description: '定义 Agent 的行为准则。当人设插件存在时，身份描述由人设提供，此处仅作为行为指令追加。',
  },
  memoryTokenBudget: {
    type: 'number',
    label: '长期记忆预留 Token',
    default: 4096,
    description: '为长期记忆注入的 system 消息预留的 token 额度，截断时不会删除这些消息',
  },
  historyLimit: {
    type: 'number',
    label: '历史消息条数',
    default: 50,
    description: '从记忆中加载的最近对话历史条数',
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
  preferredModel: '',
  systemPrompt: '',
  memoryTokenBudget: 4096,
  historyLimit: 50,
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
