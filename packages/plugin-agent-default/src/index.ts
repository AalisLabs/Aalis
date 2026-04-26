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
  MessageArchiveService,
  MemoryService,
  PersonaService,
  PersonaSessionOptions,
  SessionManagerService,
  SessionConfig,
} from '@aalis/core';
import type { Logger } from '@aalis/core';
import { getSenderLabel, prefixSender, getMessageName } from '@aalis/core';

/**
 * 将时间戳格式化为可读的时间标签。
 * 距当前时间较近时使用 HH:mm，跨天时加上日期。
 */
function formatTimeLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const today = new Date(now);
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  const hhmm = `${hours}:${mins}`;

  // 同一天：今天 HH:mm
  if (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  ) {
    return `今天 ${hhmm}`;
  }
  // 跨年：加上年/月/日
  if (d.getFullYear() !== today.getFullYear()) {
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
  }
  // 跨天同年：月/日
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

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
  private maxToolIterations: number;
  /** 单条工具结果占上下文窗口的最大比例 (0~1)，超出则截断 */
  private toolResultMaxRatio: number;
  /** token 使用率超过此比例时自动触发压缩 (0~1) */
  private autoCompressThreshold: number;
  /** 用户指定的对话模型（空字符串 = 使用默认提供者的默认模型） */
  private preferredModel: string;

  /**
   * 活跃 AbortController 表
   *
   * key = `${sessionId}::${source}` — 同一 session 不同来源（user / scheduler）
   * 独立管理，互不打断；同来源新消息会中止旧的生成。
   */
  private activeControllers = new Map<string, AbortController>();

  /** 同一 lane 的入站消息归档串行化，避免连续消息读取历史时漏掉前一条输入。 */
  private archiveQueues = new Map<string, Promise<void>>();

  /** 已注册的预处理器（name → { priority, dispose }） */
  private preprocessors = new Map<string, { priority: number; dispose: () => void }>();

  constructor(ctx: Context, config: Record<string, unknown>) {
    this.ctx = ctx;
    this.logger = ctx.logger.child('agent');
    this.systemPrompt = (config.systemPrompt as string) || '';
    this.memoryTokenBudget = (config.memoryTokenBudget as number) ?? 4096;
    this.historyLimit = (config.historyLimit as number) ?? 50;
    this.maxToolIterations = (config.maxToolIterations as number) ?? 30;
    this.toolResultMaxRatio = (config.toolResultMaxRatio as number) ?? 0.15;
    this.autoCompressThreshold = (config.autoCompressThreshold as number) ?? 0.85;
    this.preferredModel = (config.preferredModel as string) || '';
    this.logger.info('默认对话代理已初始化');
  }

  /**
   * 根据优先级链获取 LLM 服务和模型覆盖
   *
   * 优先级（从高到低）：
   * 1. session-manager resolveConfig (= 会话 config > 父 sessionDefaults > 平台 profile)
   * 2. 全局 preferredModel
   * 3. 默认 LLM 提供者的默认模型
   */
  private async resolveLLM(platform?: string, sessionId?: string): Promise<{ llm: LLMService; modelOverride?: string } | undefined> {
    let model: string | undefined;
    let llmProviderOverride: string | undefined;

    // 1. session-manager resolveConfig: 会话 > 父 sessionDefaults > 平台 profile
    const sm = this.ctx.getService<SessionManagerService>('session-manager');
    if (sm && sessionId) {
      const resolved = sm.resolveConfig(sessionId, platform);
      if (resolved.model) model = resolved.model;
      if (resolved.llmProvider) llmProviderOverride = resolved.llmProvider;
    }

    // 2. 全局 preferredModel
    if (!model) {
      model = this.preferredModel;
    }

    // 如果指定了 llmProvider（contextId），直接查找该提供者
    if (llmProviderOverride) {
      const allProviders = this.ctx.getAllServices<LLMService>('llm');
      const found = allProviders.find(p => p.contextId === llmProviderOverride);
      if (found) return { llm: found.instance, modelOverride: model };
    }

    // 无指定模型：使用默认提供者
    if (!model) {
      const llm = this.ctx.getService<LLMService>('llm');
      return llm ? { llm } : undefined;
    }

    // 有指定模型：通过 core 工具方法查找拥有该模型的提供者
    const resolved = await this.ctx.resolveModelProvider(model);
    if (resolved) return { llm: resolved.instance as LLMService, modelOverride: model };

    // 模型未匹配：回退到默认提供者，传递 model override
    this.logger.warn(`未找到模型 "${model}" 对应的提供者，回退到默认提供者`);
    const llm = this.ctx.getService<LLMService>('llm');
    return llm ? { llm, modelOverride: model } : undefined;
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

    // 尝试解析结构化输出（用于 debug 日志美化展示，不影响行为）
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
      await this._handleMessageInner(incoming, controller.signal, lane);
    } finally {
      // 仅清理自己创建的 controller（避免清掉后续新请求的）
      if (this.activeControllers.get(lane) === controller) {
        this.activeControllers.delete(lane);
      }
    }
  }

  private async _handleMessageInner(incoming: IncomingMessage, signal: AbortSignal, lane: string): Promise<void> {
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

      const archivedIncoming = await this.archiveIncomingMessageInOrder(lane, incoming);


      const resolved = await this.resolveLLM(incoming.platform, incoming.sessionId);
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
      const maxToolIterations = this.maxToolIterations;
      const contextLength = llm.getContextLength();
      // 预留 token 预算 = 上下文长度 - 最大输出 token - 安全余量
      const tokenBudget = Math.max(1024, contextLength - maxTokens - 512);

      try {
        // 统一解析 session 配置（一次解析，多处复用）
        const sessionMgr = this.ctx.getService<SessionManagerService>('session-manager');
        const resolved = (sessionMgr && incoming.sessionId)
          ? sessionMgr.resolveConfig(incoming.sessionId, incoming.platform)
          : undefined;

        // 构建 persona 会话选项（从 resolved config 中提取，传给 persona 服务）
        const personaOpts: PersonaSessionOptions | undefined = resolved
          ? {
              persona: resolved.persona,
              disableOutputFormat: resolved.disableOutputFormat,
              clientSideJsonRendering: resolved.clientSideJsonRendering,
            }
          : undefined;

        const messages = await this.buildMessages(incoming, personaOpts, archivedIncoming);
        // 通过 resolved config 获取工具分组
        let enabledGroups: string[] | undefined;
        if (resolved?.enabledToolGroups && resolved.enabledToolGroups.length > 0) {
          enabledGroups = resolved.enabledToolGroups;
        }
        this.logger.debug(`工具分组: platform=${incoming.platform}, enabledGroups=${enabledGroups ? JSON.stringify(enabledGroups) : '(无)'}`);
        const tools = this.ctx.tools?.getDefinitions(
          enabledGroups ? { groups: enabledGroups } : undefined,
        ) ?? [];
        const toolCtx: ToolCallContext = {
          sessionId: incoming.sessionId,
          userId: incoming.userId,
          platform: incoming.platform,
          enabledGroups,
        };

        // 保存原始完整工具列表，后续迭代均以此为基础（避免被 hooks 修改后丢失）
        const originalTools = [...tools];

        // Hook: llm-call:before — 插件可以修改消息或工具列表
        const llmBeforeData = { messages, tools, sessionId: incoming.sessionId, userId: incoming.userId, platform: incoming.platform };
        await this.ctx.hooks.run('llm-call:before', llmBeforeData);

        // 裁剪消息以确保不超过上下文窗口
        llmBeforeData.messages = this.trimMessages(llmBeforeData.messages, tokenBudget);

        // 推送 token 使用量统计
        this.emitTokenUsage(incoming.sessionId, incoming.platform, llmBeforeData.messages, llmBeforeData.tools, contextLength, maxTokens, tokenBudget);

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

        const assistantMetadata = this.buildAssistantMetadata(incoming);

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
            metadata: assistantMetadata,
          });

          const assistantToolMessage: Message = {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
            reasoningContent: response.reasoningContent,
            metadata: assistantMetadata,
          };
          const toolMessages: Message[] = [];

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

            // 工具结果截断：按上下文窗口比例限制单条工具结果长度
            const toolResultMaxChars = Math.floor(contextLength * this.toolResultMaxRatio * 3.5);
            if (result.length > toolResultMaxChars) {
              this.logger.info(`工具结果过长 (${result.length} 字符)，截断至 ${toolResultMaxChars} 字符: ${toolBeforeData.name}`);
              result = result.slice(0, toolResultMaxChars) + `\n... [工具输出已截断，原始长度 ${result.length} 字符]`;
            }

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

            const toolMessage: Message = {
              role: 'tool',
              content: result,
              toolCallId: toolCall.id,
            };
            llmBeforeData.messages.push(toolMessage);
            toolMessages.push(toolMessage);
          }

          await this.saveToolCallGroup(incoming.sessionId, assistantToolMessage, toolMessages);

          // 继续请求 LLM (再次经过 hooks)，使用原始完整工具列表而非被上一轮 hooks 修改过的列表
          const nextLlmData = { messages: llmBeforeData.messages, tools: [...originalTools], sessionId: incoming.sessionId, userId: incoming.userId, platform: incoming.platform };
          await this.ctx.hooks.run('llm-call:before', nextLlmData);

          // 裁剪消息以确保不超过上下文窗口
          nextLlmData.messages = this.trimMessages(nextLlmData.messages, tokenBudget);

          // 推送 token 使用量统计
          this.emitTokenUsage(incoming.sessionId, incoming.platform, nextLlmData.messages, nextLlmData.tools, contextLength, maxTokens, tokenBudget);

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

        // 检测是否因工具调用次数达到上限而退出循环
        const toolLimitReached = iterations >= maxToolIterations
          && response.toolCalls != null
          && response.toolCalls.length > 0;
        if (toolLimitReached) {
          this.logger.warn(`工具调用达到上限 (${maxToolIterations})，session=${incoming.sessionId}`);
        }

        let replyContent = response.content ?? '';

        // Hook: response:before — 插件可以修改最终回复
        // JSON 解析/修复统一由 persona 的 response:before 钩子处理
        const responseData = { content: replyContent, sessionId: incoming.sessionId };
        await this.ctx.hooks.run('response:before', responseData);
        replyContent = responseData.content;

        // 重复检测：如果回复与最近一条 assistant 消息完全相同，视为模型"卡壳"，静默跳过
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        if (replyContent && lastAssistant?.content && replyContent === lastAssistant.content) {
          this.logger.warn(`检测到重复回复，跳过发送 (session=${incoming.sessionId})`);
          replyContent = '';
        }

        // 发出流结束标记
        await this.ctx.emit('message:stream', {
          sessionId: incoming.sessionId,
          platform: incoming.platform,
          done: true,
          toolLimitReached,
        });

        // 空回复（outputFormat 中 reply 字段为空字符串或仅空白）时静默，不发送消息
        if (replyContent.trim().length === 0) {
          this.logger.debug(`空回复，跳过发送 (session=${incoming.sessionId})`);
        } else {
          const combinedReasoning = allReasoning.length > 0
            ? allReasoning.join('\n\n---\n\n')
            : undefined;

          // 保存最终 assistant 回复：只存最后一次 LLM 调用的 reasoning（中间消息已各自保存了自己的 reasoning）
          await this.saveToMemory(incoming.sessionId, {
            role: 'assistant',
            content: replyContent,
            reasoningContent: response.reasoningContent,
            timestamp: Date.now(),
            metadata: assistantMetadata,
          });

          // 发送给流式客户端时使用合并版本（客户端流式阶段已自行维护 reasoningSegments）
          await this.ctx.emit('message:send', {
            content: replyContent,
            sessionId: incoming.sessionId,
            platform: incoming.platform,
            reasoningContent: combinedReasoning,
            source: 'agent',
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

    // 消息被拦截（如流控缓冲），通知前端结束 loading
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
  private async buildMessages(incoming: IncomingMessage, personaOpts?: PersonaSessionOptions, archivedIncoming?: Message): Promise<Message[]> {
    const messages: Message[] = [];

    // 1. 系统提示
    const systemPrompt = this.buildSystemPrompt(personaOpts);
    messages.push({ role: 'system', content: systemPrompt, metadata: { source: 'persona' } });

    // 2. 历史消息
    const memory = this.ctx.getService<MemoryService>('memory');
    if (memory) {
      try {
        const history = this.sanitizeToolCallHistory(
          await memory.getHistory(incoming.sessionId, this.historyLimit),
          incoming.sessionId,
        );
        const now = Date.now();
        for (const m of history) {
          if (archivedIncoming && this.isSameMessage(m, archivedIncoming)) continue;
          if (m.role === 'system' && m.name === 'system-event') continue;
          // 为用户消息注入时间标注，帮助 LLM 理解时间先后
          if (m.role === 'user' && m.timestamp && m.content) {
            const timeLabel = formatTimeLabel(m.timestamp, now);
            if (timeLabel && !m.content.startsWith(`(${timeLabel})`)) {
              m.content = `(${timeLabel}) ${m.content}`;
            }
          }
          messages.push(m);
        }
      } catch (err) {
        this.logger.warn('获取历史消息失败:', err);
      }
    }

    // 3. 当前用户消息（带发送者前缀，与历史消息格式一致）
    const senderLabel = getSenderLabel(incoming.nickname, incoming.userId);
    const nowLabel = formatTimeLabel(Date.now(), Date.now());
    let currentContent = senderLabel
      ? `(${nowLabel}) [${senderLabel}]: ${incoming.content}`
      : `(${nowLabel}) ${incoming.content}`;

    // 附加引用回复上下文
    if (incoming.replyTo?.content) {
      const replyLabel = getSenderLabel(incoming.replyTo.nickname, incoming.replyTo.userId) ?? '?';
      currentContent += `\n[引用 ${replyLabel} 的消息: ${incoming.replyTo.content}]`;
    }

    // 根据 attachmentOrder 按上传顺序组装附件描述
    if (incoming.attachmentOrder && (incoming._fileDescriptions || incoming._imageDescriptions)) {
      const fileDescs = incoming._fileDescriptions ?? [];
      const imageDescs = incoming._imageDescriptions ?? [];
      let fi = 0, ii = 0;
      const ordered: string[] = [];
      for (const type of incoming.attachmentOrder) {
        if (type === 'file' && fi < fileDescs.length) {
          ordered.push(fileDescs[fi++]);
        } else if (type === 'image' && ii < imageDescs.length) {
          ordered.push(imageDescs[ii++]);
        }
      }
      // 追加剩余未匹配的描述
      while (fi < fileDescs.length) ordered.push(fileDescs[fi++]);
      while (ii < imageDescs.length) ordered.push(imageDescs[ii++]);
      if (ordered.length > 0) {
        const attachText = ordered.join('\n');
        currentContent = currentContent
          ? `${currentContent}\n${attachText}`
          : attachText;
      }
    }

    // 检测预处理附件内容——引导 LLM 综合分析而非逐项转述
    const hasPreprocessed = /\[图片\d*[:：]|\[文件[:：]|--- 文件内容 ---/.test(currentContent);
    if (hasPreprocessed) {
      messages.push({
        role: 'system',
        content: '用户消息中包含系统预处理的附件描述（图片识别结果和/或文件内容提取）。'
          + '请将这些信息作为参考上下文，结合用户的文字，给出一个自然、连贯的统一回复。'
          + '不要将分析结果逐项列出或分成单独的字段，直接在回复中融合所有信息。',
        metadata: { source: 'system-other' },
      });
    }

    const userMessage: Message = {
      role: 'user',
      content: currentContent,
      name: getMessageName(incoming.userId),
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
  private buildSystemPrompt(personaOpts?: PersonaSessionOptions): string {
    const persona = this.ctx.getService<PersonaService>('persona');
    if (persona) {
      const personaPrompt = persona.getSystemPrompt(personaOpts);
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
   * 估算文本的 token 数（区分中文与 ASCII）
   *
   * 对于大多数 BPE tokenizer（GPT/DeepSeek/Qwen 等）：
   * - ASCII 字符约 3-4 字符 = 1 token
   * - 中文/日文/韩文字符约 1-2 字符 = 1 token
   * 这里采用保守估算以避免超限。
   */
  private estimateTextTokens(text: string): number {
    let tokens = 0;
    // eslint-disable-next-line no-control-regex
    const cjkRegex = /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
    let i = 0;
    while (i < text.length) {
      if (cjkRegex.test(text[i])) {
        // CJK 字符：~1.5 token/字符（保守取高）
        tokens += 1.5;
        i++;
      } else {
        // ASCII 序列：~1 token / 3.5 字符
        let asciiLen = 0;
        while (i < text.length && !cjkRegex.test(text[i])) { asciiLen++; i++; }
        tokens += Math.ceil(asciiLen / 3.5);
      }
    }
    return Math.ceil(tokens);
  }

  /**
   * 估算单条消息的 token 数
   */
  private estimateMsgTokens(msg: Message): number {
    let t = 4;
    if (msg.content) t += this.estimateTextTokens(msg.content);
    if (msg.toolCalls) t += this.estimateTextTokens(JSON.stringify(msg.toolCalls));
    if (msg.reasoningContent) t += this.estimateTextTokens(msg.reasoningContent);
    return t;
  }

  /**
   * 推送 token 使用量统计事件
   *
   * 包含各维度的 token 使用分解，供前端展示和自动压缩判断。
   */
  private emitTokenUsage(
    sessionId: string,
    platform: string,
    messages: Message[],
    tools: ToolDefinition[],
    contextLength: number,
    maxTokens: number,
    tokenBudget: number,
  ): void {
    // 按来源分类统计各消息的 token 占用
    let historyTokens = 0;
    let toolResultTokens = 0;
    let personaTokens = 0;
    let memorySummaryTokens = 0;
    let memoryVectorTokens = 0;
    let skillsTokens = 0;
    let platformTokens = 0;
    let subtaskTokens = 0;
    let systemOtherTokens = 0;

    for (const msg of messages) {
      const t = this.estimateMsgTokens(msg);
      if (msg.role === 'system') {
        const source = msg.metadata?.source as string | undefined;
        const contributions = msg.metadata?._tokenContributions as Record<string, number> | undefined;

        if (source === 'memory-summary') {
          memorySummaryTokens += t;
        } else if (source === 'memory-vector') {
          memoryVectorTokens += t;
        } else if (source === 'platform') {
          platformTokens += t;
        } else if (source === 'system-other') {
          systemOtherTokens += t;
        } else if (source === 'persona' || !source) {
          // persona 消息可能被 skills/subtask/toolPriority 追加了内容
          if (contributions) {
            let contributionTokens = 0;
            for (const [key, charCount] of Object.entries(contributions)) {
              const ct = this.estimateTextTokens('x'.repeat(charCount as number));
              if (key === 'skills') skillsTokens += ct;
              else if (key === 'subtask') subtaskTokens += ct;
              else systemOtherTokens += ct;
              contributionTokens += ct;
            }
            personaTokens += Math.max(0, t - contributionTokens);
          } else {
            personaTokens += t;
          }
        } else {
          systemOtherTokens += t;
        }
      } else if (msg.role === 'tool') {
        toolResultTokens += t;
      } else {
        historyTokens += t;
      }
    }

    // 工具定义的 token 估算
    const toolDefsTokens = tools.length > 0
      ? this.estimateTextTokens(JSON.stringify(tools))
      : 0;

    const systemTokens = personaTokens + memorySummaryTokens + memoryVectorTokens
      + skillsTokens + platformTokens + subtaskTokens + systemOtherTokens;
    const totalUsed = systemTokens + historyTokens + toolResultTokens + toolDefsTokens;
    const usageRatio = contextLength > 0 ? totalUsed / contextLength : 0;

    this.ctx.emit('token:usage', {
      sessionId,
      platform,
      contextWindow: contextLength,
      maxTokens,
      tokenBudget,
      used: totalUsed,
      usageRatio,
      breakdown: {
        system: systemTokens,
        persona: personaTokens,
        memorySummary: memorySummaryTokens,
        memoryVector: memoryVectorTokens,
        skills: skillsTokens,
        platform: platformTokens,
        subtask: subtaskTokens,
        systemOther: systemOtherTokens,
        history: historyTokens,
        toolResults: toolResultTokens,
        toolDefs: toolDefsTokens,
        reservedForReply: maxTokens,
      },
    }).catch(() => {});

    // 自动压缩触发：当 token 使用率超过阈值时
    if (usageRatio >= this.autoCompressThreshold) {
      this.logger.info(`Token 使用率 ${(usageRatio * 100).toFixed(1)}% 超过阈值 ${(this.autoCompressThreshold * 100).toFixed(0)}%，触发自动压缩`);
      this.ctx.emit('session:compress', { sessionId, reason: 'auto', usageRatio }).catch(() => {});
    }
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

    // === Phase 2.5: 缩减 assistant 消息的 reasoningContent ===
    // 深度思考模型的推理内容可能非常长（数万 token），优先缩减旧迭代的推理，
    // 仍超预算时缩减最新一条（保留头尾摘要以保持上下文连贯性）
    {
      // 收集带 reasoningContent 的 assistant 消息索引（从旧到新）
      const rcIndices: number[] = [];
      for (let i = 1; i < result.length; i++) {
        if (result[i].role === 'assistant' && result[i].reasoningContent && result[i].reasoningContent!.length > 200) {
          rcIndices.push(i);
        }
      }
      // 从最旧开始，先截断非最后一条的推理，仍不够时截断最后一条
      // 注意：DeepSeek 思考模式要求历史中凡有 reasoning_content 的消息必须原样带回，
      // 不能将字段设为 undefined，否则 API 返回 400。因此只截断，不删除。
      for (let k = 0; k < rcIndices.length && estimated > budget; k++) {
        const idx = rcIndices[k];
        const msg = result[idx];
        const oldTokens = this.estimateMsgTokens(msg);
        // 所有条目统一保留头部 200 字符（最新条保留稍多以保持上下文连贯性）
        const keepLen = k < rcIndices.length - 1 ? 200 : 400;
        msg.reasoningContent = msg.reasoningContent!.slice(0, keepLen) + '\n... [推理内容已缩减]';
        estimated -= (oldTokens - this.estimateMsgTokens(msg));
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

    // === Phase 4: 删除最旧的非 system 消息（保护最后一组工具调用 + 最新用户消息） ===
    {
      // 识别最后一组工具调用的索引范围，确保不被删除
      const lastGroupIndices = new Set<number>();
      for (let j = result.length - 1; j >= 1; j--) {
        if (result[j].role === 'assistant' && result[j].toolCalls?.length) {
          lastGroupIndices.add(j);
          let k = j + 1;
          while (k < result.length && result[k].role === 'tool') {
            lastGroupIndices.add(k);
            k++;
          }
          break;
        }
      }

      // 保护最新的 user 消息（用户发起任务的请求，删掉会导致模型丢失任务上下文）
      let lastUserIdx = -1;
      for (let j = result.length - 1; j >= 1; j--) {
        if (result[j].role === 'user') { lastUserIdx = j; break; }
      }

      const adjustAfterSplice = (splicedAt: number): void => {
        const updated = new Set<number>();
        for (const idx of lastGroupIndices) updated.add(idx > splicedAt ? idx - 1 : idx);
        lastGroupIndices.clear();
        for (const idx of updated) lastGroupIndices.add(idx);
        if (lastUserIdx > splicedAt) lastUserIdx--;
      };

      let i = 1;
      while (estimated > budget && i < result.length - 1) {
        if (result[i].role === 'system' || lastGroupIndices.has(i) || i === lastUserIdx) { i++; continue; }
        // assistant(含toolCalls) + 紧跟的 tool 消息成组删除
        if (result[i].role === 'assistant' && result[i].toolCalls?.length) {
          estimated -= this.estimateMsgTokens(result[i]);
          result.splice(i, 1);
          adjustAfterSplice(i);
          while (i < result.length - 1 && result[i].role === 'tool') {
            if (lastGroupIndices.has(i)) break;
            estimated -= this.estimateMsgTokens(result[i]);
            result.splice(i, 1);
            adjustAfterSplice(i);
          }
          continue;
        }
        estimated -= this.estimateMsgTokens(result[i]);
        result.splice(i, 1);
        adjustAfterSplice(i);
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

    // 大幅裁剪后注入继续执行提示，防止模型因上下文缺失而中止任务
    if (messages.length - result.length >= 6) {
      const hint: Message = {
        role: 'system',
        content: '[系统提示] 由于上下文长度限制，部分历史消息已被压缩或移除。请基于当前可见的上下文和最新用户请求继续完成任务，不要因为看不到之前的细节而停止工作。如果你之前有正在执行的多步骤任务或计划，请查看对话摘要和 todo-list 工具确认当前进度，然后继续未完成的步骤。',
        metadata: { source: 'system-other' },
      };
      // 插入到最后一条 user 消息之后（如果有），否则插到末尾前
      let insertIdx = result.length - 1;
      for (let j = result.length - 1; j >= 1; j--) {
        if (result[j].role === 'user') { insertIdx = j + 1; break; }
      }
      result.splice(insertIdx, 0, hint);
      estimated += this.estimateMsgTokens(hint);
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
    const archive = this.ctx.getService<MessageArchiveService>('message-archive');
    if (archive) {
      try {
        await archive.saveMessage(sessionId, message);
      } catch (err) {
        this.logger.warn('保存消息到记忆失败:', err);
      }
    }
  }

  private buildAssistantMetadata(incoming: IncomingMessage): Record<string, unknown> | undefined {
    const identity = this.ctx.getPlatformSelfIdentity(incoming.platform, incoming.sessionId);
    const metadata: Record<string, unknown> = {
      platform: incoming.platform,
      senderType: 'assistant',
    };
    if (identity?.selfId) metadata.userId = identity.selfId;
    if (identity?.nickname) metadata.nickname = identity.nickname;
    if (incoming.groupId) metadata.groupId = incoming.groupId;
    if (incoming.groupName) metadata.groupName = incoming.groupName;
    if (incoming.sessionType) metadata.sessionType = incoming.sessionType;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private async saveToolCallGroup(sessionId: string, assistantMessage: Message, toolMessages: Message[]): Promise<void> {
    const timestamp = Date.now();
    await this.saveToMemory(sessionId, { ...assistantMessage, timestamp });
    for (let i = 0; i < toolMessages.length; i++) {
      await this.saveToMemory(sessionId, { ...toolMessages[i], timestamp: timestamp + i + 1 });
    }
  }

  private sanitizeToolCallHistory(history: Message[], sessionId: string): Message[] {
    const result: Message[] = [];
    let dropped = 0;

    for (let i = 0; i < history.length; i++) {
      const message = history[i];

      if (message.role === 'tool') {
        dropped++;
        continue;
      }

      if (message.role === 'assistant' && message.toolCalls?.length) {
        const expectedIds = new Set(message.toolCalls.map(tc => tc.id));
        const seenIds = new Set<string>();
        const tools: Message[] = [];
        let j = i + 1;

        while (j < history.length && history[j].role === 'tool') {
          const toolMessage = history[j];
          const id = toolMessage.toolCallId;
          if (!id || !expectedIds.has(id) || seenIds.has(id)) break;
          tools.push(toolMessage);
          seenIds.add(id);
          j++;
        }

        if (seenIds.size === expectedIds.size) {
          result.push(message, ...tools);
        } else {
          dropped += 1 + tools.length;
        }
        i = j - 1;
        continue;
      }

      result.push(message);
    }

    if (dropped > 0) {
      this.logger.warn(`历史消息中发现不完整工具调用组，已跳过 ${dropped} 条 (session=${sessionId})`);
    }
    return result;
  }

  private isSameMessage(a: Message, b: Message): boolean {
    return a.role === b.role
      && (a.timestamp ?? 0) === (b.timestamp ?? 0)
      && (a.name ?? '') === (b.name ?? '')
      && (a.content ?? '') === (b.content ?? '');
  }

  private async archiveIncomingMessageInOrder(lane: string, incoming: IncomingMessage): Promise<Message | undefined> {
    const previous = this.archiveQueues.get(lane) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.archiveIncomingMessage(incoming));
    const tail = current.then(() => undefined, () => undefined);
    this.archiveQueues.set(lane, tail);

    try {
      return await current;
    } finally {
      if (this.archiveQueues.get(lane) === tail) {
        this.archiveQueues.delete(lane);
      }
    }
  }

  private async archiveIncomingMessage(incoming: IncomingMessage): Promise<Message | undefined> {
    // 跳过非真实用户输入：闲聊主动触发是系统提示，不应作为 user 消息写入历史
    if (incoming.source === 'idle-trigger') return undefined;
    const archive = this.ctx.getService<MessageArchiveService>('message-archive');
    if (!archive) return undefined;
    try {
      const result = await archive.archiveIncoming(incoming);
      return result.message;
    } catch (err) {
      this.logger.warn('归档用户消息失败:', err);
      return undefined;
    }
  }
}

// ----- 插件导出 -----

export const name = '@aalis/plugin-agent-default';
export const displayName = '默认 Agent';

export const provides = ['agent'];

export const inject = {
  optional: ['llm', 'memory', 'persona', 'message-archive'],
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
  maxToolIterations: {
    type: 'number',
    label: '最大工具迭代',
    default: 30,
    description: '工具调用循环的最大迭代次数',
  },
  toolResultMaxRatio: {
    type: 'number',
    label: '工具结果最大比例',
    default: 0.15,
    description: '单条工具结果占上下文窗口的最大比例 (0~1)，超出则截断。例如 0.15 表示 15%',
  },
  autoCompressThreshold: {
    type: 'number',
    label: '自动压缩阈值',
    default: 0.85,
    description: 'Token 使用率超过此比例 (0~1) 时自动触发对话压缩。例如 0.85 表示 85%',
  },
};

export const defaultConfig = {
  preferredModel: '',
  systemPrompt: '',
  memoryTokenBudget: 4096,
  historyLimit: 50,
  maxToolIterations: 30,
  toolResultMaxRatio: 0.15,
  autoCompressThreshold: 0.85,
};

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const agent = new DefaultAgent(ctx, config);
  ctx.provide('agent', agent);

  // ===== /model 指令 =====
  ctx.command('model', '查看或切换当前会话的对话模型', async (cmdCtx) => {
    const target = cmdCtx.args[0];
    const smSvc = ctx.getService<SessionManagerService>('session-manager');

    // 无参数 或 /model info：显示当前模型和来源
    if (!target || target === 'info') {
      const globalModel = agent['preferredModel'];
      // 从 session-manager resolveConfig 获取最终生效模型（已包含会话级覆盖）
      const resolvedModel = smSvc ? smSvc.resolveConfig(cmdCtx.sessionId, cmdCtx.platform).model : undefined;
      // 检查是否为会话级覆盖（区分来源）
      const sessionModel = smSvc?.getSession(cmdCtx.sessionId)?.config?.model;
      const current = resolvedModel || globalModel || '(默认)';
      const lines = [`**当前模型**: ${current}`];
      if (sessionModel) lines.push(`  _(会话覆盖, /model reset 可清除)_`);
      else if (resolvedModel) lines.push(`  _(平台/继承配置)_`);
      else if (globalModel) lines.push(`  _(全局配置)_`);

      // 仅 /model（无参数）时列出可用模型
      if (!target) {
        const allProviders = ctx.getAllServices<LLMService>('llm');
        const models: string[] = [];
        for (const p of allProviders) {
          if (typeof p.instance.listModels === 'function') {
            try {
              const list = await p.instance.listModels();
              for (const m of list) models.push(m.id);
            } catch { /* ignore */ }
          }
        }
        if (models.length > 0) {
          lines.push('', '**可用模型**:');
          for (const m of models) lines.push(`- ${m}`);
        }
      }
      return lines.join('\n');
    }

    // /model reset — 清除会话级模型覆盖
    if (target === 'reset') {
      if (!smSvc) return 'session-manager 服务不可用';
      const session = smSvc.getSession(cmdCtx.sessionId);
      if (session?.config?.model) {
        const { model: _, ...rest } = session.config;
        await smSvc.updateSession(cmdCtx.sessionId, { config: { ...rest, model: undefined } as SessionConfig });
      }
      const fallback = agent['preferredModel'] || '(默认)';
      return `已清除会话模型覆盖，回退到: ${fallback}`;
    }

    // /model set <name> — 设置会话级模型覆盖（持久化到 SessionConfig）
    if (target === 'set') {
      const modelName = cmdCtx.args[1];
      if (!modelName) return '用法: /model set <模型名称>';
      if (!smSvc) return 'session-manager 服务不可用';
      await smSvc.updateSession(cmdCtx.sessionId, { config: { model: modelName } as SessionConfig });
      return `当前会话模型已切换为: ${modelName}（已持久化）`;
    }

    return `未知子命令: ${target}。可用: info / set <模型名> / reset`;
  });

  // 监听 token:request 事件 — 客户端刷新/重连时主动请求 token 用量
  ctx.on('token:request', async (...args: unknown[]) => {
    const data = args[0] as { sessionId: string; platform?: string };
    if (!data?.sessionId) return;

    try {
      const resolved = await agent['resolveLLM'](data.platform, data.sessionId);
      if (!resolved) return;
      const { llm } = resolved;

      const contextLength = llm.getContextLength();
      const maxTokens = llm.getMaxTokens();
      const tokenBudget = Math.max(1024, contextLength - maxTokens - 512);

      // 获取历史消息并构建基础消息列表
      const memory = ctx.getService<MemoryService>('memory');
      const messages: Message[] = [];

      // 系统提示
      const systemPrompt = agent['buildSystemPrompt']();
      messages.push({ role: 'system', content: systemPrompt, metadata: { source: 'persona' } });

      // 历史消息
      if (memory) {
        const history = await memory.getHistory(data.sessionId, agent['historyLimit']);
        messages.push(...history.filter(m => !(m.role === 'system' && m.name === 'system-event')));
      }

      // 运行 llm-call:before 中间件以获取注入的 system 消息（摘要、向量记忆等）+ 工具搜索层过滤
      const sm = ctx.getService<SessionManagerService>('session-manager');
      const sessionResolved = sm ? sm.resolveConfig(data.sessionId, data.platform) : undefined;
      const enabledGroups = sessionResolved?.enabledToolGroups?.length ? sessionResolved.enabledToolGroups : undefined;
      const tools = ctx.tools?.getDefinitions(enabledGroups ? { groups: enabledGroups } : undefined) ?? [];

      const llmBeforeData = { messages, tools, sessionId: data.sessionId, userId: '', platform: data.platform ?? '' };
      await ctx.hooks.run('llm-call:before', llmBeforeData);

      agent['emitTokenUsage'](data.sessionId, data.platform ?? '', llmBeforeData.messages, llmBeforeData.tools, contextLength, maxTokens, tokenBudget);
    } catch (err) {
      ctx.logger.debug('token:request 处理失败:', err);
    }
  });
}
