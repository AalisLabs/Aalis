// ----- 钩子/中间件上下文映射 -----
// 独立文件：HookContextMap 引用了 agent 和 llm 的服务类型，
// 不能放在 core.ts 里（避免循环依赖）。

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
 */
export interface HookContextMap {
  'message:before': { message: IncomingMessage; metadata: Record<string, unknown> };
  'message:after': { message: IncomingMessage; response: string; sessionId: string; metadata: Record<string, unknown> };
  /** 消息路由钩子：插件可拦截此钩子来替换 agent 或修改消息路由逻辑 */
  'message:route': { message: IncomingMessage; agent: AgentService | undefined };
  'llm-call:before': { messages: Message[]; tools: ToolDefinition[]; sessionId?: string; userId?: string; platform?: string };
  'llm-call:after': { response: ChatResponse; messages: Message[] };
  'tool-call:before': { name: string; args: Record<string, unknown>; toolCallContext: ToolCallContext };
  'tool-call:after': { name: string; result: string; toolCallContext: ToolCallContext };
  'response:before': { content: string; sessionId: string };
  // 允许任意字符串 key（运行时安全，类型兜底）
  [key: string]: Record<string, unknown>;
}
