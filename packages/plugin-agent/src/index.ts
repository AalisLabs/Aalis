import { Buffer } from 'node:buffer';
import {
  type AgentService,
  agent as agentService,
  type PreprocessorFn,
  type TokenUsageEvent,
  type TurnInput,
} from '@aalis/api-agent';
import { authority as authorityService, originTurnOf } from '@aalis/api-authority';
import { commands as commandsService } from '@aalis/api-commands';
import { contributions } from '@aalis/api-contributions';
import { gateway as gatewayService } from '@aalis/api-gateway';
import { type HookContextMap, hooks } from '@aalis/api-hooks';
import { ownHostConfig } from '@aalis/api-host-config';
import type { ChatModelRequest, ChatResponse, LLMModel, ModelRef } from '@aalis/api-llm';
import {
  estimateMsgTokens,
  estimateTextTokens,
  LLMCapabilities,
  listLLMModels,
  llm as llmService,
  MODEL_REF_TEXT,
  resolveLLMModel,
} from '@aalis/api-llm';
import { media as mediaService } from '@aalis/api-media';
import { memory as memoryService } from '@aalis/api-memory';
import { messageArchive as messageArchiveService, speakerOf } from '@aalis/api-message-archive';
import { type PersonaSessionOptions, persona as personaService } from '@aalis/api-persona';
import { getPlatformSelfIdentity, platform as platformService } from '@aalis/api-platform';
import { originChatOf, rootSessionOf, sessionManager as sessionManagerService } from '@aalis/api-session-manager';
import { type SessionFieldReader, sessionFields as sessionFieldsService } from '@aalis/api-session-settings';
import { isStorageUri, storage as storageService } from '@aalis/api-storage';
import {
  type ToolCallRequest,
  type ToolDefinition,
  type ToolExecutionResult,
  tools as toolsService,
} from '@aalis/api-tools';
import {
  type BoundOf,
  config as configCap,
  definePlugin,
  events,
  type Logger,
  lifecycle,
  logger as loggerCap,
  optional,
  type ProviderEntry,
  pluginsService,
  provide,
  services,
} from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { type TextRef, textLines, textOf, toSource } from '@aalis/schema-i18n';
import type {
  ContentSegment,
  IncomingMessage,
  Message,
  OutgoingMessage,
  ToolCall,
  TurnRecord,
} from '@aalis/schema-message';
import {
  arrivalTag,
  buildIncomingContent,
  CONTROL_KINDS,
  DIRECTIVE_KINDS,
  getMessageName,
  getSenderLabel,
  groupToolCalls,
  WellKnownKinds,
  WellKnownMetadataKeys,
  wasAddressed,
} from '@aalis/schema-message';
import { stripLeakedSpecialTokens, truncateChars } from '@aalis/util-text-normalize';
import {
  buildFocusGuidance,
  describeLLMFailure,
  estimateHistoryTokens,
  estimateTokens,
  formatTimeLabel,
  formatToolArgsForLog,
  hasAttachmentDescriptions,
  historyForModel,
  INPUT_CONVENTIONS,
  isSameMessage,
  parseToolArguments,
  queuedNote,
  readHistory,
  stoppedNote,
} from './helpers.js';
import { assemblePromptContributions, VOLATILE_INJECTOR } from './prompt-assembly.js';
import { type Placement, SessionQueues, type StoppedBy, type Turn } from './session-queue.js';
import { t } from './texts.js';

// ===== 能力声明 =====
//
// 对话编排要碰的东西全在这里：没写进 uses 的，插件碰不到。全部 optional——少一样能力
// 只是少一段能力（没有 memory 就没有历史、没有 tools 就把「工具不可用」回给模型、没有
// gateway 就直接走事件总线），不该让整个 agent 停活。
const uses = {
  logger: loggerCap,
  config: configCap,
  events,
  hooks,
  contributions,
  lifecycle,
  provide,
  commands: optional(commandsService),
  tools: optional(toolsService),
  llm: optional(llmService),
  memory: optional(memoryService),
  persona: optional(personaService),
  messageArchive: optional(messageArchiveService),
  sessionManager: optional(sessionManagerService),
  /** 判谁是 owner：参与者里合一 owner 的各个身份、存档不在时当轮正文的发送者前缀（与存档同一规则，speakerOf）、/stop */
  authority: optional(authorityService),
  /** 按会话读本插件的四项（模型、深度思考、最大工具迭代、历史条数上限）；缺席时只取插件配置里的值 */
  sessionFields: optional(sessionFieldsService),
  /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
  document: optional(ownHostConfig),
  platform: optional(platformService),
  media: optional(mediaService),
  storage: optional(storageService),
  gateway: optional(gatewayService),
  plugins: optional(pluginsService),
  /** 会话没设模型时比对本插件该生效的 llm 偏好与实际用的模型 */
  services,
};
type Caps = BoundOf<typeof uses>;

/** 编排器自己要用的能力：装配面（发布服务、指令、生命周期）留在 apply，不进类里 */
type AgentCaps = Omit<Caps, 'provide' | 'commands' | 'lifecycle'>;

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
// 宿主通知的公开链接须在最终正文保留；同时识别普通文本和 Markdown 链接的边界。
const NOTICE_URL = /https?:\/\/[^\s<>()[\]"'`*“”‘’，。！？；、]+/gu;
function getModelMaxOutput(llm: Pick<LLMModel, 'maxOutputTokens'>): number {
  return llm.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/** 条目固定的那个模型写成模型引用 */
const refOf = (entry: ProviderEntry<LLMModel>): ModelRef => ({ provider: entry.use.providerId, model: entry.use.id });

/** 一轮的结局 */
type TurnOutcome = HookContextMap['agent:turn:after']['outcome'];

/**
 * 硬裁剪的结果：trimmed 为进入了硬裁剪：入口估算超过了预算（不一定真裁掉了内容），或历史超过它的可用量、丢了一段；没改动的消息
 * 是原来的对象
 */
interface TrimmedMessages {
  messages: Message[];
  trimmed: boolean;
}

/** 一条 token:usage 的素材：事件里直传的字段，加发出的（快照是组好的）消息与工具定义 */
type UsageReport = Pick<
  TokenUsageEvent,
  | 'sessionId'
  | 'platform'
  | 'turnId'
  | 'contextWindow'
  | 'maxTokens'
  | 'tokenBudget'
  | 'trimmed'
  | 'untrimmedHistory'
  | 'historyMessages'
  | 'historyLimit'
> & {
  messages: Message[];
  tools: ToolDefinition[];
  /** 模型服务返回的这次调用的输入 token；没有返回时与快照缺省，按消息与工具定义估算 */
  promptTokens?: number;
};

class DefaultAgent implements AgentService {
  private caps: AgentCaps;
  private logger: Logger;
  private systemPrompt: string;
  private memoryTokenBudget: number;
  /** 单个 agent:prompt 贡献 build 的等待上限（毫秒；0=不设限）——见 prompt-assembly 的护栏说明 */
  readonly promptBuildTimeoutMs: number;
  /** 单条工具结果占上下文窗口的最大比例 (0~1)，超出则截断 */
  private toolResultMaxRatio: number;
  /** 裁剪触发比例 (0~1)：裁剪预算按上下文长度乘它再扣输出预留，见 computeTokenBudget */
  private trimThresholdRatio: number;

  /** 各会话的通道：在跑的一轮、待插入与排队的输入（见 session-queue.ts）。停机由 run() 直接经它停，清消息历史经 clearing */
  readonly queues: SessionQueues;

  /** 每次激活只在实际写入缺少归档时告警一次，不因插件加载顺序误报。 */
  private archiveUnavailableWarned = false;

  /**
   * 节流日志状态：记录每个 session 上次 token:usage 日志的"轮次"与 ratio 桶。
   * - 跨过 0.5/0.7/0.85 三个阈值必输出
   * - 否则每 10 轮（计数器）输出一次
   * 与 token:usage 事件共用同一份 breakdown 数据，零额外计算。
   */
  private tokenLogState = new Map<string, { count: number; lastRatioBucket: number }>();

  /** 已告警过的（llm 服务的偏好，实际用的模型）组合 */
  private readonly preferenceFallbacks = new Set<string>();

  /** 已注册的预处理器（name → { dispose }） */
  private preprocessors = new Map<string, { dispose: () => void }>();

  /** 本插件的按会话字段：每一轮按会话现读；模型没设时的 actual 是服务此刻为本插件挑的那一个 */
  readonly fields: SessionFieldReader<typeof configSchema>;

  /** 判一个身份是不是 owner：工具调用上下文里合一 owner 的各个身份、/stop 都用它；权限服务不在时没有人是 owner */
  readonly isOwner = (platform: string, userId?: string): boolean =>
    this.caps.authority.present && this.caps.authority.use.isOwner(platform, userId);

  constructor(
    caps: AgentCaps,
    cfg: ConfigOf<typeof configSchema>,
    /** 本插件实例 id：读它的本插件偏好 */
    private readonly instanceId: string,
  ) {
    this.caps = caps;
    this.queues = new SessionQueues((sessionId, waiting) => {
      void caps.events.use.emit('agent:queue', { sessionId, waiting });
    });
    this.fields = caps.sessionFields.use.fields(configSchema, caps, {
      llm: () => {
        const entry = this.resolveLLM(undefined);
        return entry && { value: refOf(entry) };
      },
    });
    this.logger = caps.logger.use.child('agent');
    this.systemPrompt = cfg.systemPrompt;
    this.memoryTokenBudget = cfg.memoryTokenBudget;
    this.promptBuildTimeoutMs = cfg.promptBuildTimeoutMs;
    this.toolResultMaxRatio = cfg.toolResultMaxRatio;
    this.trimThresholdRatio = cfg.trimThresholdRatio;
    this.logger.info('默认对话代理已初始化');
  }

  /**
   * 解析会话该用哪个 LLMModel entry：ref 是这个会话的「模型」（按会话字段 llm 的生效值）。
   *
   * 「模型」的全局层是本插件的 llm 偏好，哪一层都没设时不给值，由 resolveLLMModel 落到本插件此刻选中的那一个（本插件偏好 >
   * 全局偏好 > 提供者优先级 > 登记先后）。这时该生效的偏好（设了本插件偏好就是它，否则是全局偏好）指向的模型不在（模型删了、
   * 提供者在重载或激活失败），服务落到别的模型上：照常用它，每个（偏好，实际）组合告警一次。
   *
   * 返回 llm 的提供者条目（id 与这一家的业务句柄 use），条目固定那一个模型。
   */
  resolveLLM(ref: ModelRef | undefined): ProviderEntry<LLMModel> | undefined {
    // 解析为具体 LLMModel entry（要求至少 chat 能力；ref 为空时走 ServicePreference / 优先级）
    const entry = resolveLLMModel(this.caps.llm, ref, ['chat']);
    if (ref || !entry) return entry;
    const own = this.caps.services.use.preferred(llmService, { for: this.instanceId });
    const preferred = own ?? this.caps.services.use.preferred(llmService);
    if (preferred !== undefined && entry.id !== preferred) {
      const combo = `${preferred}\n${entry.id}`;
      if (!this.preferenceFallbacks.has(combo)) {
        this.preferenceFallbacks.add(combo);
        this.logger.warn(
          `llm 服务的${own === undefined ? '' : '本插件'}偏好 ${preferred} 没有生效（指向的模型不在、提供者在重载或激活失败），实际用的是 ${entry.id}`,
        );
      }
    }
    return entry;
  }

  /** 解析失败时说清**为什么**（取数在此，措辞在 helpers 的 describeLLMFailure，纯函数便于单测）。 */
  private explainLLMFailure(wanted: ModelRef | undefined): TextRef {
    const available = listLLMModels(this.caps.llm, { caps: ['chat'] }).map(e => e.id);
    return describeLLMFailure(available, wanted, this.erroredLLMPlugins());
  }

  /** 把这个会话本会话层的「模型」设成 model：经读取器写本插件的字段，会话设置不在时抛错 */
  async assignModel(sessionId: string, model: ModelRef): Promise<void> {
    await this.fields.set(sessionId, 'llm', model);
  }

  /** 激活失败且声明提供 llm 的插件实例名——「一个模型都没有」时，病因通常就在它们身上（多为缺 apiKey）。 */
  private erroredLLMPlugins(): string[] {
    if (!this.caps.plugins.present) return [];
    const pm = this.caps.plugins.use;
    // 只取实例名：这串会拼进**发到聊天**（含群聊）的文案里，error 原文可能带内网地址与端口等部署细节，
    // 原因留在日志、WebUI 与 /doctor
    return pm
      .getStatus()
      .filter(p => p.state === 'error' && p.provides?.includes('llm'))
      .map(p => p.instanceId);
  }

  /**
   * 停下这个会话在跑的一轮；queued 为真时连同排队与待插入的一起放掉，放掉的在那一轮落定之后归档（不带回合 id）；by 是停下它的
   * 人，写进停下标记。禁言、全部停止、停止键与 /stop 经这里
   */
  abort(
    sessionId: string,
    options: { turnId?: string; queued?: boolean; reason?: string; by?: StoppedBy } = {},
  ): boolean {
    return this.queues.stop(sessionId, { ...options, archive: true });
  }

  /**
   * 清消息历史：先按住这些会话，再停下在跑的一轮、放掉排着与待插入的（不归档），等它落定再跑 clear。被停的一轮落定之前还会写
   * 工具调用组，先停后清，清空的历史里才不留它的写入。按住期间要交给通道的输入放开再交
   */
  async clearing(
    sessionIds: readonly string[] | undefined,
    clear: () => Promise<unknown>,
    reason = '清消息历史',
  ): Promise<void> {
    const release = this.queues.hold(sessionIds);
    try {
      await this.queues.stopAll(sessionIds ?? this.queues.sessions(), { archive: false, reason });
      await clear();
    } finally {
      release();
    }
  }

  /**
   * 会话删除（session:deleted）：停掉这个会话在跑的一轮、放掉排着的（不归档）并等它收尾（在 clearing 之内时它已经停过）：没有
   * 上限，不响应中止的工具会让它一直等到工具返回。再丢弃它的 token 日志节流状态
   */
  async sessionDeleted(sessionId: string): Promise<void> {
    await this.queues.stopAll([sessionId], { archive: false, reason: '会话删除' });
    this.tokenLogState.delete(sessionId);
  }

  /**
   * 注册输入预处理器（如图片识别、文件读取、用户画像等）。
   * 多个预处理器按注册顺序串行执行（Koa-style 洋葱模型）。
   *
   * 底层通过 agent:input:before 中间件实现。
   * 同名注册会自动替换旧的预处理器。
   */
  registerPreprocessor(name: string, handler: PreprocessorFn): () => void {
    // 同名替换
    this.preprocessors.get(name)?.dispose();

    const dispose = this.caps.hooks.use.middleware('agent:input:before', async (data, next) => {
      await handler(data.message, next);
    });

    // 退订按条目引用比对：同名重注册后，旧退订闭包只摘自己的中间件，不动新登记的条目
    const entry = {
      dispose: () => {
        dispose();
        if (this.preprocessors.get(name) !== entry) return;
        this.preprocessors.delete(name);
        this.logger.info(`预处理器已注销: ${name}`);
      },
    };
    this.preprocessors.set(name, entry);
    this.logger.info(`预处理器已注册: ${name}`);
    return entry.dispose;
  }

  /**
   * 消费流式 LLM 调用，累积完整响应，同时向前端推送增量事件。
   *
   * 同时构建本轮调用的 segments 时间线（按 chunk 到达顺序记录 text / reasoning_text，
   * 相邻同类合并）——用于上层将多轮调用 + 工具执行交错拼接成统一时间线。
   *
   * 工具调用的生成进度按调用的序号各配一个 callId 随进度推出，界面在参数生成期间就画出它的工具卡。generating 按序号
   * 记下 callId 与工具名（provider 按序号组装 toolCalls，序号即调用在 toolCalls 里的位置）；没报过进度的调用没有。
   */
  private async consumeStream(
    llm: LLMModel,
    request: ChatModelRequest,
    turnId: string,
    sessionId: string,
    platform: string,
    emitProgress = true,
  ): Promise<ChatResponse & { segments: ContentSegment[]; generating: Map<number, { callId: string; name: string }> }> {
    const generating = new Map<number, { callId: string; name: string }>();
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

    for await (const chunk of llm.chatStream!({ ...request, sessionId, purpose: this.purposeOf(sessionId) })) {
      // 检查中止信号
      if (request.signal?.aborted) {
        throw new DOMException('Generation aborted', 'AbortError');
      }
      if (chunk.contentDelta) {
        content += chunk.contentDelta;
        appendDelta('text', chunk.contentDelta);
        if (emitProgress)
          await this.caps.events.use.emit('outbound:stream', {
            sessionId,
            turnId,
            platform,
            contentDelta: chunk.contentDelta,
          });
      }
      if (chunk.reasoningDelta) {
        reasoningContent += chunk.reasoningDelta;
        appendDelta('reasoning_text', chunk.reasoningDelta);
        if (emitProgress)
          await this.caps.events.use.emit('outbound:stream', {
            sessionId,
            turnId,
            platform,
            reasoningDelta: chunk.reasoningDelta,
          });
      }
      if (emitProgress && chunk.toolCallProgress) {
        const { index, name } = chunk.toolCallProgress;
        const callId = generating.get(index)?.callId ?? crypto.randomUUID();
        generating.set(index, { callId, name });
        await this.caps.events.use.emit('outbound:stream', {
          sessionId,
          turnId,
          platform,
          toolCallProgress: { ...chunk.toolCallProgress, callId },
        });
      }
      if (chunk.done) {
        toolCalls = chunk.toolCalls;
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    // 经 OpenAI 兼容接口接入时，服务端漏进正文的工具调用标记只有这一层会剥：只剥不执行，落库的正文与时间线都过它。
    // 时间线的正文段是 content 的切片，剥空的段不留
    const { sanitized, hadLeak } = stripLeakedSpecialTokens(content);
    if (hadLeak) {
      this.caps.logger.use.warn(
        `agent: 检测到 LLM 内容残留 DSML 标记，已剥离（session=${sessionId} platform=${platform} 原长=${content.length} 净化后=${sanitized.length}）`,
      );
    }
    return {
      content: sanitized,
      reasoningContent: reasoningContent || undefined,
      toolCalls,
      usage,
      segments: segments.flatMap((segment): ContentSegment[] => {
        if (segment.type !== 'text') return [segment];
        const text = stripLeakedSpecialTokens(segment.content).sanitized;
        return text ? [{ ...segment, content: text }] : [];
      }),
      generating,
    };
  }

  /** 记账的用途：子会话里的回合是子任务，其余是对话 */
  private purposeOf(sessionId: string): string {
    return (this.caps.sessionManager.present ? this.caps.sessionManager.use.getSession(sessionId)?.kind : undefined) ===
      'task'
      ? '子任务'
      : '对话';
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
      // 缓存命中单列：provider 未上报时不打（undefined = 不可知，与 0 命中不同）
      const cacheSeg =
        u.cachedPromptTokens != null
          ? ` / 缓存命中 ${u.cachedPromptTokens}（${u.promptTokens > 0 ? ((u.cachedPromptTokens / u.promptTokens) * 100).toFixed(1) : '0.0'}%）`
          : '';
      lines.push(`  Token: 输入 ${u.promptTokens} / 输出 ${u.completionTokens} / 总计 ${u.totalTokens}${cacheSeg}`);
    }

    lines.push(sep);
    this.logger.debug(lines.join('\n'));
  }

  /** 会话管理给这个会话的代号（api-session-manager 的 generationOf）；会话管理不在时没有 */
  private generationOf(sessionId: string): number | undefined {
    return this.caps.sessionManager.present ? this.caps.sessionManager.use.generationOf(sessionId) : undefined;
  }

  async handleMessage(incoming: IncomingMessage): Promise<void> {
    // 入口记下这个会话的代号：交给通道之前变了（会话管理这期间开始删了这个会话）的是删除之前的一代，放掉、不归档
    const generation = this.generationOf(incoming.sessionId);
    // Hook: agent:input:before — 每条输入一次（预处理器挂在这里），中间件可以改写这条；不调 next() 即丢掉它，不进一轮
    const inputData: HookContextMap['agent:input:before'] = { message: incoming };
    let placed = false;
    await this.caps.hooks.use.run('agent:input:before', inputData, async () => {
      placed = true;
      const { message } = inputData;
      // 清消息历史与删会话期间按住的会话：放开再交给通道
      await this.queues.held(message.sessionId);
      if (this.generationOf(incoming.sessionId) !== generation) this.logRoute(message, '放掉');
      else await this.settleInput(message, this.queues.place(message));
    });
    // 输入被丢掉（如流控缓冲），通知前端结束 loading：它没进一轮，流结束标记的回合 id 只是占位
    if (!placed) {
      await this.caps.events.use.emit('outbound:stream', {
        sessionId: incoming.sessionId,
        turnId: crypto.randomUUID(),
        platform: incoming.platform,
        done: true,
      });
    }
  }

  /** 逐条输入的默认动作：交给通道之后等这条落定（它所在的一轮结束，或它被放掉）；轮到它开轮时由它跑这一轮 */
  private async settleInput(message: IncomingMessage, placement: Placement): Promise<void> {
    if (placement.route === 'drop') {
      this.logRoute(message, '放掉');
      // 停机放掉的在这个会话在跑的一轮落定之后归档
      await this.queues.settled(message.sessionId);
      await this.archiveIncomingMessage(message);
      return;
    }
    if (placement.route !== 'open') this.logRoute(message, placement.route === 'join' ? '待插入' : '排队');
    const turn = placement.route === 'open' ? placement.turn : await placement.ready;
    if (turn) await this.playTurn(turn);
  }

  /** 每条输入一行 debug：去向、到达序号、会话与回合，不记正文与昵称 */
  private logRoute(message: IncomingMessage, route: string, turnId?: string): void {
    this.logger.debug(
      `→ ${route}${arrivalTag(message)} session=${message.sessionId}${turnId ? ` turn=${turnId}` : ''}`,
    );
  }

  /**
   * 跑一轮：agent:turn:before 的默认动作是这一轮的全部，中间件不调 next() 即拦下这一轮（不归档、不调模型、不发
   * agent:turn:after）。之后按先后归档这期间放掉、要归档的输入，再交出下一批：agent 在一个会话里的写入因此不交错
   */
  private async playTurn(turn: Turn): Promise<void> {
    const { sessionId, turnId } = turn;
    const inputs: TurnInput[] = turn.batch.map(message => ({ message }));
    for (const message of turn.batch) this.logRoute(message, '开轮', turnId);
    const startedAt = Date.now();
    let outcome: TurnOutcome | undefined;
    try {
      await this.caps.hooks.use.run('agent:turn:before', { turnId, sessionId, inputs }, async () => {
        outcome = await this.runTurn(turn, inputs);
      });
    } finally {
      // 这一轮被拦下（如已删子会话的消息），通知前端结束 loading
      if (outcome === undefined) {
        await this.caps.events.use.emit('outbound:stream', {
          sessionId,
          turnId,
          platform: inputs[0].message.platform,
          done: true,
        });
      }
      for (let dropped = this.queues.drain(turn); dropped.length > 0; dropped = this.queues.drain(turn)) {
        for (const { message, archive, settle } of dropped) {
          this.logRoute(message, '放掉');
          if (archive) await this.archiveIncomingMessage(message);
          settle();
        }
      }
      const arrivals = inputs.map(({ message }) => arrivalTag(message)).join('');
      this.logger.info(
        `回合结束 turn=${turnId} session=${sessionId} 结局=${outcome ?? '拦下'}` +
          `${turn.reason ? ` 原因=${turn.reason}` : ''} 用时=${Date.now() - startedAt}ms${arrivals && ` 输入${arrivals}`}`,
      );
      this.queues.release(turn);
    }
  }

  /**
   * agent:turn:before 的默认动作：先按先后归档开轮的输入，再跑这一轮，返回结局。真人消息开的一轮在每次调用模型之前（第一次与
   * 每批工具之后；格式重试的那几次不算）取走待插入的输入，最后一次模型调用返回不带工具调用的回复之后不再收
   */
  private async runTurn(turn: Turn, inputs: TurnInput[]): Promise<TurnOutcome> {
    const { sessionId, turnId } = turn;
    const { signal } = turn.controller;
    // 同一轮的输入会话与来源相同；带来源的注入（宿主通知、委派）各自成一轮，只有这一条
    const first = inputs[0].message;
    const { platform } = first;
    const reportOnly = first.hostNotice?.reportOnly === true;
    const noticeLinks = reportOnly ? (first.content.match(NOTICE_URL) ?? []) : [];
    const recordOf = (outcome: TurnOutcome): TurnRecord => ({ outcome, ...(first.source && { source: first.source }) });
    // 回合记录一轮只写一次：回复了的随回复落库时写下，之后外发或 agent:turn:after 的中间件出错不再另记一条
    let recorded = false;
    /** 这一轮落过工具调用组 */
    let savedGroups = false;
    /**
     * 收尾：还没写回合记录的（静默、中止、出错）落一条只带回合 id 与记录的事件标记，不进模型、不进摘要，会话服务据此在历史里还原
     * 这一轮的结局；中止的先落一条给下一轮的模型看的停下标记。再发 agent:turn:after
     */
    const end = async (
      outcome: TurnOutcome,
      { reply = '', error }: { reply?: string; error?: string | TextRef } = {},
    ): Promise<TurnOutcome> => {
      if (!recorded) {
        recorded = true;
        // 只在这一轮在历史里留下了输入或工具调用组时写：什么也没留下时（空闲开话题还没调工具就被停下），下一轮模型看到的上文是
        // 之前已经答完的一轮，写「上面这一轮被停下了」会被读成上一句回复没发出
        if (outcome === 'aborted' && (savedGroups || inputs.some(input => input.archived))) {
          await this.saveToMemory(sessionId, stoppedNote(this.stopperLabel(sessionId, turn.stoppedBy), turnId));
        }
        await this.saveToMemory(sessionId, {
          role: 'system',
          kind: WellKnownKinds.EventMarker,
          content: '',
          timestamp: Date.now(),
          metadata: { [WellKnownMetadataKeys.TurnId]: turnId, [WellKnownMetadataKeys.TurnRecord]: recordOf(outcome) },
        });
      }
      await this.caps.hooks.use.run('agent:turn:after', {
        inputs,
        reply,
        outcome,
        ...(error === undefined ? {} : { error }),
        sessionId,
        turnId,
      });
      return outcome;
    };

    for (const input of inputs)
      input.archived = await this.archiveIncomingMessage(input.message, { turnId, entry: 'opened' });

    // 这一轮的设置在开轮时读一次（下一轮再读，改了不必重载）：插进来的输入不重读，同一轮里换模型或工具列表会改掉之后各次调用的
    // 前缀。同一会话的输入会话相同，入口平台只对没有出生平台的会话起作用，取开轮那条的
    const settings = this.fields.get(sessionId, { platform });
    const resolved = this.resolveLLM(settings.llm);
    if (!resolved) {
      const why = this.explainLLMFailure(settings.llm);
      this.logger.warn(`LLM 解析失败，无法处理消息：${toSource(why)}`);
      if (!reportOnly) {
        const text = t('systemNotice', { why });
        await this.dispatchOutbound({ content: toSource(text), text, sessionId, platform, source: 'system', turnId });
      }
      return signal.aborted ? end('aborted') : end('error', { error: why });
    }
    const llm = resolved.use;
    // 这一轮的主模型能不能亲眼看图：按模型服务登记的能力（端点报告或单模型能力覆盖），
    // 工具上下文与 agent:llm:before 同一个值
    const acceptsImages = llm.capabilities.includes(LLMCapabilities.Vision);

    // 从 LLM model entry 读取参数。contextLength / maxOutputTokens 均为 per-model 属性，
    // service-granularity 后不再需要 router.getContextLengthFor() 反查，也不再会出现
    // 默认 provider 全局窗口与会话实际 model 不一致的偏差（Bug F 结构性修复）。
    const maxTokens = getModelMaxOutput(llm);
    const contextLength = llm.contextLength;
    const tokenBudget = this.computeTokenBudget(contextLength, maxTokens);

    try {
      const { maxToolIterations, historyLimit } = settings;
      // 人设服务按这个会话自己读它的设置（人设、额外提示、结构化输出的两个开关）
      const personaOpts: PersonaSessionOptions = { sessionId, platform };

      // 会话的深度思考档位：当前模型有这一档才带上；没设置、模型没有这一档或不能调时不带，由模型服务按它的默认档
      const level = settings.think;
      const thinking = llm.thinking?.levels.some(({ id }) => id === level) ? { think: level } : {};

      // 多方与否取根会话记下的聊天窗口，开轮时取一次：说明文字与焦点指引同一个出处
      const multiParty = originChatOf(sessionId, this.caps.sessionManager)?.multiParty === true;
      const built = await this.buildMessages(turn, inputs, historyLimit, acceptsImages, multiParty, personaOpts);
      const messages = built.messages;
      /** 会话历史的条数：这一轮开头的活跃条数（含没发给模型的），加本回合追加的工具调用、结果与插进来的输入 */
      let historyMessages = built.historyMessages;
      // 这个会话启用的工具分组：工具注册表按会话读它的设置，不在时没有工具
      const enabledGroups = this.caps.tools.present ? this.caps.tools.use.sessionGroups(sessionId, platform) : [];
      this.logger.debug(`工具分组: platform=${platform}, enabledGroups=${JSON.stringify(enabledGroups)}`);
      const tools =
        reportOnly || !this.caps.tools.present ? [] : this.caps.tools.use.getDefinitions({ groups: enabledGroups });
      /**
       * 一批工具调用的上下文，按这批开始那一刻已送进模型的输入构造：会话、发言者、参与者与入站回合由 originTurnOf 拼（字段语义
       * 见它与 ToolCallContext，owner 的各个身份按权限服务合成一个参与者）；入站回合只有这里填，工具据此正向区分真人消息与
       * 内部注入。叠进来的人从下一批起算，已执行的不追溯。续做取起它的那一轮的发言者只用在这里，归档与提示词贡献仍按输入本身的
       * userId
       */
      const toolContext = (): ToolCallRequest => ({
        ...originTurnOf(inputs.map(input => input.message) as [IncomingMessage, ...IncomingMessage[]], this.isOwner),
        // 恒为数组：没开分组时是 []（列举面本就等价于「只给无分组工具」），让执行面的分组闸总是生效
        enabledGroups,
        // 为 true 时本循环把 ToolExecutionResult.images 挂到 tool 消息交给主模型（出口由 prepareLLMMessages 编码）
        acceptsImages,
        // 回合中止信号：等审批期间这一轮被停下时，还没执行的工具不再执行
        signal,
        turnId,
      });

      // 保存原始完整工具列表，后续迭代均以此为基础（避免被 hooks 修改后丢失）
      const originalTools = [...tools];

      // Hook: agent:llm:before — 插件可以修改消息或工具列表
      const llmBeforeData = { messages, tools, acceptsImages, sessionId, platform, source: first.source };
      // 组装先于链：贡献块（档案/技能/记忆/即时提示）先物化，拦截者审完整成品
      await assemblePromptContributions(this.caps, llmBeforeData, inputs, {
        buildTimeoutMs: this.promptBuildTimeoutMs,
        signal,
      });
      await this.caps.hooks.use.run('agent:llm:before', llmBeforeData, undefined, { warnOnStall: true });
      if (reportOnly) {
        llmBeforeData.tools = [];
        // 这是结果汇报，不续跑历史工具链。保留人设与对话，去掉会诱发继续查任务的工具协议。
        llmBeforeData.messages = llmBeforeData.messages.filter(
          message =>
            message.role !== 'tool' &&
            !message.toolCalls?.length &&
            message.metadata?.injector !== WellKnownKinds.HostNotice,
        );
        // 放在钩子之后、消息末尾，确保裁剪仍保留本次结果及转述要求。
        llmBeforeData.messages.push({
          role: 'system',
          content:
            `[宿主通知]\n${first.content}${first.hostNotice?.untrusted ? `\n\n${first.hostNotice.untrusted}` : ''}\n\n` +
            '本轮只转述以上已确认的结果。沿用当前人设和回复格式，向当前会话自然地说明结果，保留通知中的链接；' +
            '不要调用工具、重新查询状态或继续执行，不把编号、内部流程当成回复正文，也不要编造通知里没有的细节。请给出非空回复。',
          metadata: { injector: WellKnownKinds.HostNotice },
        });
      }

      /**
       * 插入点（调用模型之前，组装与 agent:llm:before 之后、硬裁剪之前）：取这一轮待插入的输入，逐条归档、追加到消息末尾、挂上
       * 各自的图，再增量组装、重跑 agent:llm:before（插进来的图要经它规范化），然后再取，取空为止
       */
      const insertJoined = async (data: typeof llmBeforeData) => {
        for (let taken = this.queues.take(turn); taken.length > 0; taken = this.queues.take(turn)) {
          const joined: TurnInput[] = [];
          for (const message of taken) {
            joined.push({ message, archived: await this.archiveIncomingMessage(message, { turnId, entry: 'joined' }) });
            this.logRoute(message, '插入', turnId);
          }
          inputs.push(...joined);
          // 多方房间里插进被点名的：在它们之前另加一块列出至今被点名的各条，不改前面那块（之后各次请求仍以之前的为前缀）
          const focus = multiParty && joined.some(input => wasAddressed(input.message)) ? this.focusOf(inputs) : null;
          if (focus) data.messages.push(focus);
          for (const input of joined) data.messages.push(await this.inputMessage(input, acceptsImages));
          historyMessages += joined.length;
          await assemblePromptContributions(this.caps, data, inputs, {
            buildTimeoutMs: this.promptBuildTimeoutMs,
            signal,
          });
          await this.caps.hooks.use.run('agent:llm:before', data, undefined, { warnOnStall: true });
        }
      };
      await insertJoined(llmBeforeData);

      /** 本回合到目前为止经过了硬裁剪：首次调用的裁剪结果写回底稿，之后各次调用都在它上面追加 */
      let turnTrimmed = false;
      /** 首次调用的硬裁剪从底稿里去掉的历史与工具结果：之后各次调用按底稿估算没裁剪的量时补回 */
      let trimmedFromBase = 0;
      /**
       * 硬裁剪这次要发出的列表（按 buildMessages 交出的消息对象认出历史），删了消息时记一行日志；untrimmedHistory 按没经过
       * 硬裁剪的列表估算
       */
      const trimForCall = (list: Message[]) => {
        const sent = this.trimMessages(list, tokenBudget, built.history);
        if (sent.messages.length < list.length) {
          this.logger.info(`上下文硬裁剪: session=${sessionId}, ${list.length} → ${sent.messages.length} 条消息`);
        }
        turnTrimmed ||= sent.trimmed;
        return { messages: sent.messages, untrimmedHistory: estimateHistoryTokens(list) + trimmedFromBase };
      };

      // 裁剪消息以确保不超过上下文窗口；裁剪结果写回，作为之后各次调用的底稿
      const firstSent = trimForCall(llmBeforeData.messages);
      trimmedFromBase = firstSent.untrimmedHistory - estimateHistoryTokens(firstSent.messages);
      llmBeforeData.messages = firstSent.messages;

      // 每次模型调用之后发一次用量：拆分按这次发出的消息与工具定义估算，used 取模型服务返回的输入 token
      const reportUsage = (sent: ReturnType<typeof trimForCall>, sentTools: ToolDefinition[], response: ChatResponse) =>
        this.emitTokenUsage({
          sessionId,
          platform,
          turnId,
          contextWindow: contextLength,
          maxTokens,
          tokenBudget,
          messages: sent.messages,
          tools: sentTools,
          trimmed: turnTrimmed,
          untrimmedHistory: sent.untrimmedHistory,
          historyMessages,
          historyLimit,
          promptTokens: response.usage?.promptTokens,
        });

      this.logger.debug(
        `LLM 请求: ${llmBeforeData.messages.length} 条消息, ` +
          `${llmBeforeData.tools.length} 个工具, ` +
          `maxTokens=${maxTokens}`,
      );

      const t0 = Date.now();
      // 本轮累加的用量，用于最终 assistant 消息的 modelInfo 元数据。
      // 注：缓存命中量（usage.cachedPromptTokens）不进这里——本对象只喂
      // assistant 消息的 modelInfo，而其字段是逐个挑的（见下方 turnModelInfo），
      // 加进来也不会流到下游。命中率的观测出口是 LLM 响应日志那一行。
      const turnUsageAcc = { promptTokens: 0, completionTokens: 0 };
      const accUsage = (u: { promptTokens?: number; completionTokens?: number } | undefined) => {
        if (!u) return;
        // promptTokens 语义 = "生成这条回复时的上下文大小"。工具迭代循环里每轮都把同一份
        // （不断增长的）上下文重新发给模型，若累加会把重复发送的上下文重复计入，导致单条
        // 回复虚高到几十万 token。故取最后一次调用的 prompt（覆盖而非累加）= 回复定稿时的真实上下文。
        if (u.promptTokens != null) turnUsageAcc.promptTokens = u.promptTokens;
        // completionTokens 语义 = "本回合真正新生成的输出"（含中间 reasoning / tool-call 生成
        // 与最终回复文本），每次调用都是不重复的新输出，故逐次累加。
        turnUsageAcc.completionTokens += u.completionTokens ?? 0;
      };
      const firstResult = await this.consumeStream(
        llm,
        {
          messages: llmBeforeData.messages,
          tools: llmBeforeData.tools.length > 0 ? llmBeforeData.tools : undefined,
          maxTokens,
          signal,
          ...thinking,
        },
        turnId,
        sessionId,
        platform,
        !reportOnly,
      );
      await reportUsage(firstSent, llmBeforeData.tools, firstResult);
      accUsage(firstResult.usage);
      /** 这一次模型回复里各工具调用在生成进度里配好的 callId 与工具名，按调用的位置 */
      let generating = firstResult.generating;

      // 维护本轮（一次完整对话回合）的统一时间线 segments：
      // 多次 LLM 调用 + 工具执行的输出按到达顺序拼接，保留模型原本的"思考/回答/工具/思考/回答"交错。
      const turnSegments: ContentSegment[] = [...firstResult.segments];

      let response: ChatResponse = firstResult;

      this.debugLogResponse(response, Date.now() - t0);

      // Hook: agent:llm:after — 插件可以处理 LLM 返回结果
      const llmAfterData = { response, messages: llmBeforeData.messages };
      await this.caps.hooks.use.run('agent:llm:after', llmAfterData);
      response = llmAfterData.response;

      const assistantMetadata = this.buildAssistantMetadata(first, turnId);

      // 工具调用循环：上限没设即不限
      let iterations = 0;
      const withinLimit = () => maxToolIterations === undefined || iterations < maxToolIterations;
      while (!reportOnly && response.toolCalls && response.toolCalls.length > 0 && withinLimit()) {
        if (signal.aborted) throw new DOMException('Generation aborted', 'AbortError');
        iterations++;
        this.logger.debug(`工具调用迭代 ${iterations}: ${response.toolCalls.map(tc => tc.function.name).join(', ')}`);

        // 先解析各次调用的参数：解析不了的，写进本回合消息与存档的那次调用的 arguments 换成 {}（见 parseToolArguments）
        const parsedCalls = response.toolCalls.map(parseToolArguments);
        const toolCalls = parsedCalls.map(parsed => parsed.toolCall);

        // 将 assistant 消息 (含 toolCalls) 加入历史
        llmBeforeData.messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls,
          reasoningContent: response.reasoningContent,
          metadata: assistantMetadata,
        });

        const assistantToolMessage: Message = {
          role: 'assistant',
          content: response.content,
          toolCalls,
          reasoningContent: response.reasoningContent,
          metadata: assistantMetadata,
        };
        const toolMessages: Message[] = [];

        // 并行执行所有工具调用（互不依赖的工具无需串行等待）
        const toolResultMaxChars = Math.floor(contextLength * this.toolResultMaxRatio * 3.5);
        // 这一批的参与者按此刻已送进模型的输入算
        const toolCtx = toolContext();

        const parallelResults = await Promise.all(
          parsedCalls.map(async (parsed, position) => {
            const { toolCall } = parsed;
            // 这次调用的 id：开始与结束事件、工具上下文都带它。同一位置生成参数时报过同一个工具的进度，用那时配的
            // （会话里已有它的工具卡）；没报过的、或钩子改过调用列表而对不上的现在生成，免得接管画着别的工具的卡。
            // 自己生成而不用模型给的 toolCall.id——模型给的 id 不保证唯一（有的 provider 用毫秒时间戳加序号拼，并发的
            // 两轮会撞上），而 callId 要在全局配对开始与结束。模型的 id 只留在发回模型的 tool 消息里配对调用与结果。
            const generated = generating.get(position);
            const callId = generated?.name === toolCall.function.name ? generated.callId : crypto.randomUUID();
            // 会话里的工具卡跟着这一对事件走：没执行就失败的调用（参数不合法、执行前的钩子出错）同样发一对，
            // 结束带回给模型的错误，否则那张卡一直停在生成中
            const announce = (
              phase: 'start' | 'end',
              toolName: string,
              toolArgs: Record<string, unknown>,
              result?: string,
            ) =>
              this.caps.events.use.emit('tool:execute', {
                sessionId,
                turnId,
                callId,
                platform,
                toolName,
                args: toolArgs,
                phase,
                result,
              });
            if ('error' in parsed) {
              // 参数不是合法 JSON 对象：跳过本次执行，把错误当工具结果回给模型重新生成 arguments。
              // 不能按空参数执行：「无必填参数」的工具会真的空参跑一遍（副作用已发生，模型却不知情）。
              this.logger.warn(`工具参数解析失败: ${toolCall.function.name}: ${parsed.error}`);
              const failedAt = Date.now();
              const result = JSON.stringify({ error: parsed.error });
              await announce('start', toolCall.function.name, {});
              await announce('end', toolCall.function.name, {}, result);
              return {
                toolCall,
                callId,
                result,
                resultImages: undefined,
                toolName: toolCall.function.name,
                toolArgs: {},
                startTime: failedAt,
                endTime: failedAt,
              };
            }

            const callCtx: ToolCallRequest = { ...toolCtx, callId };
            // Hook: agent:tool:before — 插件可以拦截或修改工具调用
            const toolBeforeData = { name: toolCall.function.name, args: parsed.args, toolCallContext: callCtx };
            // 单个工具的链路异常（钩子 / 守卫 / 结果处理抛错）只算该工具失败，转成它自己的错误结果：
            // 整批照常落定、整组落库，兄弟工具已发生的副作用不会因连坐而从历史里消失。
            // executeDone 区分失败发生在执行前还是执行后——后者须明说「已执行」，免得模型重做有副作用的操作。
            let executeDone = false;
            let toolT0: number | undefined;
            try {
              await this.caps.hooks.use.run('agent:tool:before', toolBeforeData);

              // 通知平台：工具开始执行
              await announce('start', toolBeforeData.name, toolBeforeData.args);
              // 紧随 start 赋值：catch 据此判断 start 已发出
              toolT0 = Date.now();

              this.logger.debug(`工具执行: ${toolBeforeData.name} 参数=${formatToolArgsForLog(toolBeforeData.args)}`);
              const executed: ToolExecutionResult = await (this.caps.tools.present
                ? this.caps.tools.use.execute(toolBeforeData.name, toolBeforeData.args, callCtx)
                : Promise.resolve({ content: JSON.stringify({ error: 'tools 服务不可用' }) }));
              executeDone = true;
              let result = executed.content;
              // 工具交给主模型看的图：主模型能看图时才随本回合的 tool 消息走（出口由 prepareLLMMessages 编码），
              // 不能看时工具硬塞的也不交，模型只读文字结果；不进钩子/事件/时间线（那些面都是文本），
              // 也不落库（见 saveToolCallGroup）。
              const resultImages = acceptsImages ? executed.images : undefined;

              // Hook: agent:tool:after — 插件可以处理工具执行结果，写进 metadata 的随结果落库
              const toolAfterData = {
                name: toolBeforeData.name,
                result,
                toolCallContext: callCtx,
                metadata: {} as Record<string, unknown>,
              };
              await this.caps.hooks.use.run('agent:tool:after', toolAfterData);
              result = toolAfterData.result;

              // 工具结果截断：按上下文窗口比例限制单条工具结果长度
              if (result.length > toolResultMaxChars) {
                this.logger.info(
                  `工具结果过长 (${result.length} 字符)，截断至 ${toolResultMaxChars} 字符: ${toolBeforeData.name}`,
                );
                result = truncateChars(
                  result,
                  toolResultMaxChars,
                  `\n... [工具输出已截断，原始长度 ${result.length} 字符]`,
                );
              }
              const toolEndTime = Date.now();

              this.logger.debug(`工具完成: ${toolBeforeData.name} (${toolEndTime - toolT0}ms) 结果=${result}`);

              // 通知平台：工具执行完成
              await announce('end', toolBeforeData.name, toolBeforeData.args, result);

              return {
                toolCall,
                callId,
                result,
                resultImages,
                resultMetadata: toolAfterData.metadata,
                toolName: toolBeforeData.name,
                toolArgs: toolBeforeData.args,
                startTime: toolT0,
                endTime: toolEndTime,
              };
            } catch (err) {
              // 执行后的失败不回退到原始结果（fail-closed）：after 钩子可能是脱敏钩子，失败时原始输出不能漏给模型
              const reason = err instanceof Error ? err.message : String(err);
              this.logger.warn(
                `工具${executeDone ? '已执行，但结果处理' : '调用'}失败: ${toolBeforeData.name} (${reason})`,
              );
              const failedAt = Date.now();
              const result = JSON.stringify({
                error: executeDone ? `工具已执行，但结果处理失败：${reason}` : `工具调用失败：${reason}`,
              });
              // 执行前就失败的补发开始，再发配对的结束（emit 恒 resolve）
              if (toolT0 === undefined) await announce('start', toolBeforeData.name, toolBeforeData.args);
              await announce('end', toolBeforeData.name, toolBeforeData.args, result);
              return {
                toolCall,
                callId,
                result,
                resultImages: undefined,
                toolName: toolBeforeData.name,
                toolArgs: toolBeforeData.args,
                startTime: toolT0 ?? failedAt,
                endTime: failedAt,
              };
            }
          }),
        );

        // 工具交出的图只服务紧接着的这一次请求：上一轮工具结果里的图在这里剥掉，否则多轮
        // 工具迭代会让图片在上下文里累积（每张数百 token，且不受文本裁剪约束）。
        for (let i = 0; i < llmBeforeData.messages.length; i++) {
          const m = llmBeforeData.messages[i];
          if (m.role === 'tool' && m.images) {
            const { images: _spent, ...rest } = m;
            llmBeforeData.messages[i] = rest;
          }
        }

        // 按原始 toolCalls 顺序将结果推入消息列表 + 时间线
        for (const {
          toolCall,
          callId,
          result,
          resultImages,
          resultMetadata,
          toolName,
          toolArgs,
          startTime,
          endTime,
        } of parallelResults) {
          // callId 随工具结果与时间线落库：没回复就收尾的一轮只落工具调用组，历史里的工具卡靠它对回这次调用
          const toolMessage: Message = {
            role: 'tool',
            content: result,
            toolCallId: toolCall.id,
            ...(resultImages && resultImages.length > 0 ? { images: resultImages } : {}),
            metadata: {
              ...resultMetadata,
              [WellKnownMetadataKeys.TurnId]: turnId,
              [WellKnownMetadataKeys.CallId]: callId,
            },
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
            callId,
          });
        }
        historyMessages += 1 + toolMessages.length;

        await this.saveToolCallGroup(sessionId, assistantToolMessage, toolMessages);
        savedGroups = true;

        // 继续请求 LLM (再次经过 hooks)，使用原始完整工具列表而非被上一轮 hooks 修改过的列表
        const nextLlmData = {
          messages: llmBeforeData.messages,
          tools: [...originalTools],
          acceptsImages,
          sessionId,
          platform,
          source: first.source,
        };
        // 已物化的贡献按全局键跳过；本轮工具调用新注册的贡献（如新激活技能）增量落位
        await assemblePromptContributions(this.caps, nextLlmData, inputs, {
          buildTimeoutMs: this.promptBuildTimeoutMs,
          signal,
        });
        await this.caps.hooks.use.run('agent:llm:before', nextLlmData, undefined, { warnOnStall: true });
        await insertJoined(nextLlmData);

        // 裁剪消息以确保不超过上下文窗口
        const nextSent = trimForCall(nextLlmData.messages);
        nextLlmData.messages = nextSent.messages;

        const tN = Date.now();
        const nextResult = await this.consumeStream(
          llm,
          {
            messages: nextLlmData.messages,
            tools: nextLlmData.tools.length > 0 ? nextLlmData.tools : undefined,
            maxTokens,
            signal,
            ...thinking,
          },
          turnId,
          sessionId,
          platform,
        );
        await reportUsage(nextSent, nextLlmData.tools, nextResult);
        turnSegments.push(...nextResult.segments);
        response = nextResult;
        generating = nextResult.generating;
        accUsage(response.usage);

        this.debugLogResponse(response, Date.now() - tN, iterations);

        const nextLlmAfterData = { response, messages: nextLlmData.messages };
        await this.caps.hooks.use.run('agent:llm:after', nextLlmAfterData);
        response = nextLlmAfterData.response;
      }

      // 最后一次模型调用返回了最后的回复：这一轮不再收输入，还没插进去的转为排队
      this.queues.close(turn);

      // 检测是否因工具调用次数达到上限而退出循环
      const toolLimitReached = !withinLimit() && response.toolCalls != null && response.toolCalls.length > 0;
      if (toolLimitReached) {
        this.logger.warn(`工具调用达到上限 (${maxToolIterations})，session=${sessionId}`);
      }

      // 保留原始 LLM 输出：没有中间件改写落库内容时，落库的就是它
      let rawLlmContent = response.content ?? '';
      let replyContent = rawLlmContent;

      // Hook: agent:reply:before — 插件可以修改最终回复
      // JSON 解析/修复统一由 persona 的 agent:reply:before 钩子处理
      const responseData: HookContextMap['agent:reply:before'] = {
        content: replyContent,
        sessionId,
        platform,
        attempt: 0,
      };
      const validateReply = async (): Promise<void> => {
        const attemptedTools = reportOnly && !!response.toolCalls?.length;
        if (attemptedTools) responseData.content = '';
        await this.caps.hooks.use.run('agent:reply:before', responseData);
        // 误调用工具或静默先给模型一次纠正机会，复用格式重试预算，不能无限尝试或执行工具。
        const replyLinks: string[] = reportOnly ? (responseData.content.match(NOTICE_URL) ?? []) : [];
        const missingLink = noticeLinks.some(
          link => !replyLinks.some(candidate => candidate === link || candidate.replace(/[.!;:]+$/u, '') === link),
        );
        if (reportOnly && (attemptedTools || !responseData.content.trim() || missingLink)) {
          responseData.content = '';
          responseData.maxRetries = Math.max(1, responseData.maxRetries ?? 0);
          responseData.retryRequested = true;
          responseData.retryFeedback =
            `${responseData.retryFeedback ?? ''}\n本轮只需转述已给出的宿主结果，不要调用工具或查询状态。` +
            '请沿用当前人设和规定的回复格式，给出包含结果与已有链接的非空回复。';
        }
      };
      await validateReply();

      // 重试循环：当 hook（如 persona 的 outputFormat 解析）报告 retryRequested 时，
      // 把失败的 assistant 输出 + 系统反馈追加到消息列表，重新请求 LLM；最多按 maxRetries 次。
      // maxRetries 由 hook 端写入（plugin-persona 从 outputFormat.retries 读取，默认 1）。
      // 上游吐空流同样会被判不合格：此时没有可回放的失败输出，只追加系统反馈再请求一次。
      const maxRetries = Math.max(0, responseData.maxRetries ?? 0);
      let attempt = 0;
      while (responseData.retryRequested && attempt < maxRetries) {
        attempt++;
        this.logger.debug(
          `agent:reply:before 请求重试 (attempt=${attempt}/${maxRetries}, session=${sessionId}): ${responseData.retryFeedback ?? '(无反馈)'}`,
        );
        if (rawLlmContent.length > 0) llmBeforeData.messages.push({ role: 'assistant', content: rawLlmContent });
        llmBeforeData.messages.push({
          role: 'system',
          content: responseData.retryFeedback ?? '上一次回复未能通过格式校验，请严格按照系统提示中规定的格式重新输出。',
        });
        const retrySent = trimForCall(llmBeforeData.messages);
        const retryResult = await this.consumeStream(
          llm,
          {
            messages: retrySent.messages,
            tools: undefined,
            maxTokens,
            signal,
            ...thinking,
          },
          turnId,
          sessionId,
          platform,
          !reportOnly,
        );
        await reportUsage(retrySent, [], retryResult);
        turnSegments.push(...retryResult.segments);
        response = retryResult;
        accUsage(response.usage);
        rawLlmContent = response.content ?? '';

        // 用新输出再次跑 hook；hook 端根据 attempt 决定继续重试或走兜底（静默丢弃）
        responseData.content = rawLlmContent;
        responseData.archiveContent = undefined;
        responseData.visibleContent = undefined;
        responseData.retryRequested = false;
        responseData.retryFeedback = undefined;
        responseData.attempt = attempt;
        await validateReply();
      }

      // 双保险：循环结束后若 hook 仍标记 retryRequested（理论上 persona 已在用尽时自动走兜底），
      // 强制把 content 置空，避免原始未校验内容被外发。
      if (responseData.retryRequested) {
        this.logger.warn(
          `agent:reply:before 重试用尽但 retryRequested 仍为 true，强制丢弃回复内容 (session=${sessionId})`,
        );
        responseData.content = '';
        responseData.retryRequested = false;
      }

      replyContent = responseData.content;
      const archiveContent = responseData.archiveContent ?? rawLlmContent;
      const visibleContent = responseData.visibleContent ?? replyContent;

      // 提交点：此后的流结束标记、落库与外发成组执行。流结束后到这里之间（llm:after / 工具循环退出 /
      // reply:before / 重试）被停下的回合（停止键、禁言、停机等），走下方 AbortError 收尾，不落库、不外发。
      if (signal.aborted) throw new DOMException('Generation aborted', 'AbortError');

      // 发出流结束标记
      await this.caps.events.use.emit('outbound:stream', {
        sessionId,
        turnId,
        platform,
        done: true,
        toolLimitReached,
      });

      // 空回复（outputFormat 中 reply 字段为空字符串或仅空白）时静默，不发送消息
      if (replyContent.trim().length === 0) {
        this.logger.debug(`空回复，跳过发送 (session=${sessionId})`);
      } else {
        const visibleSegments = !reportOnly && turnSegments.length > 0 ? turnSegments : undefined;

        // 在 assistant 最终持久化时记录 modelInfo：前端从消息历史可还原 "这条回复
        // 由哪个 model 生成、用了多少 token"，方便用户验证模型切换是否生效。
        const turnModelInfo = {
          provider: llm.providerId,
          model: llm.id,
          promptTokens: turnUsageAcc.promptTokens || undefined,
          completionTokens: turnUsageAcc.completionTokens || undefined,
        };
        const finalAssistantMetadata: Record<string, unknown> = {
          ...(assistantMetadata ?? {}),
          [WellKnownMetadataKeys.ModelInfo]: turnModelInfo,
          [WellKnownMetadataKeys.TurnRecord]: recordOf('replied'),
        };
        // 落库的是信封（如 outputFormat 的整串 JSON）时，另带解码后的可见正文，供检索、摘要等按语义读历史的一方用
        if (visibleContent !== archiveContent) {
          finalAssistantMetadata[WellKnownMetadataKeys.VisibleContent] = visibleContent;
        }

        // 保存最终 assistant 回复：落库存信封原文，交给模型的历史取可见正文（historyForModel）
        await this.saveToMemory(sessionId, {
          role: 'assistant',
          content: archiveContent,
          reasoningContent: reportOnly ? undefined : response.reasoningContent,
          timestamp: Date.now(),
          metadata: finalAssistantMetadata,
          segments: visibleSegments,
        });
        recorded = true;

        // 外发给平台：只带正文与这条回复的模型和 token，思考与时间线只在上面落库的消息上；
        // 正文是她写的，其中的 @、媒体与引用标记交适配器解析
        await this.dispatchOutbound({
          content: replyContent,
          sessionId,
          platform,
          ...(first.hostNotice ? { hostNotice: { kind: first.hostNotice.kind, id: first.hostNotice.id } } : {}),
          ...(first.hostNotice?.replyTo ? { replyTo: first.hostNotice.replyTo } : {}),
          markup: true,
          source: 'agent',
          turnId,
          modelInfo: turnModelInfo,
        });
      }

      // Hook: agent:turn:after — 插件可以在完整消息周期结束后做后处理；在 try 里等它，它的中间件出错同样按出错收尾
      return await end(replyContent.trim().length === 0 ? 'silent' : 'replied', { reply: replyContent });
    } catch (err) {
      // 中止错误 — 静默退出，前端通过 outbound:stream done 清理 buffer。
      //
      // 被停下的一轮里已完成的工具调用组留在历史里，不回滚：saveToolCallGroup 只在并行工具全部落定后整组写入（单个工具的
      // 异常已在闭包内转成它自己的错误结果），不存在写了一半的组，留下的只可能是「已落定、副作用已发生」的工具调用对；删掉
      // 它们等于让 agent 忘记自己刚做过的有副作用的事（戳一戳、发送消息、调度任务等），下一轮会重复调用。不完整的组
      // （assistant tool_calls 缺 tool result）由 sanitizeToolCallHistory 在装载历史时兜底过滤。
      if (err instanceof DOMException && err.name === 'AbortError') {
        await this.caps.events.use.emit('outbound:stream', { sessionId, turnId, platform, done: true });

        // 中止同样是回合终态：发 agent:turn:after(outcome=aborted) 让生命周期订阅方收尾——
        // 编排的 agent 节点在等这一轮的结果，不发它就要等到超时才失败。
        return end('aborted');
      }

      const error = textOf(err);
      this.logger.error(`处理消息失败: ${toSource(error)}`);

      // 异常同样要结束流：不发 done，会话里流式输出的条目不结束。顺序与正常收尾一致——先 done 再发消息。
      await this.caps.events.use.emit('outbound:stream', { sessionId, turnId, platform, done: true });
      if (!reportOnly) {
        const text = t('turnError', { error });
        await this.dispatchOutbound({ content: toSource(text), text, sessionId, platform, source: 'system', turnId });
      }

      // 异常也是回合终态：同样发 turn:after(outcome=error)，等这一轮结果的订阅方才收得了尾。
      return end('error', { error });
    }
  }

  /**
   * 构建发送给 LLM 的消息列表。历史按会话的条数线成段丢弃（见 readHistory）：historyLimit 为 0 或没设置时发全部活跃历史，
   * 跳过这一轮各条输入的归档。historyMessages 是会话活跃历史里对话消息的条数（事件标记不算；含已归档的这一轮的输入与没发给
   * 模型的部分），与之后的清洗、裁剪无关；history 是发出的历史那一段的消息对象，硬裁剪按它认出历史。历史之后依次是易变块、
   * 由排着的真人消息开的一轮的说明、多方房间里有被点名的输入时的焦点指引、各条输入。acceptsImages 是这一轮的主模型能不能看图，
   * media 缺席时由它定当轮的图交不交
   */
  private async buildMessages(
    turn: Turn,
    inputs: readonly TurnInput[],
    historyLimit: number | undefined,
    acceptsImages: boolean,
    multiParty: boolean,
    personaOpts: PersonaSessionOptions,
  ): Promise<{ messages: Message[]; historyMessages: number; history: ReadonlySet<Message> }> {
    const messages: Message[] = [];
    let historyMessages = 0;
    const { sessionId } = turn;

    // 1. 系统提示
    const systemPrompt = this.buildSystemPrompt(personaOpts);
    messages.push({ role: 'system', content: systemPrompt, metadata: { injector: 'persona' } });

    // 2. 历史消息：跳过这一轮已归档的输入
    try {
      const archived = inputs.flatMap(input => (input.archived ? [input.archived] : []));
      const past = await this.modelHistory(sessionId, historyLimit, archived);
      historyMessages = past.count;
      if (past.dropped > 0) {
        this.logger.warn(`历史消息中发现不完整工具调用组，已跳过 ${past.dropped} 条 (session=${sessionId})`);
      }
      messages.push(...past.messages);
    } catch (err) {
      this.logger.warn('获取历史消息失败:', err);
    }
    const history = new Set(messages.slice(1));

    // 3. 这一轮的输入。带来源的注入各自成一轮，宿主通知与委派只有这一条
    const first = inputs[0].message;

    // 宿主通知分支：宿主撰写的事件通知不是任何人的发言，与 proactive 一样以 system 呈现、
    // 不推当前 user 消息与易变块。不可信段只在当轮接在宿主正文之后（归档只留正文），
    // 之后的回合从历史里只看得到宿主正文。
    if (first.hostNotice) {
      const { untrusted } = first.hostNotice;
      messages.push({
        role: 'system',
        content: `[宿主通知]\n${first.content}${untrusted ? `\n\n${untrusted}` : ''}`,
        metadata: { injector: WellKnownKinds.HostNotice },
      });
      return { messages, historyMessages, history };
    }

    // 3a. proactive 分支：系统代发给本会话的任务指令（如 workflow 的 agent 节点）
    //
    // 这条消息不是用户请求，必须作为 system 指令呈现给 LLM，否则 agent 会把它当成
    // 真实用户在指挥（典型 BUG：agent 看到 user 角色的任务指令，回复时使用「您」
    // 「您好」等措辞，把派发方当成了用户）。
    if (first.triggerType === 'proactive') {
      messages.push({
        role: 'system',
        content:
          `[跨会话委派 — 非用户消息]\n` +
          `任务: ${first.content}\n\n` +
          `说明: 这是你（作为同一 agent 在另一会话的实例）派发给本会话的任务指令，` +
          `不是用户请求。处理时不要使用「您」「请问」等面向用户的措辞，按指令直接执行并简明回报结果。\n`,
        metadata: { injector: WellKnownKinds.CrossSessionDelegation },
      });
      return { messages, historyMessages, history };
    }

    // 3b. 普通用户消息分支
    // 本轮附件有描述正文（媒体识别的描述、文件说明）时，引导 LLM 综合作答而非逐项转述
    if (inputs.some(input => hasAttachmentDescriptions(input.message))) {
      messages.push({
        role: 'system',
        content:
          '用户消息中包含系统预处理的附件描述（图片识别结果和/或文件内容提取）。' +
          '请将这些信息作为参考上下文，结合用户的文字，给出一个自然、连贯的统一回复。' +
          '不要将分析结果逐项列出或分成单独的字段，直接在回复中融合所有信息。',
        metadata: { injector: 'system-other' },
      });
    }

    // 易变上下文（当前时间 / 会话环境 / 上一轮状态）落在历史**之后**：
    // provider 的前缀缓存从第一个 token 起逐位比对，这几块原本混在人设卡开头，
    // 秒级时间戳一变，人设 + 记忆 + 历史近 7 万 token 的前缀全部作废——实测每个
    // 新回合命中率恒为 0，只有同回合内的工具迭代（prompt 不重建）才命中。
    // 放到这里语义也更顺：它们本就是「此刻的事实」，紧挨当前消息说更自然。
    const persona = this.caps.persona.present ? this.caps.persona.use : undefined;
    const volatileCtx = persona?.getVolatilePrompt?.(personaOpts);
    if (volatileCtx) {
      messages.push({ role: 'system', content: volatileCtx, metadata: { injector: VOLATILE_INJECTOR } });
    }

    // 由排着的真人消息开的一轮：说明它们是上一轮进行期间到的；多方房间里全是没点名她的插话时，没有要接的可以不说话
    if (turn.queued && turn.human) messages.push(queuedNote(multiParty && !turn.batch.some(wasAddressed)));

    // 群聊焦点指引：多方房间里有被点名的输入时，紧贴在这一轮的输入之前，逐条列出被点名的那几条
    const focus = multiParty ? this.focusOf(inputs) : null;
    if (focus) messages.push(focus);

    for (const input of inputs) messages.push(await this.inputMessage(input, acceptsImages));

    return { messages, historyMessages, history };
  }

  /**
   * 一条输入发给模型的写法：`(时间) <归档正文>`。正文由 message-archive 烘焙（发送者前缀、引用回复、附件描述）；存档不在时
   * 按同一份拼法与同一条说话人规则自己拼（schema-message 的 buildIncomingContent、api-message-archive 的 speakerOf）。时间取
   * 归档时间戳，即进入这一轮的时刻：之后进历史时是同一个标注，前缀不变。带图的挂上它自己的图。空闲开话题的提示以 system 交出
   */
  private async inputMessage({ message, archived }: TurnInput, acceptsImages: boolean): Promise<Message> {
    const body = archived?.content ?? buildIncomingContent(message, this.speakerOf(message));
    const at = archived?.timestamp ?? Date.now();
    const content = `(${formatTimeLabel(at, Date.now())}) ${body}`;
    // 空闲提示是宿主写给模型的指令，不是谁的发言：标成本轮的指令块，锚位、裁剪与 DeepSeek 的 system 归位都按它认
    if (message.triggerType === 'idle') {
      return { role: 'system', content, metadata: { injector: WellKnownKinds.IdlePrompt } };
    }
    const userMessage: Message = {
      role: 'user',
      content,
      name: getMessageName(message.userId),
      timestamp: at,
    };

    // 多模态：把 attachments 中的 image 项传递给 LLM（视觉模型多模态字段）
    const imageAtts = message.attachments?.filter(a => a.kind === 'image') ?? [];
    if (imageAtts.length > 0) {
      if (this.caps.media.present) {
        // media 在场：原样透传。出口形态由 media 的 agent:llm:before 中间件规范化
        //（describe 剥离 / passthrough 物化），此处不做任何转换——它的描述缓存键与
        // 动图提示都按 attachment.data 原串命中，改形态会打散。
        userMessage.images = imageAtts.map(a => a.data);
      } else if (acceptsImages) {
        // media 缺席兜底（主模型不能看图时当轮的图不交，正文里的占位照旧）：存储地址（适配器落盘的附件引用）provider 解不了（当 base64 校验，整轮请求被拒，见
        // test/plugins/media-model-images.test.ts 抬头的 400 事故），经 storage 读出转 data URI，保住「视觉主模型
        // 直通」的基础体验；读不出（storage 缺席/读失败）就丢弃该图。其余形态（data URI、http(s)、file:// 等）原样
        // 透传，与 media 出现之前的行为一致，各 provider 按自己的解析器处置。
        const images: string[] = [];
        for (const a of imageAtts) {
          const img = await this.materializeImageWithoutMedia(a.data, a.mimeType);
          if (img) images.push(img);
          else this.logger.debug(`media 缺席且本地图片附件读取失败，跳过: ${a.data.slice(0, 80)}`);
        }
        if (images.length > 0) userMessage.images = images;
      }
    }
    return userMessage;
  }

  /** 一条输入的说话人：与存档的发送者前缀同一条规则（api-message-archive 的 speakerOf） */
  private speakerOf(message: IncomingMessage): Pick<IncomingMessage, 'nickname' | 'userId'> | undefined {
    return speakerOf(message, {
      sessionManager: this.caps.sessionManager.present ? this.caps.sessionManager.use : undefined,
      authority: this.caps.authority.present ? this.caps.authority.use : undefined,
    });
  }

  /** 停下标记里停下的人的称呼：与发送者前缀同一条规则，当他在这个会话里说了一句话；没有停下的人时没有 */
  private stopperLabel(sessionId: string, by: StoppedBy | undefined): string | undefined {
    const speaker = by && this.speakerOf({ content: '', sessionId, platform: by.platform, userId: by.userId });
    return getSenderLabel(speaker?.nickname, speaker?.userId);
  }

  /**
   * 这一轮被点名的输入的焦点指引：按时间与发送者账号逐条列出（名字由各条正文的发送者前缀给，群友自己设的名字不进系统消息）；
   * 没有被点名的为 null
   */
  private focusOf(inputs: readonly TurnInput[]): Message | null {
    return buildFocusGuidance(
      inputs.flatMap(({ message, archived }) => {
        if (!wasAddressed(message)) return [];
        const time = formatTimeLabel(archived?.timestamp ?? Date.now(), Date.now());
        return [message.userId ? `(${time}) ${message.userId}` : `(${time})`];
      }),
    );
  }

  /**
   * 裁剪预算 = 上下文长度 × trimThresholdRatio − 最大输出 token − 512 安全余量（下限 1024）。
   * trimThresholdRatio < 1 可提前触发裁剪，默认 1.0 = 用满扣除输出预留后的可用窗口。
   * 真实回合与 token:request 快照共用，两处的预算口径因此一致。
   */
  private computeTokenBudget(contextLength: number, maxTokens: number): number {
    return Math.max(1024, Math.floor(contextLength * this.trimThresholdRatio) - maxTokens - 512);
  }

  /**
   * 构建系统提示词
   */
  private buildSystemPrompt(personaOpts?: PersonaSessionOptions): string {
    const persona = this.caps.persona.present ? this.caps.persona.use : undefined;
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
   * 发 token:usage：各维度的拆分按消息与工具定义估算，used 取模型服务返回的输入 token，没有时取估算。
   * 等全部监听者处理完才返回：摘要插件在回合结束时按这一轮最后一条用量判定，不能让它晚于回合结束
   */
  private async emitTokenUsage({
    sessionId,
    platform,
    turnId,
    contextWindow,
    maxTokens,
    tokenBudget,
    messages,
    tools,
    trimmed,
    untrimmedHistory,
    historyMessages,
    historyLimit,
    promptTokens,
  }: UsageReport): Promise<void> {
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
    const injectorTokens: Record<string, number> = {};

    for (const msg of messages) {
      const t = estimateMsgTokens(msg);
      if (msg.role === 'system') {
        // 贡献点物化块的 injector 是全局键 `${贡献方实例 id}/${局部标签}`（实例 id 含 '/'），
        // 归桶按局部标签（末段）匹配——桶规则与统计明细键保持迁移前的稳定值；
        // 非贡献来源（persona / system-other 等）无 '/'，末段即原值，不受影响。
        const rawSource = msg.metadata?.injector as string | undefined;
        const source = rawSource?.slice(rawSource.lastIndexOf('/') + 1);
        const contributions = msg.metadata?._tokenContributions as Record<string, number> | undefined;

        if (source === 'memory-summary') {
          memorySummaryTokens += t;
        } else if (source === 'memory-vector') {
          memoryVectorTokens += t;
        } else if (source?.startsWith('platform')) {
          platformTokens += t;
        } else if (source === 'skills-discovery' || source?.startsWith('skills-activation')) {
          skillsTokens += t;
        } else if (source === 'system-other') {
          systemOtherTokens += t;
        } else if (source === 'parent-status') {
          // subtask 父会话状态提醒（injector 'subtask/parent-status'）——归 subtask 桶，
          // 与子会话侧 _tokenContributions.subtask 同桶，WebUI 才能看到父+子全貌
          subtaskTokens += t;
        } else if (source === 'persona' || !source) {
          // persona 消息可能被 subtask 追加内容
          if (contributions) {
            let contributionTokens = 0;
            for (const [key, charCount] of Object.entries(contributions)) {
              const ct = estimateTextTokens('x'.repeat(charCount as number));
              if (key === 'subtask') subtaskTokens += ct;
              else systemOtherTokens += ct;
              contributionTokens += ct;
            }
            personaTokens += Math.max(0, t - contributionTokens);
          } else {
            personaTokens += t;
          }
        } else if (rawSource) {
          // 其余注入者(memory-history/user-profile/user-relation/自定义插件等):
          // 计入 systemOther 汇总之余按全局键点名,预算争抢时能看出是谁在吃;界面按键里的实例前缀合并到插件
          systemOtherTokens += t;
          injectorTokens[rawSource] = (injectorTokens[rawSource] ?? 0) + t;
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
    // 服务商回的数没人核过：不是正的有限数（缺省、0、NaN）时按估算，一次调用的输入不会是 0 token
    const used =
      promptTokens !== undefined && promptTokens > 0 && Number.isFinite(promptTokens)
        ? promptTokens
        : systemTokens + historyTokens + toolResultTokens + toolDefsTokens;
    const usageRatio = contextWindow > 0 ? used / contextWindow : 0;

    await this.caps.events.use.emit('token:usage', {
      sessionId,
      turnId,
      platform,
      contextWindow,
      maxTokens,
      tokenBudget,
      used,
      usageRatio,
      trimmed,
      untrimmedHistory,
      historyMessages,
      historyLimit,
      breakdown: {
        system: systemTokens,
        persona: personaTokens,
        memorySummary: memorySummaryTokens,
        memoryVector: memoryVectorTokens,
        skills: skillsTokens,
        platform: platformTokens,
        subtask: subtaskTokens,
        systemOther: systemOtherTokens,
        injectors: injectorTokens,
        history: historyTokens,
        toolResults: toolResultTokens,
        toolDefs: toolDefsTokens,
        reservedForReply: maxTokens,
      },
      parts: [
        { label: t('partHistory'), tokens: historyTokens },
        { label: t('partToolResults'), tokens: toolResultTokens },
        { label: t('partToolDefs'), tokens: toolDefsTokens },
        { label: t('partPersona'), tokens: personaTokens },
        { label: t('partMemorySummary'), tokens: memorySummaryTokens },
        { label: t('partMemoryVector'), tokens: memoryVectorTokens },
        { label: t('partSkills'), tokens: skillsTokens },
        { label: t('partPlatform'), tokens: platformTokens },
        { label: t('partSubtask'), tokens: subtaskTokens },
        { label: t('partSystemOther'), tokens: systemOtherTokens, injectors: injectorTokens },
      ],
    });

    // 节流日志：与 WebUI 看到的同一份数据，让 CLI / 文件日志使用者也能看见预算消耗。
    // 跨过 0.5 / 0.7 / 0.85 阈值必输出，否则每 10 轮一次。
    const bucket = usageRatio >= 0.85 ? 3 : usageRatio >= 0.7 ? 2 : usageRatio >= 0.5 ? 1 : 0;
    const st = this.tokenLogState.get(sessionId) ?? { count: 0, lastRatioBucket: -1 };
    st.count++;
    const crossedBucket = bucket !== st.lastRatioBucket;
    if (crossedBucket || st.count % 10 === 1) {
      const tag = bucket >= 3 ? 'CRITICAL' : bucket >= 2 ? 'WARN' : bucket >= 1 ? 'INFO' : 'OK';
      this.logger.info(
        `[token-usage:${tag}] ${sessionId} ${used}/${contextWindow} (${(usageRatio * 100).toFixed(1)}%) ` +
          `sys=${systemTokens}(persona=${personaTokens} mem=${memorySummaryTokens + memoryVectorTokens} ` +
          `skills=${skillsTokens} subtask=${subtaskTokens} other=${systemOtherTokens}) ` +
          `hist=${historyTokens} tools=${toolResultTokens}+${toolDefsTokens}def reserve=${maxTokens}`,
      );
    }
    st.lastRatioBucket = bucket;
    this.tokenLogState.set(sessionId, st);
  }

  /**
   * media 缺席时的图片物化兜底（仅 buildMessages 的 images 拷贝点使用）。
   * 只翻译存储地址（适配器落盘的附件引用）：provider 当 base64 校验 → 400 整轮被拒，经 storage 读出转 data URI；
   * storage 缺席/读失败返回 null 由调用方丢弃该图。**其余形态原样透传**（data URI、http(s)、file:// 等，各 provider
   * 自行解析），维持 media 出现之前的既有行为。
   */
  private async materializeImageWithoutMedia(data: string, mimeType?: string): Promise<string | null> {
    const t = data.trim();
    if (!isStorageUri(t)) return t;
    // storage 按 URI 的根名路由；根不认识（含 storage 整体缺席）时抛错，落到下面的 catch
    const storage = this.caps.storage.use;
    try {
      const raw = (await storage.readFile(t)) as Uint8Array;
      // mime 优先取附件自带的 mimeType；缺省按 basename 扩展名推断（适配器落盘的扩展名取文件头判定的格式）
      const base = t.slice(t.lastIndexOf('/') + 1);
      const dot = base.lastIndexOf('.');
      const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
      const mime =
        mimeType ??
        (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg');
      return `data:${mime};base64,${Buffer.from(raw).toString('base64')}`;
    } catch {
      return null;
    }
  }

  /**
   * 硬裁剪这次要发出的列表，使估算回到预算内；trimmed 报告进入了硬裁剪：入口估算超过了预算（不一定真裁掉了内容），或历史超过
   * 它的可用量、丢了一段。不记日志：token:request 的快照同样走这里，删了消息的日志由真实回合的调用点记。没改动的消息原样交出
   * （同一个对象：首次调用的结果写回底稿之后，history 照样认得出历史），改动的换成副本。
   *
   * 列表分三段：头部（第一条非 system 之前：人设、技能、摘要等；属于历史的 system 消息不算）、历史（history 里的消息对象，即
   * 读出、清洗后发出的那段）、本轮（其余：易变块、本轮材料与提示、本轮的输入、本轮追加的工具调用与结果）。依次裁，第 1 步总做，
   * 之后任一步回到预算内即停：
   *  1. 历史按 token 成段丢：单位 U = ⌈预算 / 4⌉，历史可用 H = 预算 − 头部 − U（本轮固定留一个单位）；历史超过 H 时（不看本轮
   *     多大）从第一条起丢到累计第一次达到 ⌈(历史 − H) / U⌉·U 的那一条，切点落在工具调用组中间时组里剩下的结果一起丢（对齐同
   *     readHistory）。切点只由头部与历史定：头部两次压缩之间不变、历史只追加，切点只在历史跨过一个单位时前移，两次丢弃之间
   *     发出的开头逐字不变，前缀缓存才命中
   *  2. 只动本轮追加的：截短过长的工具结果、缩推理内容、把较早的工具调用组压成摘要。历史里的不动（会改开头），超了按第 1 步
   *     整段丢
   *  3. 本轮超过一个单位时仍超：历史接着按同一套单位往后丢，丢到累计第一次达到下一个单位整数倍的那一条（本轮在同一个单位内
   *     变大时切点不动）或丢完；会改开头
   *  4. 会改开头：注入的 system 块合计超过 memoryTokenBudget 时按比例缩，仍超时从最靠前的删起
   *  5. 最后手段：最后一组工具调用也截短过长的结果、缩推理内容，请求不超窗发出
   * 始终不动：首条 system、本轮的输入（user 消息，与宿主通知、委派、空闲开话题那一轮的指令块）。不删不压、只在第 5 步截短：
   * 最后一组工具调用、末条消息（格式重试的反馈）
   */
  private trimMessages(messages: Message[], budget: number, history: ReadonlySet<Message>): TrimmedMessages {
    let result = [...messages];
    let estimated = this.estimateTokens(result);
    const over = estimated > budget;
    const directive = (m: Message) => DIRECTIVE_KINDS.includes(String(m.metadata?.injector));

    // === 1. 历史按 token 成段丢 ===
    const unit = Math.ceil(budget / 4);
    /** 丢到不少于 tokens 的下一个单位整数倍 */
    const onGrid = (tokens: number) => Math.ceil(tokens / unit) * unit;
    let head = 0;
    for (const m of result) {
      if (m.role !== 'system') break;
      if (!history.has(m)) head += estimateMsgTokens(m);
    }
    const past = result.filter(m => history.has(m));
    let cut = 0;
    let dropped = 0;
    /** 从历史开头起丢到累计估算达到 tokens 的那一条（含）；切点落在工具调用组中间时，组里剩下的结果一起丢 */
    const dropPast = (tokens: number) => {
      const from = cut;
      const before = dropped;
      while (cut < past.length && dropped < tokens) dropped += estimateMsgTokens(past[cut++]);
      while (cut < past.length && past[cut].role === 'tool') dropped += estimateMsgTokens(past[cut++]);
      const gone = new Set(past.slice(from, cut));
      result = result.filter(m => !gone.has(m));
      estimated -= dropped - before;
    };
    const room = budget - head - unit;
    const pastTokens = past.reduce((sum, m) => sum + estimateMsgTokens(m), 0);
    if (pastTokens > room) dropPast(onGrid(pastTokens - room));
    if (estimated <= budget) return { messages: result, trimmed: over || cut > 0 };

    // === 2. 只动本轮追加的，最后一组工具调用（本轮最后一条带调用的 assistant 与紧跟的结果）不动 ===
    const last = new Set<Message>();
    for (let i = result.length - 1; i >= 0; i--) {
      if (history.has(result[i]) || !result[i].toolCalls?.length) continue;
      for (let j = i; j < result.length && (j === i || result[j].role === 'tool'); j++) last.add(result[j]);
      break;
    }
    const appended = (m: Message) => !history.has(m) && !last.has(m);
    /** 截短 pick 选中的过长工具结果（1500 字以上的留 500） */
    const shortenResults = (pick: (m: Message) => boolean) => {
      for (let i = 0; i < result.length && estimated > budget; i++) {
        const m = result[i];
        if (m.role !== 'tool' || !pick(m) || !m.content || m.content.length <= 1500) continue;
        const shorter = { ...m, content: truncateChars(m.content, 500, '\n... [工具输出已截断]') };
        estimated -= estimateMsgTokens(m) - estimateMsgTokens(shorter);
        result[i] = shorter;
      }
    };
    /**
     * 缩 pick 选中的推理内容：从旧到新，旧的留 200 字，最新一条留 400。DeepSeek 思考模式要求历史中凡有 reasoning_content 的消息
     * 原样带回这个字段，设成 undefined 会被拒（400），所以只截断、不删除
     */
    const shrinkReasoning = (pick: (m: Message) => boolean) => {
      const reasoned = result.flatMap((m, i) =>
        m.role === 'assistant' && pick(m) && (m.reasoningContent?.length ?? 0) > 200 ? [i] : [],
      );
      for (let k = 0; k < reasoned.length && estimated > budget; k++) {
        const m = result[reasoned[k]];
        const keep = k < reasoned.length - 1 ? 200 : 400;
        const shorter = {
          ...m,
          reasoningContent: truncateChars(m.reasoningContent ?? '', keep, '\n... [推理内容已缩减]'),
        };
        estimated -= estimateMsgTokens(m) - estimateMsgTokens(shorter);
        result[reasoned[k]] = shorter;
      }
    };

    shortenResults(appended);
    shrinkReasoning(appended);
    // 较早的工具调用组从最旧的起压成一条摘要（确实省 token 时）
    for (let i = 0; i < result.length && estimated > budget; i++) {
      const call = result[i];
      if (call.role !== 'assistant' || !call.toolCalls?.length || !appended(call)) continue;
      let end = i + 1;
      while (end < result.length && result[end].role === 'tool') end++;
      const outputs = result.slice(i + 1, end);
      const before = [call, ...outputs].reduce((sum, m) => sum + estimateMsgTokens(m), 0);
      const previews = outputs.map(({ content }) => {
        const output = content ?? '';
        return output.length > 100 ? `${output.slice(0, 100)}...` : output;
      });
      const parts = call.toolCalls.map((tc, idx) => `${tc.function.name} → ${previews[idx] ?? '(无结果)'}`);
      const text = `[历史工具调用] ${parts.join(' | ')}`;
      const summary: Message = { role: 'assistant', content: call.content ? `${call.content}\n${text}` : text };
      const after = estimateMsgTokens(summary);
      if (after < before) {
        result.splice(i, end - i, summary);
        estimated -= before - after;
      }
    }
    if (estimated <= budget) return { messages: result, trimmed: true };

    // === 3. 本轮超过一个单位：历史接着按单位丢 ===
    dropPast(onGrid(dropped + estimated - budget));
    if (estimated <= budget) return { messages: result, trimmed: true };

    // === 4. 注入的 system 块：首条与末条之间、不是本轮指令块的 ===
    const injected = () =>
      result.flatMap((m, i) => (i > 0 && i < result.length - 1 && m.role === 'system' && !directive(m) ? [i] : []));
    const total = injected().reduce((sum, i) => sum + estimateMsgTokens(result[i]), 0);
    if (total > this.memoryTokenBudget) {
      const ratio = this.memoryTokenBudget / total;
      for (const i of injected()) {
        const m = result[i];
        if (!m.content || m.content.length <= 200) continue;
        const targetLen = Math.max(200, Math.floor(m.content.length * ratio));
        const shorter = { ...m, content: truncateChars(m.content, targetLen, '\n... [记忆内容已缩减]') };
        estimated -= estimateMsgTokens(m) - estimateMsgTokens(shorter);
        result[i] = shorter;
      }
    }
    // 仍超时从最靠前的块删起。turn-context 迁移后头部只剩技能正文/会话摘要、档案/记忆类材料都在尾部——正序扫描意味着极端
    // 裁剪时**先牺牲头部稳定块**、可再生的尾部材料反而最后动，与理想优先级相反。维持正序是刻意取舍：这是罕见的最后手段，且
    // 反转方向会先删掉紧邻当前消息的当轮提示（focus/平台事件说明），代价更直观；按 injector 分级则是为极端路径引入一张需要
    // 长期维护的优先级表。真在生产观察到它高频触发时再议。
    let removed = 0;
    for (const i of injected()) {
      if (estimated <= budget) break;
      estimated -= estimateMsgTokens(result[i - removed]);
      result.splice(i - removed, 1);
      removed++;
    }

    // === 5. 最后一组也截短过长的结果、缩推理内容 ===
    const inLast = (m: Message) => last.has(m);
    shortenResults(inLast);
    shrinkReasoning(inLast);

    // 大幅裁剪后注入继续执行提示，防止模型因上下文缺失而中止任务：放在本轮最后一条输入之后，没有输入（快照）时放在末尾
    if (messages.length - result.length >= 6) {
      const hint: Message = {
        role: 'system',
        content:
          '[系统提示] 由于上下文长度限制，部分历史消息已被压缩或移除。请基于当前可见的上下文和最新用户请求继续完成任务，不要因为看不到之前的细节而停止工作。如果你之前有正在执行的多步骤任务或计划，请查看对话摘要和 todo-list 工具确认当前进度，然后继续未完成的步骤。',
        metadata: { injector: 'system-other' },
      };
      let insertIdx = result.length;
      for (let j = result.length - 1; j >= 0; j--) {
        if (!history.has(result[j]) && (result[j].role === 'user' || directive(result[j]))) {
          insertIdx = j + 1;
          break;
        }
      }
      result.splice(insertIdx, 0, hint);
    }

    return { messages: result, trimmed: true };
  }

  private getArchiveForWrite() {
    const archive = this.caps.messageArchive.present ? this.caps.messageArchive.use : undefined;
    if (!archive && !this.archiveUnavailableWarned) {
      this.archiveUnavailableWarned = true;
      this.logger.warn(
        'message-archive 服务不可用，缺席期间的新消息不会写入记忆，对话继续。请加载 @aalis/plugin-message-archive 及其 memory 依赖。',
      );
    }
    return archive;
  }

  /** 保存消息到记忆服务 */
  private async saveToMemory(sessionId: string, message: Message): Promise<void> {
    const archive = this.getArchiveForWrite();
    if (archive) {
      try {
        await archive.saveMessage(sessionId, message);
      } catch (err) {
        this.logger.warn(`保存消息到记忆失败 (session=${sessionId}):`, err);
      }
    }
  }

  /**
   * 这一轮落库的 assistant 消息的元数据；带 turnId，会话的客户端据此把存档归回它所在的回合。自身账号随窗口：子会话没有
   * 窗口，取根会话的
   */
  private buildAssistantMetadata(incoming: IncomingMessage, turnId: string): Record<string, unknown> | undefined {
    const sm = this.caps.sessionManager.present ? this.caps.sessionManager.use : undefined;
    const root = sm && rootSessionOf(sm.getSession(incoming.sessionId), id => sm.getSession(id));
    const identity = getPlatformSelfIdentity(this.caps.platform, incoming.platform, root?.id ?? incoming.sessionId);
    const metadata: Record<string, unknown> = {
      [WellKnownMetadataKeys.Platform]: incoming.platform,
      senderType: 'assistant',
      [WellKnownMetadataKeys.TurnId]: turnId,
    };
    if (identity?.selfId) metadata[WellKnownMetadataKeys.UserId] = identity.selfId;
    if (identity?.nickname) metadata[WellKnownMetadataKeys.Nickname] = identity.nickname;
    if (incoming.groupId) metadata[WellKnownMetadataKeys.GroupId] = incoming.groupId;
    if (incoming.groupName) metadata[WellKnownMetadataKeys.GroupName] = incoming.groupName;
    if (incoming.sessionType) metadata[WellKnownMetadataKeys.SessionType] = incoming.sessionType;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private async saveToolCallGroup(
    sessionId: string,
    assistantMessage: Message,
    toolMessages: Message[],
  ): Promise<void> {
    const timestamp = Date.now();
    await this.saveToMemory(sessionId, { ...assistantMessage, timestamp });
    for (let i = 0; i < toolMessages.length; i++) {
      // 工具交出的图只服务本回合的主模型（data URI 体积大、历史回看也不再需要它），不落库
      const { images: _transient, ...persisted } = toolMessages[i];
      await this.saveToMemory(sessionId, { ...persisted, timestamp: timestamp + i + 1 });
    }
  }

  /**
   * 交给模型的会话历史，真实回合与 token:request 的快照共用：按条数线读出的那一段（见 readHistory）清洗工具调用组，跳过控制类
   * 与 skip 里的各条，用户消息加时间标注，她的回复取可见正文（historyForModel）。改动都在副本上：记忆服务可能直接交出存着的
   * 消息对象。count 同 readHistory，dropped 是清洗跳过的条数；没有记忆服务时为空。不记日志：快照同样走这里，跳过的条数由真实
   * 回合的调用点记
   */
  private async modelHistory(
    sessionId: string,
    historyLimit: number | undefined,
    skip: readonly Message[] = [],
  ): Promise<{ messages: Message[]; count: number; dropped: number }> {
    if (!this.caps.memory.present) return { messages: [], count: 0, dropped: 0 };
    const stored = await readHistory(this.caps.memory.use, sessionId, historyLimit);
    const { kept, dropped } = this.sanitizeToolCallHistory(stored.messages);
    const now = Date.now();
    const messages: Message[] = [];
    for (const m of kept) {
      if (skip.some(input => isSameMessage(m, input))) continue;
      if (CONTROL_KINDS.includes(m.kind ?? '')) continue;
      // 为用户消息注入时间标注，帮助 LLM 理解时间先后
      if (m.role === 'user' && m.timestamp && m.content) {
        const timeLabel = formatTimeLabel(m.timestamp, now);
        if (timeLabel && !m.content.startsWith(`(${timeLabel})`)) {
          messages.push({ ...m, content: `(${timeLabel}) ${m.content}` });
          continue;
        }
      }
      messages.push(historyForModel(m));
    }
    return { messages, count: stored.count, dropped };
  }

  /**
   * 装载历史时清洗工具调用组：按 schema-message 的 groupToolCalls 归组（夹进调用与结果之间的别的消息挪到组后），结果不齐的组
   * 连同找到的结果跳过，不在任何组里的结果跳过。dropped 是跳过的条数
   */
  private sanitizeToolCallHistory(history: Message[]): { kept: Message[]; dropped: number } {
    const kept: Message[] = [];
    let dropped = 0;
    for (const { at, shape } of groupToolCalls(history)) {
      if (shape === 'partial' || shape === 'loose') dropped += at.length;
      else kept.push(...at.map(i => history[i]));
    }
    return { kept, dropped };
  }

  /** 归档一条输入：进了一轮的带回合 id 与进入方式（开轮 opened，插进来 joined），放掉的不带 */
  private async archiveIncomingMessage(
    message: IncomingMessage,
    turn?: { turnId: string; entry: 'opened' | 'joined' },
  ): Promise<Message | undefined> {
    const archive = this.getArchiveForWrite();
    if (!archive) return undefined;
    try {
      return (await archive.archiveIncoming(message, turn))?.message;
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
   * gateway 只是本插件的 optional 依赖，它不在场时 agent 照常激活，因此保留该 fallback 以便：
   *   - 集成测试不必启动 gateway
   *   - 嵌入式 / 单 agent 部署场景
   * 生产部署务必确保 plugin-gateway 已加载，否则中间件链会被跳过。
   */
  private async dispatchOutbound(message: OutgoingMessage): Promise<void> {
    const gateway = this.caps.gateway.present ? this.caps.gateway.use : undefined;
    if (gateway) {
      await gateway.dispatchOutbound(message);
      return;
    }
    this.logger.warn('Gateway 服务不可用，回退至 outbound:message 事件（中间件链被跳过）');
    await this.caps.events.use.emit('outbound:message', message);
  }
}

// ----- 插件导出 -----

const configSchema = defineConfig({
  systemPrompt: {
    type: 'textarea',
    label: t('systemPromptLabel'),
    description: t('systemPromptDescription'),
    default: '',
  },
  memoryTokenBudget: {
    type: 'number',
    label: t('memoryTokenBudgetLabel'),
    default: 4096,
    secret: false,
    description: t('memoryTokenBudgetDescription'),
  },
  promptBuildTimeoutMs: {
    type: 'number',
    label: t('promptBuildTimeoutMsLabel'),
    default: 10000,
    description: t('promptBuildTimeoutMsDescription'),
  },
  toolResultMaxRatio: {
    type: 'number',
    label: t('toolResultMaxRatioLabel'),
    default: 0.15,
    description: t('toolResultMaxRatioDescription'),
  },
  trimThresholdRatio: {
    type: 'number',
    label: t('trimThresholdRatioLabel'),
    default: 1.0,
    description: t('trimThresholdRatioDescription'),
  },
  // ----- 按会话字段：各层可覆盖，每一轮按会话读 -----
  llm: {
    type: 'llm-ref',
    label: t('llmLabel'),
    description: t('llmDescription'),
    ...MODEL_REF_TEXT,
    // 全局层不在插件配置里：是本插件的 llm 偏好
    session: { prominence: 'composer', preference: 'llm', unset: t('llmUnset'), minLevel: 1 },
  },
  think: {
    type: 'select',
    label: t('thinkLabel'),
    description: t('thinkDescription'),
    // 可选项是「模型」这一项生效的那个模型声明的档位
    dynamicOptions: 'llm-thinking',
    session: { prominence: 'common', order: 20, dependsOn: 'llm', unset: t('thinkUnset'), minLevel: 1 },
  },
  maxToolIterations: {
    type: 'number',
    label: t('maxToolIterationsLabel'),
    description: t('maxToolIterationsDescription'),
    integer: true,
    min: 1,
    session: { prominence: 'advanced', unset: t('maxToolIterationsUnset') },
  },
  historyLimit: {
    type: 'number',
    label: t('historyLimitLabel'),
    description: t('historyLimitDescription'),
    integer: true,
    min: 0,
    default: 0,
    session: { prominence: 'advanced' },
  },
});

// 暴露给 apply() 内部用 / 指令处理用的 DefaultAgent 内部方法窄化接口
// （正常 service 消费者走 AgentService 公共接口；此处属于 plugin 自有控制面）
type InternalAgent = {
  promptBuildTimeoutMs: number;
  fields: SessionFieldReader<typeof configSchema>;
  resolveLLM(ref: ModelRef | undefined): ProviderEntry<LLMModel> | undefined;
  computeTokenBudget(contextLength: number, maxTokens: number): number;
  buildSystemPrompt(personaOpts?: PersonaSessionOptions): string;
  modelHistory(sessionId: string, historyLimit: number | undefined): Promise<{ messages: Message[]; count: number }>;
  trimMessages(messages: Message[], budget: number, history: ReadonlySet<Message>): TrimmedMessages;
  emitTokenUsage(usage: UsageReport): Promise<void>;
};

function run(caps: Caps): void {
  const cfg = parseConfig(configSchema, caps.config.use, caps.logger.use);
  const agentImpl = new DefaultAgent(caps, cfg, caps.lifecycle.use.id);
  caps.provide.use(agentService, agentImpl);
  // 收尾段停下全部在跑的一轮、放掉排着的（归档；按 core 的关停编排 agent 关完之前存档还在），等它们以 AbortError 收尾落定；
  // 之后到的输入一律放掉。第一方栈由 core 关停编排（optional 环成员先全部 drain）与 agent:turn:after 收口；
  // session-manager 的 onDrain 兜的是未装 agent 或钩子未挂上的路径。
  // 超时沿用 core 对 onDrain 的 disposeTimeoutMs，不另加配置键。
  caps.lifecycle.use.onDrain(() => agentImpl.queues.shutdown(), '停下在跑的回合');
  // 清理段再停一次：drain 超时或未走到收尾时的兜底，不再等落定；已停下的是空操作。
  caps.lifecycle.use.onDispose(() => void agentImpl.queues.shutdown(), '停下在跑的回合（兜底）');
  // 会话删除：停下这个会话（见 sessionDeleted）
  caps.events.use.on('session:deleted', sessionId => agentImpl.sessionDeleted(sessionId));
  const agent = agentImpl as unknown as InternalAgent;

  // /model 列可用模型、/persona 列可用人设；会话设置的查看与修改是会话设置插件的 /session 系列

  // 分页渲染 helper：限制每页 PAGE_SIZE 条 + 关键词过滤 + 翻页提示（/model 与 /persona 共用）。
  const PAGE_SIZE = 20;
  function renderPaged(all: string[], keyword: string, page: number, label: TextRef, command: string): TextRef {
    const kw = keyword.trim().toLowerCase();
    const list = kw ? all.filter(x => x.toLowerCase().includes(kw)) : all;
    if (list.length === 0) return kw ? t('pagedNoMatch', { keyword, label }) : t('pagedNone', { label });
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const p = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
    const body = list.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE).map(x => `- ${x}`);
    const counts = { label, count: list.length, page: p, pages };
    const lines = [kw ? t('pagedHeaderMatching', { ...counts, keyword }) : t('pagedHeader', counts), ...body];
    if (pages > 1) {
      const next = p < pages ? p + 1 : 1;
      lines.push(kw ? t('pagedHintMatching', { command, keyword, next }) : t('pagedHint', { command, next }));
    }
    return textLines(lines);
  }

  caps.commands.use
    .command('model [keyword:string]', t('modelDescription'))
    .option('page', '-p <n:number>', { description: t('pageOptionDescription') })
    .action(async (argv, keyword) => {
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const e of listLLMModels(caps.llm, { caps: ['chat'] })) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        ids.push(e.id);
      }
      const page = typeof argv.options.page === 'number' ? argv.options.page : 1;
      return renderPaged(ids, String(keyword ?? ''), page, t('modelsLabel'), '/model');
    });

  caps.commands.use
    .command('persona [keyword:string]', t('personaDescription'))
    .option('page', '-p <n:number>', { description: t('pageOptionDescription') })
    .action(async (argv, keyword) => {
      const persona = caps.persona.present ? caps.persona.use : undefined;
      const names = persona?.listModels ? await persona.listModels() : [];
      const page = typeof argv.options.page === 'number' ? argv.options.page : 1;
      return renderPaged(names, String(keyword ?? ''), page, t('personasLabel'), '/persona');
    });

  // /stop 同停止键：只停本会话在跑的一轮，排着的照常开下一轮。不看等级：发出者是这一轮的参与者（进了这一轮的各条输入按
  // originTurnOf 算：真人的话是发言者，续做与子任务是起它的那一轮的参与者，定时任务与编排是它的授权身份），或是 owner；排队与
  // 待插入的不算，没有账号的不算任何人
  caps.commands.use.command('stop', t('stopDescription'), { risk: 'safe' }).action(({ session }) => {
    const { sessionId, platform, userId } = session;
    const inputs = agentImpl.queues.inputs(sessionId);
    if (!inputs) return t('stopIdle');
    const { participants } = originTurnOf(inputs as [IncomingMessage, ...IncomingMessage[]], agentImpl.isOwner);
    const inTurn = Boolean(userId) && participants.some(who => who.platform === platform && who.userId === userId);
    if (!inTurn && !agentImpl.isOwner(platform, userId)) return t('stopDenied');
    agentImpl.abort(sessionId, { reason: '/stop', ...(userId ? { by: { platform, userId } } : {}) });
    return t('stopped');
  });

  // 监听 token:request 事件 — 客户端刷新/重连时主动请求 token 用量
  caps.events.use.on('token:request', async data => {
    if (!data?.sessionId) return;
    // platform 是调用方的入口平台（owner 面会话的快照按它选档）；会话服务对房间不填、其余填连接的平台。
    // 缺省时 IM 房间按会话记下的出生平台（子会话取根会话的）、其余按 'webui'：它还是提示词贡献方的「当前平台」
    //（按平台取跨会话料），不能缺省成空
    const sm = caps.sessionManager.present ? caps.sessionManager.use : undefined;
    const origin = sm && rootSessionOf(sm.getSession(data.sessionId), id => sm.getSession(id))?.originPlatform;
    const platform = data.platform ?? origin ?? 'webui';

    try {
      // 与真实回合同一份会话读法：模型、条数线；人设覆盖、结构化输出开关、额外提示由人设服务按会话读，都影响系统提示长度
      const settings = agent.fields.get(data.sessionId, { platform });
      const resolved = agent.resolveLLM(settings.llm);
      if (!resolved) return;
      const llm = resolved.use;

      const contextLength = llm.contextLength;
      const maxTokens = getModelMaxOutput(llm);
      const tokenBudget = agent.computeTokenBudget(contextLength, maxTokens);

      // 构建基础消息列表
      const messages: Message[] = [];

      // 系统提示
      const systemPrompt = agent.buildSystemPrompt({ sessionId: data.sessionId, platform });
      messages.push({ role: 'system', content: systemPrompt, metadata: { injector: 'persona' } });

      // 历史消息：与真实回合同一个读法
      const history = await agent.modelHistory(data.sessionId, settings.historyLimit);
      messages.push(...history.messages);

      // 与真实回合同序：先组装 agent:prompt 贡献（摘要/向量记忆/档案等物化为 system 块），
      // 再跑 agent:llm:before（工具搜索层过滤等拦截职责），使快照贴近实际送入 LLM 的形态
      const tools = caps.tools.present
        ? caps.tools.use.getDefinitions({ groups: caps.tools.use.sessionGroups(data.sessionId, platform) })
        : [];

      const llmBeforeData = {
        messages,
        tools,
        acceptsImages: llm.capabilities.includes(LLMCapabilities.Vision),
        sessionId: data.sessionId,
        platform,
        dryRun: true, // 纯统计路径:昂贵注入者(向量检索/档案加载)据此跳过副作用
      };
      // 不在回合里：没有输入，各贡献按没有输入处理
      await assemblePromptContributions(caps, llmBeforeData, [], { buildTimeoutMs: agent.promptBuildTimeoutMs });
      await caps.hooks.use.run('agent:llm:before', llmBeforeData, undefined, { warnOnStall: true });

      // 与真实回合同样过硬裁剪，拆分按裁剪之后的消息算
      const sent = agent.trimMessages(llmBeforeData.messages, tokenBudget, new Set(history.messages));
      await agent.emitTokenUsage({
        sessionId: data.sessionId,
        platform,
        contextWindow: contextLength,
        maxTokens,
        tokenBudget,
        messages: sent.messages,
        tools: llmBeforeData.tools,
        trimmed: sent.trimmed,
        untrimmedHistory: estimateHistoryTokens(llmBeforeData.messages),
        historyMessages: history.count,
        historyLimit: settings.historyLimit,
      });
    } catch (err) {
      caps.logger.use.debug('token:request 处理失败:', err);
    }
  });
}

export default definePlugin({
  name: '@aalis/plugin-agent',
  displayName: t('displayName'),
  subsystem: 'agent',
  configSchema,
  provides: [agentService],
  uses,
  apply: run,
});
