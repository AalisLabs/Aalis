// ----- 钩子/中间件上下文映射 -----
// 独立文件：避免循环依赖

import type { IncomingMessage, Message, OutgoingMessage, ToolDefinition, ToolCallContext } from './core.js';
import type { AgentService } from './agent.js';
import type { ChatResponse } from './llm.js';

/**
 * 入站相位共享数据结构
 *
 * 同一条消息在 `inbound:command` → `inbound:flow` → `inbound:trigger`
 * → `inbound:dispatch` 四个相位间被同一对象引用传递，handler 在前一相位
 * 对 `metadata` / `message` 的改动会被后续相位看到。
 */
export interface InboundPhaseData {
  message: IncomingMessage;
  metadata: Record<string, unknown>;
  /** 当前可用的 agent 服务；plugin-gateway 在调度前已注入。 */
  agent: AgentService | undefined;
}

/**
 * Hook 上下文类型映射
 *
 * 第三方插件可通过 TypeScript declaration merging 扩展：
 * ```ts
 * declare module '@aalis/core' {
 *   interface HookContextMap {
 *     'schedule:before': { jobId: string; cron: string };
 *   }
 * }
 * ```
 *
 * Agent 域钩子（如 agent:llm:before/after）由 plugin-agent-default 通过
 * declaration merging 注入，不直接定义在 core 中。
 */
export interface HookContextMap {
  'agent:input:before': { message: IncomingMessage; metadata: Record<string, unknown> };
  /**
   * 一轮 agent 处理结束时触发（仿 Fastify `onResponse` 相位）。
   *
   * - `outcome` 表达本轮的最终结果，消费者应据此分支处理，不要用 `reply === ''` 隐式判断：
   *   - `replied`：已通过 `outbound:message` 发出回复（`reply` 为最终文本）
   *   - `silent` ：模型/钩子产出空回复，已静默跳过（`reply` 为空字符串）
   *   - `aborted`：被中止或被 reply 钩子清空（`reply` 可能为空）
   * - `reply` 已经过 `agent:reply:before` 钩子链，是发送给适配器的最终文本（不含 raw JSON 包装）。
   */
  'agent:turn:after': {
    message: IncomingMessage;
    reply: string;
    outcome: 'replied' | 'silent' | 'aborted';
    sessionId: string;
    metadata: Record<string, unknown>;
  };
  /**
   * ===== Gateway 入站消息生命周期（命名相位）=====
   *
   * 替代旧版的单一 `gateway:inbound` + 数字优先级。每个相位是独立的钩子键，
   * 由 `plugin-gateway` 按 INBOUND_PHASE_ORDER 顺序串行调度。
   * 同一相位内多个 handler 按注册顺序执行洋葱模型，不调用 next() 表示
   * "我已处理"，整个入站管道立即停止。
   *
   * 第三方插件可注册到任一相位获得清晰的语义位置：
   *  - `inbound:command`  → 指令解析（plugin-commands 占据）
   *  - `inbound:flow`     → 流控闸门（plugin-flow-control 占据）
   *  - `inbound:trigger`  → 触发策略（plugin-trigger-policy 占据）
   *  - `inbound:dispatch` → 默认派发到 agent（plugin-gateway 提供 default action）
   */
  'inbound:command': InboundPhaseData;
  'inbound:flow': InboundPhaseData;
  'inbound:trigger': InboundPhaseData;
  'inbound:dispatch': InboundPhaseData;
  /**
   * Gateway 出站钩子链（洋葱模型）。
   *
   * 默认动作：向 `outbound:message` 事件总线广播，由平台适配器接收并发送。
   * Handler 可：
   *   - 改写 `message`（脱敏、文本清洗）；
   *   - 不调用 `next()` 以静默丢弃；
   *   - 在 `next()` 之后做审计 / 投递确认。
   *
   * 由 `GatewayService.dispatchOutbound()` 发起。
   */
  'outbound:dispatch': {
    message: OutgoingMessage;
    metadata: Record<string, unknown>;
  };
  'agent:tool:before': { name: string; args: Record<string, unknown>; toolCallContext: ToolCallContext };
  'agent:tool:after': { name: string; result: string; toolCallContext: ToolCallContext };
  'agent:reply:before': { content: string; archiveContent?: string; sessionId: string; platform?: string; userId?: string; triggerType?: IncomingMessage['triggerType'] };
  // LLM 调用钩子
  'agent:llm:before': { messages: Message[]; tools: ToolDefinition[]; sessionId?: string; userId?: string; platform?: string; triggerType?: IncomingMessage['triggerType'] };
  'agent:llm:after': { response: ChatResponse; messages: Message[] };
  // 记忆清除钩子（统一编排）
  'memory:clear': {
    /** 清除范围: session=当前会话, all=全局 */
    scope: 'session' | 'all';
    /** 指定清除的子系统（为空则全部清除） */
    types?: string[];
    /** 当前会话 ID（scope=session 时必填） */
    sessionId?: string;
    /** 各子系统报告的结果（由中间件填充） */
    results: Array<{ source: string; success: boolean; message: string }>;
    /** 回滚函数列表（清除失败时依次执行） */
    rollbacks: Array<{ source: string; fn: () => Promise<void> }>;
  };
}
