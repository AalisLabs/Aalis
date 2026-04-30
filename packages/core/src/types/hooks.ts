// ----- 钩子/中间件上下文映射 -----
// 独立文件：避免循环依赖

import type { IncomingMessage, Message, ToolDefinition, ToolCallContext } from './core.js';
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
  /** 消息路由钩子：插件可拦截此钩子来替换 agent 或修改消息路由逻辑 */
  'agent:route': { message: IncomingMessage; agent: AgentService | undefined };
  'agent:tool:before': { name: string; args: Record<string, unknown>; toolCallContext: ToolCallContext };
  'agent:tool:after': { name: string; result: string; toolCallContext: ToolCallContext };
  'agent:reply:before': { content: string; sessionId: string; platform?: string; userId?: string; triggerType?: IncomingMessage['triggerType'] };
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
