import type { ConfigSchema, Context, Logger, PluginManagerService } from '@aalis/core';
import type { AgentService, PluginGroupInfo, PreprocessorFn, PreprocessorInfo } from '@aalis/plugin-agent-api';
import { useCommandService } from '@aalis/plugin-commands-api';
import type { GatewayService } from '@aalis/plugin-gateway-api';
import type { ChatModelRequest, ChatResponse, LLMModel, LLMModelEntry } from '@aalis/plugin-llm-api';
import { resolveLLMModel } from '@aalis/plugin-llm-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { ContentSegment, IncomingMessage, Message, OutgoingMessage, ToolCall } from '@aalis/plugin-message-api';
import { CONTROL_KINDS, getMessageName, getSenderLabel, WellKnownKinds } from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';
import type { PersonaService, PersonaSessionOptions } from '@aalis/plugin-persona-api';
import { getPlatformSelfIdentity } from '@aalis/plugin-platform-api';
import type { SessionConfig, SessionManagerService } from '@aalis/plugin-session-manager-api';
import type { ToolCallContext, ToolDefinition, ToolService } from '@aalis/plugin-tools-api';
import '@aalis/plugin-commands-api';
import { normalizeAssistantContent, stripLeakedSpecialTokens } from '@aalis/util-text-normalize';
import {
  buildFocusGuidance,
  estimateMsgTokens,
  estimateTextTokens,
  estimateTokens,
  formatTimeLabel,
  INPUT_CONVENTIONS,
  isSameMessage,
} from './helpers.js';

/**
 * 默认 Agent 实现 —— 对话编排器
 *
 * 负责:
 * 1. 组装系统提示 (persona + base)
 * 2. 加载历史消息 (memory)
 * 3. 收集可用工具 (tools registry)
 * 4. 调用 LLM 服务
 * 5. 执行工具调用循环
 * 6. 发出 outbound:message 事件
 *
 * 外部插件可以注册高优先级的 AgentService 来完全替换此默认实现。
 */

/** 统一读取 LLM 单次最大输出 token；缺省回退 4096（与各 adapter 默认一致）。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
function getModelMaxOutput(llm: Pick<LLMModel, 'maxOutputTokens'>): number {
  return llm.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

class DefaultAgent implements AgentService {
  private ctx: Context;
  private logger: Logger;
  private systemPrompt: string;
  private memoryTokenBudget: number;
  private historyLimit: number;
  private maxToolIterations: number;
  /** 单条工具结果占上下文窗口的最大比例 (0~1)，超出则截断 */
  private toolResultMaxRatio: number;
  /** 内存裁剪触发比例 (0~1)：估算输入 token 占 contextLength 的比例上限，超过则触发本次调用的内存裁剪 */
  private trimThresholdRatio: number;

  /**
   * 活跃 AbortController 表
   *
   * key = `${sessionId}::${source}` — 同一 session 不同来源（user / scheduler）
   * 独立管理，互不打断；同来源新消息会中止旧的生成。
   */
  private activeControllers = new Map<string, AbortController>();

  /** 同一 lane 的入站消息归档串行化，避免连续消息读取历史时漏掉前一条输入。 */
  private archiveQueues = new Map<string, Promise<void>>();

  /**
   * 节流日志状态：记录每个 session 上次 token:usage 日志的"轮次"与 ratio 桶。
   * - 跨过 0.5/0.7/0.85 三个阈值必输出
   * - 否则每 10 轮（计数器）输出一次
   * 与 token:usage 事件共用同一份 breakdown 数据，零额外计算。
   */
  private tokenLogState = new Map<string, { count: number; lastRatioBucket: number }>();

  /** 已注册的预处理器（name → { priority, dispose }） */
  private preprocessors = new Map<string, { dispose: () => void }>();

  constructor(ctx: Context, config: Record<string, unknown>) {
    this.ctx = ctx;
    this.logger = ctx.logger.child('agent');
    this.systemPrompt = (config.systemPrompt as string) || '';
    this.memoryTokenBudget = (config.memoryTokenBudget as number) ?? 4096;
    this.historyLimit = (config.historyLimit as number) ?? 50;
    this.maxToolIterations = (config.maxToolIterations as number) ?? 30;
    this.toolResultMaxRatio = (config.toolResultMaxRatio as number) ?? 0.15;
    this.trimThresholdRatio = (config.trimThresholdRatio as number) ?? 1.0;
    this.logger.info('默认对话代理已初始化');
  }

  /**
   * 根据优先级链解析当前会话该用哪个 LLMModel entry。
   *
   * 全部交给 session-manager.resolveConfig。优先级（从高到低）：
   * 1. 会话 config
   * 2. 父会话 sessionDefaults
   * 3. 平台 profile
   * 4. ServicePreference（由 agent 启动时锁定的全局默认 entry，未传 ref 时生效）
   *
   * 返回 LLMModelEntry（含 instance / contextId / capabilities），entry 已绑定具体 model。
   */
  private async resolveLLM(platform?: string, sessionId?: string): Promise<LLMModelEntry | undefined> {
    let ref: { provider?: string; model?: string } | undefined;

    // session-manager 一步到位：会话 > 父 sessionDefaults > platform profile
    const sm = this.ctx.getService<SessionManagerService>('session-manager');
    if (sm && sessionId) {
      const resolved = sm.resolveConfig(sessionId, platform);
      if (resolved.llm?.provider && resolved.llm?.model) ref = resolved.llm;
    }

    // 解析为具体 LLMModel entry（要求至少 chat 能力；ref 为空时走 ServicePreference / 优先级）
    return resolveLLMModel(this.ctx, ref, ['chat']);
  }

  /** 生成 lane key：同 session + 同 source 共用一个 lane */ private laneKey(
    sessionId: string,
    source?: string,
  ): string {
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
  /**
   * 注册输入预处理器（如图片识别、文件读取、用户画像等）。
   * 多个预处理器按注册顺序串行执行（Koa-style 洋葱模型）。
   *
   * 底层通过 agent:input:before 中间件实现。
   * 同名注册会自动替换旧的预处理器。
   */
  registerPreprocessor(name: string, handler: PreprocessorFn): () => void {
    // 同名替换
    const existing = this.preprocessors.get(name);
    if (existing) existing.dispose();

    const dispose = this.ctx.middleware('agent:input:before', async (data, next) => {
      await handler(data.message, next);
    });

    const cleanup = () => {
      dispose();
      this.preprocessors.delete(name);
      this.logger.info(`预处理器已注销: ${name}`);
    };

    this.preprocessors.set(name, { dispose: cleanup });
    this.logger.info(`预处理器已注册: ${name}`);
    return cleanup;
  }

  /**
  /**
   * 获取当前所有已注册预处理器的元信息（按注册顺序返回）
   */
  getPreprocessors(): PreprocessorInfo[] {
    return [...this.preprocessors.keys()].map(name => ({ name }));
  }

  /**
   * 获取 Agent 子系统的插件分组
   *
   * 仅纳入 Agent 直接依赖的能力提供者；不包含 `platform`
   * （平台属于独立子系统，由 plugin-platform-api 的 helper 负责）。
   */
  getPluginGroups(): PluginGroupInfo[] {
    const pm = this.ctx.getService<PluginManagerService>('plugins');
    if (!pm) return [];

    // 子系统归属：Agent 域的服务（不含 platform——平台是独立子系统）
    const targetServices = new Set(['llm', 'memory', 'persona', 'message-archive']);
    const grouped: string[] = [];

    for (const p of pm.getStatus()) {
      if (p.provides?.some(s => targetServices.has(s))) {
        grouped.push(p.instanceId);
      }
    }

    return [{ label: 'Agent', plugins: grouped }];
  }

  /**
   * 消费流式 LLM 调用，累积完整响应，同时向前端推送增量事件。
   *
   * 同时构建本轮调用的 segments 时间线（按 chunk 到达顺序记录 text / reasoning_text，
   * 相邻同类合并）——用于上层将多轮调用 + 工具执行交错拼接成统一时间线。
   */
  private async consumeStream(
    llm: LLMModel,
    request: ChatModelRequest,
    sessionId: string,
    platform: string,
    signal?: AbortSignal,
  ): Promise<ChatResponse & { segments: ContentSegment[] }> {
    let content = '';
    let reasoningContent = '';
    let toolCalls: ToolCall[] | undefined;
    let usage: ChatResponse['usage'] | undefined;
    const segments: ContentSegment[] = [];
    const appendDelta = (kind: 'text' | 'reasoning_text', delta: string) => {
      const last = segments[segments.length - 1];
      if (last && last.type === kind) {
        segments[segments.length - 1] = { type: kind, content: last.content + delta };
      } else {
        segments.push({ type: kind, content: delta });
      }
    };

    for await (const chunk of llm.chatStream!(request)) {
      // 检查中止信号
      if (signal?.aborted) {
        throw new DOMException('Generation aborted', 'AbortError');
      }
      if (chunk.contentDelta) {
        content += chunk.contentDelta;
        appendDelta('text', chunk.contentDelta);
        await this.ctx.emit('outbound:stream', {
          sessionId,
          platform,
          contentDelta: chunk.contentDelta,
        });
      }
      if (chunk.reasoningDelta) {
        reasoningContent += chunk.reasoningDelta;
        appendDelta('reasoning_text', chunk.reasoningDelta);
        await this.ctx.emit('outbound:stream', {
          sessionId,
          platform,
          reasoningDelta: chunk.reasoningDelta,
        });
      }
      if (chunk.toolCallProgress) {
        await this.ctx.emit('outbound:stream', {
          sessionId,
          platform,
          toolCallProgress: chunk.toolCallProgress,
        });
      }
      if (chunk.done) {
        toolCalls = chunk.toolCalls;
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    let finalContent = content;
    if (content) {
      // 兜底剥离 LLM 端漏出的特殊 token 残渣（DSML 等），同时修复 GFM 表格
      const { sanitized, hadLeak } = stripLeakedSpecialTokens(content);
      if (hadLeak) {
        this.ctx.logger.warn(
          `agent: 检测到 LLM 内容残留 DSML 标记，已剥离（session=${sessionId} platform=${platform} 原长=${content.length} 净化后=${sanitized.length}）`,
        );
      }
      finalContent = normalizeAssistantContent(content);
    }
    return {
      content: finalContent,
      reasoningContent: reasoningContent || undefined,
      toolCalls,
      usage,
      segments,
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
      const jsonStr = raw.startsWith('{') ? raw : raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      try {
        const obj = JSON.parse(jsonStr);
        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
          parsedFormat = obj;
        }
      } catch {
        /* 非 JSON，正常文本 */
      }
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
      } catch {
        /* ignore */
      }
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
    // Hook: agent:input:before — 插件可以修改或拦截消息
    // 中间件不调用 next() 即可中断整个流程（包括 LLM 调用）
    const msgHookData: { message: IncomingMessage; metadata: Record<string, unknown> } = {
      message: incoming,
      metadata: {},
    };

    let handled = false;

    await this.ctx.hooks.run('agent:input:before', msgHookData, async () => {
      handled = true;
      // ===== defaultAction: 全部消息处理逻辑在此 =====
      // 中间件不调用 next() → 此处永远不执行 → 消息被拦截
      incoming = msgHookData.message;

      const archivedIncoming = await this.archiveIncomingMessageInOrder(lane, incoming);

      const resolved = await this.resolveLLM(incoming.platform, incoming.sessionId);
      if (!resolved) {
        this.logger.warn('LLM 服务不可用，无法处理消息');
        await this.dispatchOutbound({
          content: '[系统] LLM 服务不可用，请检查配置。',
          sessionId: incoming.sessionId,
          platform: incoming.platform,
          source: 'system',
        });
        return;
      }
      const llm = resolved.instance;

      // 从 LLM model entry 读取参数。contextLength / maxOutputTokens 均为 per-model 属性，
      // service-granularity 后不再需要 router.getContextLengthFor() 反查，也不再会出现
      // 默认 provider 全局窗口与会话实际 model 不一致的偏差（Bug F 结构性修复）。
      const maxTokens = getModelMaxOutput(llm);
      const maxToolIterations = this.maxToolIterations;
      const contextLength = llm.contextLength;
      // 预留 token 预算 = 上下文长度 × trimThresholdRatio - 最大输出 token - 安全余量
      // trimThresholdRatio < 1 可提前触发裁剪，默认 1.0 = 占满物理上限才裁剪
      const tokenBudget = Math.max(1024, Math.floor(contextLength * this.trimThresholdRatio) - maxTokens - 512);

      // Bug B 防回溯：本回合中通过工具循环写入到 memory 的 (assistant+toolCalls + tool 结果) 消息时间戳。
      // 用户中途点「停止生成」时，这些条目要从历史中删除——否则下一条消息发出后，agent 会再次
      // 看到上一轮被中断的工具调用 + 半截 assistant 文本，导致「假回退」。
      const turnPersistedTimestamps: number[] = [];

      try {
        // 统一解析 session 配置（一次解析，多处复用）
        const sessionMgr = this.ctx.getService<SessionManagerService>('session-manager');
        const resolved =
          sessionMgr && incoming.sessionId
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
        this.logger.debug(
          `工具分组: platform=${incoming.platform}, enabledGroups=${enabledGroups ? JSON.stringify(enabledGroups) : '(无)'}`,
        );
        const tools =
          this.ctx
            .getService<ToolService>('tools')
            ?.getDefinitions(enabledGroups ? { groups: enabledGroups } : undefined) ?? [];
        const toolCtx: ToolCallContext = {
          sessionId: incoming.sessionId,
          // 优先用 actor（系统触发器注入的代理身份），其次 fallback 到消息原始 userId/platform。
          // 这样 scheduler/idle/proactive 等触发的 AI 走的是创建者的 authority，而非匿名 defaultAuthority。
          userId: incoming.actor?.userId ?? incoming.userId,
          platform: incoming.actor?.platform ?? incoming.platform,
          enabledGroups,
        };

        // 保存原始完整工具列表，后续迭代均以此为基础（避免被 hooks 修改后丢失）
        const originalTools = [...tools];

        // Hook: agent:llm:before — 插件可以修改消息或工具列表
        const llmBeforeData = {
          messages,
          tools,
          sessionId: incoming.sessionId,
          userId: incoming.userId,
          platform: incoming.platform,
          triggerType: incoming.triggerType,
        };
        await this.ctx.hooks.run('agent:llm:before', llmBeforeData);

        // 裁剪消息以确保不超过上下文窗口
        llmBeforeData.messages = this.trimMessages(llmBeforeData.messages, tokenBudget);

        // 推送 token 使用量统计
        this.emitTokenUsage(
          incoming.sessionId,
          incoming.platform,
          llmBeforeData.messages,
          llmBeforeData.tools,
          contextLength,
          maxTokens,
          tokenBudget,
        );

        this.logger.debug(
          `LLM 请求: ${llmBeforeData.messages.length} 条消息, ` +
            `${llmBeforeData.tools.length} 个工具, ` +
            `maxTokens=${maxTokens}`,
        );

        const t0 = Date.now();
        // 本轮初始时间与累加用量，用于最终 assistant 消息的 modelInfo 元数据。
        const turnStartTs = t0;
        const turnUsageAcc = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        const accUsage = (
          u: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined,
        ) => {
          if (!u) return;
          turnUsageAcc.promptTokens += u.promptTokens ?? 0;
          turnUsageAcc.completionTokens += u.completionTokens ?? 0;
          turnUsageAcc.totalTokens += u.totalTokens ?? 0;
        };
        const firstResult = await this.consumeStream(
          llm,
          {
            messages: llmBeforeData.messages,
            tools: llmBeforeData.tools.length > 0 ? llmBeforeData.tools : undefined,
            maxTokens,
            signal,
          },
          incoming.sessionId,
          incoming.platform,
          signal,
        );
        accUsage(firstResult.usage);

        // 维护本轮（一次完整对话回合）的统一时间线 segments：
        // 多次 LLM 调用 + 工具执行的输出按到达顺序拼接，保留模型原本的"思考/回答/工具/思考/回答"交错。
        const turnSegments: ContentSegment[] = [...firstResult.segments];

        let response: ChatResponse = firstResult;

        this.debugLogResponse(response, Date.now() - t0);

        // Hook: agent:llm:after — 插件可以处理 LLM 返回结果
        const llmAfterData = { response, messages: llmBeforeData.messages };
        await this.ctx.hooks.run('agent:llm:after', llmAfterData);
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

          // 并行执行所有工具调用（互不依赖的工具无需串行等待）
          const toolResultMaxChars = Math.floor(contextLength * this.toolResultMaxRatio * 3.5);

          const parallelResults = await Promise.all(
            response.toolCalls.map(async toolCall => {
              let args: Record<string, unknown>;
              try {
                args = JSON.parse(toolCall.function.arguments);
              } catch {
                args = {};
              }

              // Hook: agent:tool:before — 插件可以拦截或修改工具调用
              const toolBeforeData = { name: toolCall.function.name, args, toolCallContext: toolCtx };
              await this.ctx.hooks.run('agent:tool:before', toolBeforeData);

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
              let result = await (this.ctx
                .getService<ToolService>('tools')
                ?.execute(toolBeforeData.name, toolBeforeData.args, toolCtx) ??
                Promise.resolve(JSON.stringify({ error: 'tools 服务不可用' })));

              // Hook: agent:tool:after — 插件可以处理工具执行结果
              const toolAfterData = { name: toolBeforeData.name, result, toolCallContext: toolCtx };
              await this.ctx.hooks.run('agent:tool:after', toolAfterData);
              result = toolAfterData.result;

              // 工具结果截断：按上下文窗口比例限制单条工具结果长度
              if (result.length > toolResultMaxChars) {
                this.logger.info(
                  `工具结果过长 (${result.length} 字符)，截断至 ${toolResultMaxChars} 字符: ${toolBeforeData.name}`,
                );
                result = `${result.slice(0, toolResultMaxChars)}\n... [工具输出已截断，原始长度 ${result.length} 字符]`;
              }
              const toolEndTime = Date.now();

              this.logger.debug(`工具完成: ${toolBeforeData.name} (${toolEndTime - toolT0}ms) 结果=${result}`);

              // 通知平台：工具执行完成
              await this.ctx.emit('tool:execute', {
                sessionId: incoming.sessionId,
                platform: incoming.platform,
                toolName: toolBeforeData.name,
                args: toolBeforeData.args,
                phase: 'end',
                result,
              });

              return {
                toolCall,
                result,
                toolName: toolBeforeData.name,
                toolArgs: toolBeforeData.args,
                startTime: toolT0,
                endTime: toolEndTime,
              };
            }),
          );

          // 按原始 toolCalls 顺序将结果推入消息列表 + 时间线
          for (const { toolCall, result, toolName, toolArgs, startTime, endTime } of parallelResults) {
            const resultPreview = result.length > 200 ? `${result.slice(0, 200)}...` : result;
            toolCallSummaries.push(`[${toolCall.function.name}] ${resultPreview}`);

            const toolMessage: Message = {
              role: 'tool',
              content: result,
              toolCallId: toolCall.id,
            };
            llmBeforeData.messages.push(toolMessage);
            toolMessages.push(toolMessage);

            // 工具调用追加到本回合的统一时间线
            turnSegments.push({
              type: 'tool_call',
              name: toolName,
              args: toolArgs,
              result,
              startTime,
              endTime,
            });
          }

          await this.saveToolCallGroup(incoming.sessionId, assistantToolMessage, toolMessages, turnPersistedTimestamps);

          // 继续请求 LLM (再次经过 hooks)，使用原始完整工具列表而非被上一轮 hooks 修改过的列表
          const nextLlmData = {
            messages: llmBeforeData.messages,
            tools: [...originalTools],
            sessionId: incoming.sessionId,
            userId: incoming.userId,
            platform: incoming.platform,
            triggerType: incoming.triggerType,
          };
          await this.ctx.hooks.run('agent:llm:before', nextLlmData);

          // 裁剪消息以确保不超过上下文窗口
          nextLlmData.messages = this.trimMessages(nextLlmData.messages, tokenBudget);

          // 推送 token 使用量统计
          this.emitTokenUsage(
            incoming.sessionId,
            incoming.platform,
            nextLlmData.messages,
            nextLlmData.tools,
            contextLength,
            maxTokens,
            tokenBudget,
          );

          const tN = Date.now();
          const nextResult = await this.consumeStream(
            llm,
            {
              messages: nextLlmData.messages,
              tools: nextLlmData.tools.length > 0 ? nextLlmData.tools : undefined,
              maxTokens,
              signal,
            },
            incoming.sessionId,
            incoming.platform,
            signal,
          );
          turnSegments.push(...nextResult.segments);
          response = nextResult;
          accUsage(response.usage);

          this.debugLogResponse(response, Date.now() - tN, iterations);

          const nextLlmAfterData = { response, messages: nextLlmData.messages };
          await this.ctx.hooks.run('agent:llm:after', nextLlmAfterData);
          response = nextLlmAfterData.response;

          if (response.reasoningContent) {
            allReasoning.push(response.reasoningContent);
          }
        }

        // 检测是否因工具调用次数达到上限而退出循环
        const toolLimitReached =
          iterations >= maxToolIterations && response.toolCalls != null && response.toolCalls.length > 0;
        if (toolLimitReached) {
          this.logger.warn(`工具调用达到上限 (${maxToolIterations})，session=${incoming.sessionId}`);
        }

        // 保留原始 LLM 输出，用于存入 memory（避免纯文本历史污染 few-shot 示例）
        let rawLlmContent = response.content ?? '';
        let replyContent = rawLlmContent;

        // Hook: agent:reply:before — 插件可以修改最终回复
        // JSON 解析/修复统一由 persona 的 agent:reply:before 钩子处理
        type ReplyHookData = {
          content: string;
          archiveContent?: string;
          sessionId: string;
          platform?: string;
          userId?: string;
          triggerType?: typeof incoming.triggerType;
          retryRequested?: boolean;
          retryFeedback?: string;
          attempt?: number;
          maxRetries?: number;
        };
        const responseData: ReplyHookData = {
          content: replyContent,
          sessionId: incoming.sessionId,
          platform: incoming.platform,
          userId: incoming.userId,
          triggerType: incoming.triggerType,
          attempt: 0,
        };
        await this.ctx.hooks.run('agent:reply:before', responseData);

        // 重试循环：当 hook（如 persona 的 outputFormat 解析）报告 retryRequested 时，
        // 把失败的 assistant 输出 + 系统反馈追加到消息列表，重新请求 LLM；最多按 maxRetries 次。
        // maxRetries 由 hook 端写入（plugin-persona 从 outputFormat.retries 读取，默认 1）。
        const maxRetries = Math.max(0, responseData.maxRetries ?? 0);
        let attempt = 0;
        while (responseData.retryRequested && attempt < maxRetries && rawLlmContent.length > 0) {
          attempt++;
          this.logger.debug(
            `agent:reply:before 请求重试 (attempt=${attempt}/${maxRetries}, session=${incoming.sessionId}): ${responseData.retryFeedback ?? '(无反馈)'}`,
          );
          llmBeforeData.messages.push({ role: 'assistant', content: rawLlmContent });
          llmBeforeData.messages.push({
            role: 'system',
            content:
              responseData.retryFeedback ?? '上一次回复未能通过格式校验，请严格按照系统提示中规定的格式重新输出。',
          });
          const retryTrimmed = this.trimMessages(llmBeforeData.messages, tokenBudget);
          const retryResult = await this.consumeStream(
            llm,
            {
              messages: retryTrimmed,
              tools: undefined,
              maxTokens,
              signal,
            },
            incoming.sessionId,
            incoming.platform,
            signal,
          );
          turnSegments.push(...retryResult.segments);
          response = retryResult;
          accUsage(response.usage);
          rawLlmContent = response.content ?? '';
          if (response.reasoningContent) allReasoning.push(response.reasoningContent);

          // 用新输出再次跑 hook；hook 端根据 attempt 决定继续重试或走兜底（静默丢弃）
          responseData.content = rawLlmContent;
          responseData.archiveContent = undefined;
          responseData.retryRequested = false;
          responseData.retryFeedback = undefined;
          responseData.attempt = attempt;
          await this.ctx.hooks.run('agent:reply:before', responseData);
        }

        // 双保险：循环结束后若 hook 仍标记 retryRequested（理论上 persona 已在用尽时自动走兜底），
        // 强制把 content 置空，避免原始未校验内容被外发。
        if (responseData.retryRequested) {
          this.logger.warn(
            `agent:reply:before 重试用尽但 retryRequested 仍为 true，强制丢弃回复内容 (session=${incoming.sessionId})`,
          );
          responseData.content = '';
          responseData.retryRequested = false;
        }

        replyContent = responseData.content;
        const archiveContent = responseData.archiveContent ?? rawLlmContent;

        // 重复检测：如果回复与最近一条 assistant 消息完全相同，视为模型"卡壳"，静默跳过
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        if (replyContent && lastAssistant?.content && replyContent === lastAssistant.content) {
          this.logger.warn(`检测到重复回复，跳过发送 (session=${incoming.sessionId})`);
          replyContent = '';
        }

        // 发出流结束标记
        await this.ctx.emit('outbound:stream', {
          sessionId: incoming.sessionId,
          platform: incoming.platform,
          done: true,
          toolLimitReached,
        });

        // 空回复（outputFormat 中 reply 字段为空字符串或仅空白）时静默，不发送消息
        if (replyContent.trim().length === 0) {
          this.logger.debug(`空回复，跳过发送 (session=${incoming.sessionId})`);
        } else {
          const combinedReasoning = allReasoning.length > 0 ? allReasoning.join('\n\n---\n\n') : undefined;

          // 在 assistant 最终持久化时记录 modelInfo：前端从消息历史可还原 "这条回复
          // 由哪个 model 生成、用了多少 token、耗时多久"，方便用户验证模型切换是否生效。
          const turnModelInfo = {
            provider: llm.providerId,
            model: llm.id,
            promptTokens: turnUsageAcc.promptTokens || undefined,
            completionTokens: turnUsageAcc.completionTokens || undefined,
            totalTokens: turnUsageAcc.totalTokens || undefined,
            elapsedMs: Date.now() - turnStartTs,
          };
          const finalAssistantMetadata: Record<string, unknown> = {
            ...(assistantMetadata ?? {}),
            modelInfo: turnModelInfo,
          };

          // 保存最终 assistant 回复：优先存 persona 修复/规范化后的 JSON，保持格式完整，
          // 避免坏 JSON 或解码后纯文本污染历史 few-shot 示例导致模型不再遵守 outputFormat
          await this.saveToMemory(incoming.sessionId, {
            role: 'assistant',
            content: archiveContent,
            reasoningContent: response.reasoningContent,
            timestamp: Date.now(),
            metadata: finalAssistantMetadata,
            segments: turnSegments.length > 0 ? turnSegments : undefined,
          });

          // 发送给流式客户端时使用合并版本（统一时间线 segments 同时给出，前端按到达顺序渲染）
          await this.dispatchOutbound({
            content: replyContent,
            sessionId: incoming.sessionId,
            platform: incoming.platform,
            reasoningContent: combinedReasoning,
            source: 'agent',
            segments: turnSegments.length > 0 ? turnSegments : undefined,
            modelInfo: turnModelInfo,
          });
        }

        // Hook: agent:turn:after — 插件可以在完整消息周期结束后做后处理
        const turnOutcome: 'replied' | 'silent' = replyContent.trim().length === 0 ? 'silent' : 'replied';
        await this.ctx.hooks.run('agent:turn:after', {
          message: incoming,
          reply: replyContent,
          outcome: turnOutcome,
          sessionId: incoming.sessionId,
          metadata: msgHookData.metadata,
        });
      } catch (err) {
        // 中止错误 — 静默退出，前端通过 outbound:stream done 清理 buffer。
        //
        // 历史教训：早期版本会用 turnPersistedTimestamps 把"本轮已持久化的中间消息"全部删掉，
        // 注释里写的是防"半截 assistant 内容 / 假回退"。但实际审计 saveToolCallGroup（见下方）发现：
        //   1. saveToolCallGroup 只在并行工具全部执行完毕后整组写入（assistant tool_call + 所有
        //      tool result 一次性 push），catch 路径根本进不来；turnPersistedTimestamps 里只
        //      可能是"已完成、副作用已发生"的工具调用对。
        //   2. 删除这些 = 让 agent 忘记自己刚刚做过的有副作用的事（戳一戳/发送消息/调度任务/…），
        //      下一轮 LLM 看不到自己的行为，会重复调用，外部观察就是"agent 一直以为戳不了"。
        //   3. 真正的 orphan 风险（assistant tool_calls 缺 tool result）由 sanitizeToolCallHistory
        //      在装载历史时兜底过滤，不需要 abort 路径主动删除。
        // 所以这里不再回滚，让已完成的工具调用记录留在 memory，agent 下一轮能正确感知。
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.logger.info(
            `生成已中止: session=${incoming.sessionId}` +
              (turnPersistedTimestamps.length > 0
                ? `（保留本轮已完成的 ${turnPersistedTimestamps.length} 条工具调用记录，便于下一轮 agent 感知）`
                : ''),
          );
          await this.ctx.emit('outbound:stream', {
            sessionId: incoming.sessionId,
            platform: incoming.platform,
            done: true,
          });

          // 中止同样是回合终态：发 agent:turn:after(outcome=aborted) 让生命周期订阅方收尾——
          // session-manager 把会话状态从 active 收口为 completed（否则永远停在"进行中"），
          // checkpoint 关闭当前回合（否则中止后回合不关闭、长期泄漏）。
          // 文档与 agent-api 早已声明 outcome 含 aborted，此处兑现契约。
          await this.ctx.hooks.run('agent:turn:after', {
            message: incoming,
            reply: '',
            outcome: 'aborted',
            sessionId: incoming.sessionId,
            metadata: msgHookData.metadata,
          });

          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`处理消息失败: ${message}`);
        await this.dispatchOutbound({
          content: `[错误] ${message}`,
          sessionId: incoming.sessionId,
          platform: incoming.platform,
          source: 'system',
        });

        // 异常也是回合终态：同样发 turn:after(outcome=error) 让 checkpoint 关闭回合、
        // session-manager 收口状态。dispatchOutbound 已发系统错误消息，状态可被 outbound:message
        // 与本钩子双路径幂等收口。
        await this.ctx.hooks.run('agent:turn:after', {
          message: incoming,
          reply: '',
          outcome: 'error',
          sessionId: incoming.sessionId,
          metadata: msgHookData.metadata,
        });
      }
    });

    // 消息被拦截（如流控缓冲），通知前端结束 loading
    if (!handled) {
      await this.ctx.emit('outbound:stream', {
        sessionId: incoming.sessionId,
        platform: incoming.platform,
        done: true,
      });
    }
  }

  /**
   * 构建发送给 LLM 的消息列表
   */
  private async buildMessages(
    incoming: IncomingMessage,
    personaOpts?: PersonaSessionOptions,
    archivedIncoming?: Message,
  ): Promise<Message[]> {
    const messages: Message[] = [];

    // 1. 系统提示
    const systemPrompt = this.buildSystemPrompt(personaOpts);
    messages.push({ role: 'system', content: systemPrompt, metadata: { injector: 'persona' } });

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
          if (CONTROL_KINDS.includes(m.kind ?? '')) continue;
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

    // 3. 当前消息
    //
    // 内容主体由 message-archive 烘焙：sender 前缀 / 引用回复 / 图片描述 / 附件描述
    // 都已经写进 archivedIncoming.content。这里只在外层加一个时间标注，
    // 保证「LLM 看到的当前消息」与「历史消息」「向量库存档」三者一致。
    const senderLabel = getSenderLabel(incoming.nickname, incoming.userId);
    const nowLabel = formatTimeLabel(Date.now(), Date.now());
    const archivedBody = archivedIncoming?.content;
    const fallbackBody = senderLabel ? `[${senderLabel}]: ${incoming.content}` : incoming.content;
    const currentContent = `(${nowLabel}) ${archivedBody ?? fallbackBody}`;

    // 3a. proactive 委派分支：跨会话由「同一 agent 在另一会话的实例」派发过来的任务
    //
    // 这条消息不是用户请求，必须作为 system 指令呈现给 LLM，否则 B 会把它当成
    // 真实用户在指挥（典型 BUG：源会话 agent 决定派发，目标会话 agent 看到 user
    // 角色的消息，回复时使用「您」「您好」等措辞，把 agent 当成了用户）。
    //
    // 同时附上源会话 ID，并明确告诉 B：如需了解源会话上下文，按需调用
    // session_get_history(sessionId="<源>") —— 把"是否需要上下文"的决策权
    // 交给 B 的 LLM，避免无差别拼接源历史造成 token 浪费。
    if (incoming.triggerType === 'proactive') {
      const sourceMatch = incoming.source?.match(/^proactive:from:(.+)$/);
      const sourceSessionId = sourceMatch?.[1];
      const sourceLine = sourceSessionId ? `源会话 ID: ${sourceSessionId}\n` : '';
      // 不在 hint 里写死 limit，让 LLM 按 plugin-tool-session 的 defaultLimit / 自身判断决定
      const hintLine = sourceSessionId
        ? `如需了解源会话上下文（例如「按之前讨论的方案」之类的引用），调用 \`session_get_history(sessionId="${sourceSessionId}")\` 自行查阅（可按需附加 limit）。\n`
        : '';
      messages.push({
        role: 'system',
        content:
          `[跨会话委派 — 非用户消息]\n` +
          sourceLine +
          `任务: ${incoming.content}\n\n` +
          `说明: 这是你（作为同一 agent 在另一会话的实例）派发给本会话的任务指令，` +
          `不是用户请求。处理时不要使用「您」「请问」等面向用户的措辞，按指令直接执行并简明回报结果。\n` +
          hintLine,
        metadata: { injector: WellKnownKinds.CrossSessionDelegation, sourceSessionId },
      });
      return messages;
    }

    // 3b. 普通用户消息分支
    // 检测预处理附件内容——引导 LLM 综合分析而非逐项转述
    const hasPreprocessed = /\[图片\d*[:：]|\[文件[:：]|--- 文件内容 ---/.test(currentContent);
    if (hasPreprocessed) {
      messages.push({
        role: 'system',
        content:
          '用户消息中包含系统预处理的附件描述（图片识别结果和/或文件内容提取）。' +
          '请将这些信息作为参考上下文，结合用户的文字，给出一个自然、连贯的统一回复。' +
          '不要将分析结果逐项列出或分成单独的字段，直接在回复中融合所有信息。',
        metadata: { injector: 'system-other' },
      });
    }

    const userMessage: Message = {
      role: 'user',
      content: currentContent,
      name: getMessageName(incoming.userId),
      timestamp: Date.now(),
    };

    // 多模态：把 attachments 中的 image 项传递给 LLM（视觉模型多模态字段）
    const imageAtts = incoming.attachments?.filter(a => a.kind === 'image') ?? [];
    if (imageAtts.length > 0) {
      userMessage.images = imageAtts.map(a => a.data);
    }

    // 群聊焦点指引：仅 sessionType=group + triggerType ∈ {direct, immediate} 时注入，
    // 紧贴在当前 user 消息前，告诉 LLM "下一条就是焦点"。详细动机见 helpers.ts。
    const focusGuidance = buildFocusGuidance(incoming);
    if (focusGuidance) messages.push(focusGuidance);

    messages.push(userMessage);

    return messages;
  }

  /**
   * 构建系统提示词
   */
  private buildSystemPrompt(personaOpts?: PersonaSessionOptions): string {
    const persona = this.ctx.getService<PersonaService>('persona');
    const base = persona
      ? this.systemPrompt
        ? `${persona.getSystemPrompt(personaOpts)}\n\n${this.systemPrompt}`
        : persona.getSystemPrompt(personaOpts)
      : this.systemPrompt;
    return base ? `${base}\n\n${INPUT_CONVENTIONS}` : INPUT_CONVENTIONS;
  }

  /**
   * 粗略估算消息列表的总 token 数
   */
  private estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
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
      const t = estimateMsgTokens(msg);
      if (msg.role === 'system') {
        const source = msg.metadata?.injector as string | undefined;
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
              const ct = estimateTextTokens('x'.repeat(charCount as number));
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
    const toolDefsTokens = tools.length > 0 ? estimateTextTokens(JSON.stringify(tools)) : 0;

    const systemTokens =
      personaTokens +
      memorySummaryTokens +
      memoryVectorTokens +
      skillsTokens +
      platformTokens +
      subtaskTokens +
      systemOtherTokens;
    const totalUsed = systemTokens + historyTokens + toolResultTokens + toolDefsTokens;
    const usageRatio = contextLength > 0 ? totalUsed / contextLength : 0;

    this.ctx
      .emit('token:usage', {
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
      })
      .catch(() => {});

    // 节流日志：与 WebUI 看到的同一份数据，让 CLI / 文件日志使用者也能看见预算消耗。
    // 跨过 0.5 / 0.7 / 0.85 阈值必输出，否则每 10 轮一次。
    const bucket = usageRatio >= 0.85 ? 3 : usageRatio >= 0.7 ? 2 : usageRatio >= 0.5 ? 1 : 0;
    const st = this.tokenLogState.get(sessionId) ?? { count: 0, lastRatioBucket: -1 };
    st.count++;
    const crossedBucket = bucket !== st.lastRatioBucket;
    if (crossedBucket || st.count % 10 === 1) {
      const tag = bucket >= 3 ? 'CRITICAL' : bucket >= 2 ? 'WARN' : bucket >= 1 ? 'INFO' : 'OK';
      this.logger.info(
        `[token-usage:${tag}] ${sessionId} ${totalUsed}/${contextLength} (${(usageRatio * 100).toFixed(1)}%) ` +
          `sys=${systemTokens}(persona=${personaTokens} mem=${memorySummaryTokens + memoryVectorTokens} ` +
          `skills=${skillsTokens} subtask=${subtaskTokens} other=${systemOtherTokens}) ` +
          `hist=${historyTokens} tools=${toolResultTokens}+${toolDefsTokens}def reserve=${maxTokens}`,
      );
    }
    st.lastRatioBucket = bucket;
    this.tokenLogState.set(sessionId, st);
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
      const sysTokens = sysIdx.reduce((s, i) => s + estimateMsgTokens(result[i]), 0);
      if (sysTokens > this.memoryTokenBudget && sysIdx.length > 0) {
        const ratio = this.memoryTokenBudget / sysTokens;
        for (const idx of sysIdx) {
          const msg = result[idx];
          if (msg.content && msg.content.length > 200) {
            const oldTokens = estimateMsgTokens(msg);
            const targetLen = Math.max(200, Math.floor(msg.content.length * ratio));
            msg.content = `${msg.content.slice(0, targetLen)}\n... [记忆内容已缩减]`;
            estimated -= oldTokens - estimateMsgTokens(msg);
          }
        }
      }
    }
    if (estimated <= budget) return result;

    // === Phase 2: 截断过长的 tool 输出 ===
    for (let i = 1; i < result.length - 1; i++) {
      if (estimated <= budget) break;
      if (result[i].role === 'tool' && result[i].content && result[i].content!.length > 1500) {
        const oldTokens = estimateMsgTokens(result[i]);
        result[i].content = `${result[i].content!.slice(0, 500)}\n... [工具输出已截断]`;
        estimated -= oldTokens - estimateMsgTokens(result[i]);
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
        const oldTokens = estimateMsgTokens(msg);
        // 所有条目统一保留头部 200 字符（最新条保留稍多以保持上下文连贯性）
        const keepLen = k < rcIndices.length - 1 ? 200 : 400;
        msg.reasoningContent = `${msg.reasoningContent!.slice(0, keepLen)}\n... [推理内容已缩减]`;
        estimated -= oldTokens - estimateMsgTokens(msg);
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
          groupTokens += estimateMsgTokens(result[j]);
          if (result[j].role === 'tool') {
            const c = result[j].content ?? '';
            toolPreviews.push(c.length > 100 ? `${c.slice(0, 100)}...` : c);
          }
        }

        // 构建紧凑摘要
        const aMsg = result[start];
        const names = aMsg.toolCalls!.map(tc => tc.function.name);
        const parts = names.map((n, idx) => `${n} → ${toolPreviews[idx] ?? '(无结果)'}`);
        let text = `[历史工具调用] ${parts.join(' | ')}`;
        if (aMsg.content) text = `${aMsg.content}\n${text}`;

        const summaryMsg: Message = { role: 'assistant', content: text };
        const summaryTokens = estimateMsgTokens(summaryMsg);

        // 仅在确实能节省 token 时压缩
        if (summaryTokens < groupTokens) {
          result.splice(start, groupLen, summaryMsg);
          estimated -= groupTokens - summaryTokens;
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
        if (result[j].role === 'user') {
          lastUserIdx = j;
          break;
        }
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
        if (result[i].role === 'system' || lastGroupIndices.has(i) || i === lastUserIdx) {
          i++;
          continue;
        }
        // assistant(含toolCalls) + 紧跟的 tool 消息成组删除
        if (result[i].role === 'assistant' && result[i].toolCalls?.length) {
          estimated -= estimateMsgTokens(result[i]);
          result.splice(i, 1);
          adjustAfterSplice(i);
          while (i < result.length - 1 && result[i].role === 'tool') {
            if (lastGroupIndices.has(i)) break;
            estimated -= estimateMsgTokens(result[i]);
            result.splice(i, 1);
            adjustAfterSplice(i);
          }
          continue;
        }
        estimated -= estimateMsgTokens(result[i]);
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
        estimated -= estimateMsgTokens(result[idx]);
        result.splice(idx, 1);
      }
    }

    // 大幅裁剪后注入继续执行提示，防止模型因上下文缺失而中止任务
    if (messages.length - result.length >= 6) {
      const hint: Message = {
        role: 'system',
        content:
          '[系统提示] 由于上下文长度限制，部分历史消息已被压缩或移除。请基于当前可见的上下文和最新用户请求继续完成任务，不要因为看不到之前的细节而停止工作。如果你之前有正在执行的多步骤任务或计划，请查看对话摘要和 todo-list 工具确认当前进度，然后继续未完成的步骤。',
        metadata: { injector: 'system-other' },
      };
      // 插入到最后一条 user 消息之后（如果有），否则插到末尾前
      let insertIdx = result.length - 1;
      for (let j = result.length - 1; j >= 1; j--) {
        if (result[j].role === 'user') {
          insertIdx = j + 1;
          break;
        }
      }
      result.splice(insertIdx, 0, hint);
      estimated += estimateMsgTokens(hint);
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
    const identity = getPlatformSelfIdentity(this.ctx, incoming.platform, incoming.sessionId);
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

  private async saveToolCallGroup(
    sessionId: string,
    assistantMessage: Message,
    toolMessages: Message[],
    persistedTimestamps?: number[],
  ): Promise<void> {
    const timestamp = Date.now();
    await this.saveToMemory(sessionId, { ...assistantMessage, timestamp });
    persistedTimestamps?.push(timestamp);
    for (let i = 0; i < toolMessages.length; i++) {
      const ts = timestamp + i + 1;
      await this.saveToMemory(sessionId, { ...toolMessages[i], timestamp: ts });
      persistedTimestamps?.push(ts);
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
    return isSameMessage(a, b);
  }

  private async archiveIncomingMessageInOrder(lane: string, incoming: IncomingMessage): Promise<Message | undefined> {
    const previous = this.archiveQueues.get(lane) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.archiveIncomingMessage(incoming));
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
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

  /**
   * 派发出站消息：优先经过 gateway 中间件链；gateway 缺失时回退到事件总线。
   *
   * ⚠️ 仅用于"无 gateway"的最小应用 / 测试场景。完整应用应当加载 plugin-gateway，
   * 此时该 fallback 永远不命中——出站消息总是经过 outbound:dispatch 钩子链
   * （审计 / 脱敏 / 限速 / authority 等中间件）。
   *
   * 由于 plugin-agent-default 未在 inject.required 中声明 'gateway'，
   * 即使 gateway 未加载本插件仍会激活，因此保留该 fallback 以便：
   *   - 集成测试不必启动 gateway
   *   - 嵌入式 / 单 agent 部署场景
   * 生产部署务必确保 plugin-gateway 已加载，否则中间件链会被跳过。
   */
  private async dispatchOutbound(message: OutgoingMessage): Promise<void> {
    const gateway = this.ctx.getService<GatewayService>('gateway');
    if (gateway) {
      await gateway.dispatchOutbound(message);
      return;
    }
    this.logger.warn('Gateway 服务不可用，回退至 ctx.emit(outbound:message)（中间件链被跳过）');
    await this.ctx.emit('outbound:message', message);
  }
}

// ----- 插件导出 -----

export const name = '@aalis/plugin-agent';
export const displayName = '默认 Agent';
export const subsystem = 'agent';

export const provides = ['agent'];

export const inject = {
  optional: ['llm', 'memory', 'persona', 'message-archive', 'platform'],
};

export const configSchema: ConfigSchema = {
  defaultLLM: {
    type: 'llm-ref',
    label: '默认对话模型',
    description:
      '全局默认 LLM。apply() 时调用 ctx.preferService("llm", `provider/model`) 锁定 ServiceContainer 偏好。会话 / 平台 profile 未覆盖时生效。',
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
  trimThresholdRatio: {
    type: 'number',
    label: '裁剪触发比例',
    default: 1.0,
    description:
      '估算输入 token 占上下文长度的比例上限 (0~1)。本次调用超过该比例才会对消息列表做内存裁剪（不影响 DB）。默认 1.0 表示占满物理上限才裁剪；如需提前护航可调低。压缩触发请在“@aalis/plugin-memory-summary”中配置。',
  },
};

export const defaultConfig = {
  systemPrompt: '',
  memoryTokenBudget: 4096,
  historyLimit: 50,
  maxToolIterations: 30,
  toolResultMaxRatio: 0.15,
  trimThresholdRatio: 1.0,
};

// 暴露给 apply() 内部用 / 指令处理用的 DefaultAgent 内部方法窄化接口
// （正常 service 消费者走 AgentService 公共接口；此处属于 plugin 自有控制面）
type InternalAgent = {
  historyLimit: number;
  resolveLLM(platform?: string, sessionId?: string): Promise<LLMModelEntry | undefined>;
  buildSystemPrompt(personaOpts?: PersonaSessionOptions): string;
  emitTokenUsage(
    sessionId: string,
    platform: string,
    messages: Message[],
    tools: ToolDefinition[],
    contextLength: number,
    maxTokens: number,
    tokenBudget: number,
  ): void;
};

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const agentImpl = new DefaultAgent(ctx, config);
  ctx.provide('agent', agentImpl);
  const agent = agentImpl as unknown as InternalAgent;

  // 全局默认 LLM：通过 ServicePreference 锁定 ctx.getService<'llm'>() 的首选 entry。
  // 偏好持久化由 core 配置层负责（servicePreferences 字段）；这里只是开机时按 agent
  // 自己的 cfg.defaultLLM 覆写一次，便于纯文件配置流（无 webui 干预）也能生效。
  const defaultLLM = config.defaultLLM as { provider?: string; model?: string } | undefined;
  if (defaultLLM?.provider && defaultLLM?.model) {
    ctx.preferService('llm', `${defaultLLM.provider}/${defaultLLM.model}`);
  }

  // ===== /model 指令组（split 为 dot-path 子命令）=====
  // info / status / reset / set <name>
  async function modelInfo(sessionId: string, platform: string, listAvailable: boolean): Promise<string> {
    const smSvc = ctx.getService<SessionManagerService>('session-manager');
    const sessionLLM = smSvc?.getSession(sessionId)?.config?.llm;
    const parent = smSvc?.getSession(sessionId)?.parentId
      ? smSvc?.getSession(smSvc.getSession(sessionId)!.parentId!)
      : undefined;
    const parentDefaultsLLM = parent?.config?.sessionDefaults?.llm;
    const profileLLM = smSvc?.getPlatformProfiles()?.[platform || 'webui']?.llm;
    const resolvedLLM = smSvc ? smSvc.resolveConfig(sessionId, platform).llm : undefined;

    const fmt = (r?: { provider: string; model: string }) => (r ? `${r.provider}/${r.model}` : undefined);

    let source = '(无 / 走 ServicePreference)';
    if (sessionLLM) source = '会话覆盖';
    else if (parentDefaultsLLM) source = '父会话 sessionDefaults';
    else if (profileLLM) source = `平台 profile (${platform})`;

    const lines = [`**当前模型**: ${fmt(resolvedLLM) || '(默认)'}`, `**来源**: ${source}`];
    const chain: string[] = [];
    if (sessionLLM) chain.push(`会话: ${fmt(sessionLLM)}`);
    if (parentDefaultsLLM) chain.push(`父 sessionDefaults: ${fmt(parentDefaultsLLM)}`);
    if (profileLLM) chain.push(`平台 profile: ${fmt(profileLLM)}`);
    if (chain.length > 0) {
      lines.push('', '**解析链**（高优先级在前）:');
      for (const c of chain) lines.push(`- ${c}`);
    }
    if (sessionLLM) lines.push('', '_使用 `/model reset` 清除会话覆盖_');

    if (listAvailable) {
      // 直接枚举所有 chat-capable LLMModel entry
      const entries = ctx.getAllServices<LLMModel>('llm', ['chat']);
      const seen = new Set<string>();
      const items: string[] = [];
      for (const e of entries) {
        const display = e.label ? `${e.contextId}  _(${e.label})_` : e.contextId;
        if (seen.has(e.contextId)) continue;
        seen.add(e.contextId);
        items.push(display);
      }
      if (items.length > 0) {
        lines.push('', '**可用模型**（contextId 形式 `provider/model`）:');
        for (const m of items) lines.push(`- ${m}`);
      }
    }
    return lines.join('\n');
  }

  useCommandService(ctx)
    .command('model', '查看当前会话的对话模型与解析链；并列出可用模型')
    .action(async argv => modelInfo(argv.session.sessionId, argv.session.platform, true));

  useCommandService(ctx)
    .command('model.info', '查看当前会话的对话模型与解析链')
    .action(async argv => modelInfo(argv.session.sessionId, argv.session.platform, false));

  useCommandService(ctx)
    .command('model.status', '查看当前会话的对话模型与解析链')
    .action(async argv => modelInfo(argv.session.sessionId, argv.session.platform, false));

  useCommandService(ctx)
    .command('model.reset', '清除当前会话的模型覆盖')
    .action(async argv => {
      const smSvc = ctx.getService<SessionManagerService>('session-manager');
      if (!smSvc) return 'session-manager 服务不可用';
      const session = smSvc.getSession(argv.session.sessionId);
      if (session?.config?.llm) {
        const { llm: _, ...rest } = session.config;
        await smSvc.updateSession(argv.session.sessionId, { config: { ...rest, llm: undefined } as SessionConfig });
      }
      const fallback = smSvc.resolveConfig(argv.session.sessionId, argv.session.platform).llm;
      return `已清除会话模型覆盖，回退到: ${fallback ? `${fallback.provider}/${fallback.model}` : '(默认)'}`;
    });

  useCommandService(ctx)
    .command('model.set <ref:string>', '设置会话级模型覆盖；ref 形如 `provider/model`（即 LLM entry 的 contextId）')
    .action(async (argv, ref) => {
      const refStr = String(ref || '').trim();
      if (!refStr) return '用法: /model set <provider/model>，例如 /model set @aalis/plugin-openai:main/gpt-4o';
      // 用最后一个 '/' 切分，因为 provider id 内含有 '/'（如 `@aalis/plugin-openai:main`）。
      const lastSlash = refStr.lastIndexOf('/');
      if (lastSlash <= 0 || lastSlash === refStr.length - 1) {
        return '格式错误。请使用 `provider/model`，例如 `@aalis/plugin-openai:main/gpt-4o`';
      }
      const provider = refStr.slice(0, lastSlash);
      const model = refStr.slice(lastSlash + 1);
      const smSvc = ctx.getService<SessionManagerService>('session-manager');
      if (!smSvc) return 'session-manager 服务不可用';
      await smSvc.updateSession(argv.session.sessionId, { config: { llm: { provider, model } } as SessionConfig });
      return `当前会话模型已切换为: ${provider}/${model}（已持久化）`;
    });

  // 监听 token:request 事件 — 客户端刷新/重连时主动请求 token 用量
  ctx.on('token:request', async (...args: unknown[]) => {
    const data = args[0] as { sessionId: string; platform?: string };
    if (!data?.sessionId) return;

    try {
      const resolved = await agent.resolveLLM(data.platform, data.sessionId);
      if (!resolved) return;
      const llm = resolved.instance;

      const contextLength = llm.contextLength;
      const maxTokens = getModelMaxOutput(llm);
      const tokenBudget = Math.max(1024, contextLength - maxTokens - 512);

      // 获取历史消息并构建基础消息列表
      const memory = ctx.getService<MemoryService>('memory');
      const messages: Message[] = [];

      // 系统提示
      const systemPrompt = agent.buildSystemPrompt();
      messages.push({ role: 'system', content: systemPrompt, metadata: { injector: 'persona' } });

      // 历史消息
      if (memory) {
        const history = await memory.getHistory(data.sessionId, agent.historyLimit);
        messages.push(...history.filter(m => !CONTROL_KINDS.includes(m.kind ?? '')));
      }

      // 运行 agent:llm:before 中间件以获取注入的 system 消息（摘要、向量记忆等）+ 工具搜索层过滤
      const sm = ctx.getService<SessionManagerService>('session-manager');
      const sessionResolved = sm ? sm.resolveConfig(data.sessionId, data.platform) : undefined;
      const enabledGroups = sessionResolved?.enabledToolGroups?.length ? sessionResolved.enabledToolGroups : undefined;
      const tools =
        ctx.getService<ToolService>('tools')?.getDefinitions(enabledGroups ? { groups: enabledGroups } : undefined) ??
        [];

      const llmBeforeData = { messages, tools, sessionId: data.sessionId, userId: '', platform: data.platform ?? '' };
      await ctx.hooks.run('agent:llm:before', llmBeforeData);

      agent.emitTokenUsage(
        data.sessionId,
        data.platform ?? '',
        llmBeforeData.messages,
        llmBeforeData.tools,
        contextLength,
        maxTokens,
        tokenBudget,
      );
    } catch (err) {
      ctx.logger.debug('token:request 处理失败:', err);
    }
  });
}
