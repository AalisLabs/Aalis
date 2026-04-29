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
 * Agent 域钩子（如 llm-call:before/after）由 plugin-agent-default 通过
 * declaration merging 注入，不直接定义在 core 中。
 */
export interface HookContextMap {
  'message:before': { message: IncomingMessage; metadata: Record<string, unknown> };
  'message:after': { message: IncomingMessage; response: string; sessionId: string; metadata: Record<string, unknown> };
  /** 消息路由钩子：插件可拦截此钩子来替换 agent 或修改消息路由逻辑 */
  'message:route': { message: IncomingMessage; agent: AgentService | undefined };
  'tool-call:before': { name: string; args: Record<string, unknown>; toolCallContext: ToolCallContext };
  'tool-call:after': { name: string; result: string; toolCallContext: ToolCallContext };
  'response:before': { content: string; sessionId: string };
  // LLM 调用钩子
  'llm-call:before': { messages: Message[]; tools: ToolDefinition[]; sessionId?: string; userId?: string; platform?: string; triggerType?: IncomingMessage['triggerType'] };
  'llm-call:after': { response: ChatResponse; messages: Message[] };
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
  // 允许任意字符串 key（运行时安全，类型兜底）
  [key: string]: Record<string, unknown>;
}
