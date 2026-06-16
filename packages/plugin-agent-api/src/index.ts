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
 * 消息预处理器函数
 *
 * 在消息到达 LLM 之前对 IncomingMessage 进行变换。
 * 遵循洋葱模型：调用 `next()` 将控制权传递给下一个预处理器，
 * 不调用则中断整个流程（LLM 不会被调用）。
 */
export type PreprocessorFn = (message: IncomingMessage, next: () => Promise<void>) => Promise<void>;

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
