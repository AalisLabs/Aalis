// ----- Agent 服务接口（完整定义）-----
//
// 提供 AgentService 完整契约 + agent:* 钩子声明。
// 默认实现由 @aalis/plugin-agent 提供。
//
// 第三方插件若要 augment HookContextMap 的 agent:* 键，需要把本包加入
// 依赖（或 import 一次 side-effect）以确保 TS 编译期看到 augmentation。

import type { Context } from '@aalis/core';
import type { ChatResponse } from '@aalis/plugin-llm-api';
import type { IncomingMessage, Message } from '@aalis/plugin-message-api';
import type { ToolCallContext, ToolDefinition } from '@aalis/plugin-tools-api';

/**
 * 插件分组信息（按子系统聚合，供 WebUI Dashboard 等使用）
 *
 * Agent 服务通过 `getPluginGroups()` 暴露当前活跃插件的分组结构，
 * 由 dashboard 据此把插件归入对应的子系统面板。
 */
export interface PluginGroupInfo {
  /** 分组显示名称 */
  label: string;
  /** 该分组包含的插件 instanceId 列表 */
  plugins: string[];
}

/**
 * 消息预处理器函数
 *
 * 在消息到达 LLM 之前对 IncomingMessage 进行变换。
 * 遵循洋葱模型：调用 `next()` 将控制权传递给下一个预处理器，
 * 不调用则中断整个流程（LLM 不会被调用）。
 */
export type PreprocessorFn = (message: IncomingMessage, next: () => Promise<void>) => Promise<void>;

/** 已注册预处理器的元信息 */
export interface PreprocessorInfo {
  /** 预处理器名称 */
  name: string;
}

/**
 * Agent 服务 —— 对话编排引擎
 *
 * 负责接收用户消息并编排完整的对话流程：
 * 组装系统提示、加载历史、调用 LLM、执行工具调用循环、发出回复。
 *
 * 默认由 plugin-agent-default 提供。
 * 外部插件可以注册自己的 AgentService 来完全接管或扩展对话编排逻辑。
 */
export interface AgentService {
  /** 处理一条传入消息，完成完整的对话循环 */
  handleMessage(message: IncomingMessage): Promise<void>;
  /** 中止指定会话的当前生成（可选实现） */
  abort?(sessionId: string): void;

  /**
   * 注册消息预处理器
   *
   * 预处理器在 `agent:input:before` 阶段运行，可以修改 IncomingMessage（如将图片转文字、解析文件）。
   * 底层通过中间件系统实现，priority 越大越先执行。
   */
  registerPreprocessor?(name: string, handler: PreprocessorFn): () => void;

  /** 获取当前所有已注册预处理器的元信息 */
  getPreprocessors?(): PreprocessorInfo[];

  /**
   * 获取 Agent 子系统的插件分组
   *
   * 基于 Agent 的 inject 声明，自动找出所有为 Agent 提供服务的插件，
   * 返回分组信息供 Dashboard 使用。
   */
  getPluginGroups?(): PluginGroupInfo[];
}

// ----- Agent 域钩子声明（通过 declaration merging 注入 core 的 HookContextMap）-----

declare module '@aalis/core' {
  interface HookContextMap {
    'agent:input:before': { message: IncomingMessage; metadata: Record<string, unknown> };
    /**
     * 一轮 agent 处理结束时触发（仿 Fastify `onResponse` 相位）。
     */
    'agent:turn:after': {
      message: IncomingMessage;
      reply: string;
      outcome: 'replied' | 'silent' | 'aborted' | 'error';
      sessionId: string;
      metadata: Record<string, unknown>;
    };
    'agent:tool:before': { name: string; args: Record<string, unknown>; toolCallContext: ToolCallContext };
    'agent:tool:after': { name: string; result: string; toolCallContext: ToolCallContext };
    'agent:reply:before': {
      content: string;
      archiveContent?: string;
      sessionId: string;
      platform?: string;
      userId?: string;
      triggerType?: IncomingMessage['triggerType'];
      /**
       * 当中间件检测到回复无法满足约束（如 outputFormat 解析失败）时，
       * 可将其置为 true 触发 agent 重试。agent 会按 `maxRetries` 循环重试，
       * 用尽次数后若仍 true，会强制把 content 置空以避免错误内容外发。
       */
      retryRequested?: boolean;
      /**
       * 重试时附加给模型的反馈系统消息内容，描述本次失败原因与修复要求。
       * 仅在 retryRequested === true 时生效。
       */
      retryFeedback?: string;
      /**
       * 当前已重试的次数（首次进入 hook 时为 0；agent 每次重试后递增）。
       * 中间件用此判断「这是第几次解析这一轮的回复」。
       */
      attempt?: number;
      /**
       * 中间件期望的最大重试次数。第一次进入 hook 时由中间件写入，agent 据此决定循环次数。
       * 缺省视为 0（不重试）。
       */
      maxRetries?: number;
    };
    'agent:llm:before': {
      messages: Message[];
      tools: ToolDefinition[];
      sessionId?: string;
      userId?: string;
      platform?: string;
      triggerType?: IncomingMessage['triggerType'];
      /**
       * 干跑标记:本次只为估算上下文体积(token:request 快照),不会真正调用 LLM。
       * 昂贵/有副作用的注入者(向量检索、档案加载)据此跳过——代价是快照略微
       * 低估这些块的体积,真实回合的统计不受影响。
       */
      dryRun?: boolean;
    };
    'agent:llm:after': { response: ChatResponse; messages: Message[] };
  }
}

// ----- 领域 helper -----

/**
 * Scoped Agent 服务，用于插件 apply() 中注册预处理器。
 */
export interface ScopedAgentService {
  /**
   * 注册输入预处理器。若 'agent' 服务尚未就绪，会通过 `ctx.whenService` 自动延迟。
   *
   * 仅当 service 提供 `registerPreprocessor` 时生效；不支持预处理器的 Agent 实现下
   * 调用方应自行降级到 `ctx.middleware('agent:input:before', ...)`。
   */
  registerPreprocessor(name: string, handler: PreprocessorFn): () => void;
  /** 获取底层 service（未就绪时为 undefined） */
  readonly raw: AgentService | undefined;
}

/**
 * 获取 ScopedAgentService。
 */
export function useAgent(ctx: Context): ScopedAgentService {
  return {
    registerPreprocessor(name: string, handler: PreprocessorFn): () => void {
      // 持续订阅 'agent'：服务每次上线都尝试挂上 preprocessor；若 service 没实现
      // registerPreprocessor 则本次注册为 no-op，bounce 到新提供者时再尝试一次。
      return ctx.whenService<AgentService>('agent', s => s.registerPreprocessor?.(name, handler));
    },
    get raw() {
      return ctx.getService<AgentService>('agent');
    },
  };
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    agent: AgentService;
  }
}

// ----- agent:prompt 贡献点（通过 declaration merging 注入 core 的 ContributionPointMap）-----

/**
 * 提示词锚位——组装器的槽位词汇表（封闭联合，新增锚位是纯增量的类型变更）：
 *
 * - `identity`：紧贴首条 system（persona）之后。你是谁 / 对话者是谁
 *   （档案、关系、行为准则）。
 * - `knowledge`：头部 system 区末尾，先于 context。可用能力与操作知识
 *   （技能清单、已激活技能正文）。
 * - `context`：头部 system 区末尾，居 knowledge 之后。检索到的对话上下文
 *   （向量记忆、摘要、跨会话历史、文件清单）。
 * - `turn-hint`：最后一条 user 消息之前。仅与当前这一轮相关的即时提示
 *   （群聊时间线提醒、特殊事件说明）。messages 中无 user 消息时该槽弃置。
 *
 * 同槽内多块按全局键码元序排布——**顺序确定但无语义**，契约要求同槽贡献
 * 互不依赖先后；若两块内容有顺序依赖，它们应属于同一个贡献（build 返回
 * 数组，块间保序）。
 */
export type PromptAnchor = 'identity' | 'knowledge' | 'context' | 'turn-hint';

/**
 * build 的只读视图——贡献者能看到的全部信息。
 *
 * 贡献者不掌握控制流：看不到其他贡献的产出，不能改写 messages，
 * 不能影响排布；只能决定"这一轮交不交料、交什么"。
 *
 * `messages` 是组装开始时的浅拷贝快照：build 之间并行执行，禁止（也无法
 * 经由本数组）改写真实消息序列；消息对象本身未深拷贝，不要变更其字段。
 */
export interface PromptContributionView {
  readonly sessionId?: string;
  readonly userId?: string;
  readonly platform?: string;
  readonly triggerType?: IncomingMessage['triggerType'];
  /**
   * 干跑标记：本次只为估算上下文体积（token:request 快照），不会真正调用 LLM。
   * 昂贵/有副作用的构建（向量检索、档案加载）据此返回 null 跳过——代价是
   * 快照略微低估这些块的体积，真实回合的统计不受影响。
   */
  readonly dryRun: boolean;
  readonly messages: readonly Message[];
}

/**
 * `agent:prompt` 贡献点的 spec——经 `ctx.contribute('agent:prompt', spec)` 注册。
 *
 * - `id`：局部幂等键（如 'context'、`activation:${skillName}`），注册时被内核
 *   冠 `${ctx.id}/` 前缀成全局键；全局键即物化块的 `metadata.injector`
 *   （token 统计 / 裁剪 / 幂等识别的归属标识）。
 * - `build`：每次 LLM 调用前被组装器调用（含工具循环各轮；已物化过的贡献
 *   按全局键跳过，不会重复 build）。返回 null = 本轮不交料；返回数组 =
 *   多块，块间保序、共用同一全局键。**抛错只导致本贡献缺席，不影响他人、
 *   不中断流程**（与 hooks 的上溯中断相反，这是设计意图）。
 */
export interface PromptContribution {
  id: string;
  anchor: PromptAnchor;
  build(view: PromptContributionView): string | readonly string[] | null | Promise<string | readonly string[] | null>;
}

declare module '@aalis/core' {
  interface ContributionPointMap {
    'agent:prompt': PromptContribution;
  }
}

// ----- token:usage 事件契约 -----

/** token:usage 事件的 12 桶 prompt 构成明细（单位：token 数） */
export interface TokenUsageBreakdown {
  system: number;
  persona: number;
  memorySummary: number;
  memoryVector: number;
  skills: number;
  platform: number;
  subtask: number;
  systemOther: number;
  /** systemOther 的按注入者明细(injector 标签 → tokens),诊断预算争抢用 */
  injectors?: Record<string, number>;
  history: number;
  toolResults: number;
  toolDefs: number;
  reservedForReply: number;
}

/**
 * agent 每次 LLM 调用后 emit 的 prompt 预算快照。
 *
 * 发射方：plugin-agent；已知消费方：plugin-webui-server（面板渲染）、
 * plugin-memory-summary（预压缩触发）、plugin-prompt-budget（AI 自检工具）。
 */
export interface TokenUsageEvent {
  sessionId: string;
  platform: string;
  contextWindow: number;
  maxTokens: number;
  tokenBudget: number;
  used: number;
  usageRatio: number;
  breakdown: TokenUsageBreakdown;
}

declare module '@aalis/core' {
  interface AalisEvents {
    'token:usage': [usage: TokenUsageEvent];
    /**
     * 请求 agent 重发某会话的最新 token:usage 快照。
     * 发射方：plugin-webui-server（客户端刷新/重连时）；消费方：plugin-agent。
     */
    'token:request': [req: { sessionId: string }];
  }
}
