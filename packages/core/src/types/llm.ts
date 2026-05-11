// ----- LLM 服务接口骨架 -----
//
// 完整的 LLM 抽象（ChatRequest/ChatStreamChunk/ModelInfo/LLMService/LLMCapability 等）
// 由 @aalis/plugin-llm-api 提供。
// 此处仅保留 `ChatResponse` 骨架接口，供 core/types/hooks.ts 的 HookContextMap 引用，
// 避免 core 依赖 llm-api 形成循环。
// plugin-llm-api 通过 declaration merging 注入完整字段。

/** LLM 响应骨架（字段由 @aalis/plugin-llm-api 通过声明合并补全） */
export interface ChatResponse {}
