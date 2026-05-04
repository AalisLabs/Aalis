// ----- 钩子/中间件上下文映射 -----
// 独立文件：避免循环依赖

import type { IncomingMessage, Message, OutgoingMessage, ToolDefinition, ToolCallContext } from './core.js';
import type { AgentService } from './agent.js';
import type { ChatResponse } from './llm.js';

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
   * 消息路由钩子（**已废弃**，由 `gateway:inbound` 取代）。
   *
   * 历史上 core/app.ts 直接监听 `inbound:message` 并通过本钩子分发到 agent。
   * 路由职责现已迁移到 `@aalis/plugin-gateway`，core 不再发起本钩子。
   * 仍保留类型以兼容旧插件，gateway 实现可选择性地继续触发。
   *
   * @deprecated 请改用 `gateway:inbound`
   */
  'agent:route': { message: IncomingMessage; agent: AgentService | undefined };
  /**
   * Gateway 入站钩子链（洋葱模型）。
   *
   * 默认动作：调用 `agent.handleMessage(message)`。
   * 中间件可：
   *   - 改写 `message` / `metadata`；
   *   - 不调用 `next()` 以中断后续链路（命令命中、流控丢弃、触发策略静默等）；
   *   - 在 `next()` 之后做后置处理（审计、归档决策）。
   *
   * 由 `@aalis/plugin-gateway` 监听 `inbound:message` 时发起。
   */
  'gateway:inbound': {
    message: IncomingMessage;
    metadata: Record<string, unknown>;
    agent: AgentService | undefined;
  };
  /**
   * Gateway 出站钩子链（洋葱模型）。
   *
   * 默认动作：向 `outbound:message` 事件总线广播，由平台适配器接收并发送。
   * 中间件可：
   *   - 改写 `message`（脱敏、文本清洗）；
   *   - 不调用 `next()` 以静默丢弃；
   *   - 在 `next()` 之后做审计 / 投递确认。
   *
   * 由 `GatewayService.dispatchOutbound()` 发起。
   */
  'gateway:outbound': {
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
