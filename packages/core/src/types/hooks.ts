// ----- 钩子/中间件上下文映射 -----
//
// 这是一个可扩展的「字符串键 → 上下文类型」映射。core 自身不预声明任何
// 业务钩子键；具体钩子由各 api 包通过 declaration merging 注入：
//
//   - @aalis/plugin-agent-api       → agent:*（含 llm/tool/reply/input/turn）
//   - @aalis/plugin-gateway-api     → inbound:* / outbound:dispatch（含 InboundPhaseData）
//   - @aalis/plugin-memory-api      → memory:clear
//   - @aalis/plugin-session-manager → session:*
//
// 第三方插件可继续 augment 自定义钩子：
//   declare module '@aalis/core' {
//     interface HookContextMap {
//       'schedule:before': { jobId: string; cron: string };
//     }
//   }

export interface HookContextMap {}

// ----- 中间件签名（钩子域词汇） -----

/**
 * 中间件 next 函数，调用它将控制传递给下一个中间件或默认行为
 */
export type MiddlewareNext = () => Promise<void>;

/**
 * 中间件函数签名：接收数据和 next，可选择修改数据或中断流程
 */
export type MiddlewareFn<T> = (data: T, next: MiddlewareNext) => Promise<void>;
