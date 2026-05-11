// ----- Agent 服务接口（skeleton）-----
//
// 真正的 AgentService 接口由 plugin-agent-default 通过 declaration merging 扩展。
// core 仅保留空接口骨架，供 hooks.ts 的 InboundPhaseData.agent 字段以及
// 第三方插件通过 ctx.getService<AgentService>('agent') 引用。

/** Agent 服务 —— 对话编排引擎（接口由具体实现插件通过声明合并扩展） */
export interface AgentService {}

/** 消息预处理器函数（由实现插件通过声明合并扩展，此处仅占位） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PreprocessorFn = (...args: any[]) => any;

/** 已注册预处理器的元信息（由实现插件通过声明合并扩展，此处仅占位） */
export interface PreprocessorInfo {
  name: string;
}
