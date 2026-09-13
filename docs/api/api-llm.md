# api-llm — 大语言模型服务契约

**包名**: `@aalis/api-llm`  
**源码**: `packages/api-llm/src/index.ts`  
**实现**: `@aalis/plugin-llm-openai`, `@aalis/plugin-llm-ollama`, `@aalis/plugin-llm-deepseek`

## 概述

定义所有 LLM provider 必须满足的服务契约，以及 capability 框架（`chat / tool_calling / streaming / vision / thinking`）。每个 provider 用 `ctx.provide('llm', handle, { entryId: '<provider>/<modelId>', capabilities })` 为 **每个模型** 独立注册一个 entry。Agent / Memory-summary / Image-recognition 等消费方仅依赖本契约。

## 关键类型

```ts
interface ChatModelRequest {
  messages: Message[];          // 来自 @aalis/schema-message（含 role/content/tool_calls 等）
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;           // 调用方期望的输出上限
  signal?: AbortSignal;         // 取消
  think?: boolean;              // 思考开关：undefined=随模型默认，true/false=显式覆盖
}
// 注意：**不含 model / provider**——entry 本身已绑定到具体 model

interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  reasoningContent?: string | null;
  usage?: { promptTokens; completionTokens; totalTokens };
}

interface ChatStreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCalls?: ToolCall[];
  done?: boolean;
  usage?: { ... };
}
```

## 服务接口

service-granularity 之后没有「一个 provider 一个 facade」这回事：**一个 model 就是一个 `'llm'` service entry**，
provider 插件在 `apply()` 里为每个 model 各调一次 `ctx.provide('llm', handle, { entryId })`。

```ts
interface LLMModel {
  /** model id（provider 内唯一，如 'gpt-4o'） */
  readonly id: string;
  /** 所属 provider 的 contextId（即插件 instanceId） */
  readonly providerId: string;
  /** 上下文窗口 tokens，供上层做 prompt 截断决策 */
  readonly contextLength: number;
  /** provider 建议的单次最大输出 token（可选） */
  readonly maxOutputTokens?: number;
  /** 该 model 的能力元数据（chat/vision/tool_calling/…），是领域数据而非 DI 选择机制 */
  readonly capabilities: readonly LLMCapability[];

  chat(request: ChatModelRequest): Promise<ChatResponse>;
  chatStream?(request: ChatModelRequest): AsyncIterable<ChatStreamChunk>;
  /** 让管理面板触发该 provider 重新探测远端模型列表（静态契约型 provider 可不实现） */
  refresh?(): Promise<{ added: string[]; removed: string[]; total: number }>;
}
```

> 旧的 `LLMService` facade（`getTemperature()` / `listModels()` / `chat({ provider })` 路由）已随该重构删除。
> 选哪个 model 靠服务偏好（`ctx.preferService('llm', contextId)`）与会话级覆盖，不再由调用方传 `provider`。

## Capability 框架

```
chat            必须 —— 提供 .chat()
tool_calling    支持 tools 字段
streaming       提供 .chatStream()
vision          支持 image 内容段
thinking        支持 think=true（reasoning_content）
```

声明依赖：

```ts
export const inject = {
  required: ['llm'],
};
```

## 模型引用解析

```ts
export interface ModelRef { provider?: string; model?: string }
export function resolveLLMModel(
  ctx: Context,
  ref?: ModelRef | null,
  requiredCaps?: LLMCapability[],
): LLMModelEntry | undefined;
```

按 `{ provider, model }` 查 entry：provider+model 完全匹配优先，其次只 provider / 只 model，均为空则在满足 `requiredCaps` 的范围内按 ServicePreference > priority > 注册顺序拿首个。上层 ConfigSchema 用 `type: 'llm-ref'` 字段统一编辑，YAML 中以嵌套对象形式存储。

## 实现者

- [@aalis/plugin-llm-openai](../plugins/plugin-llm-openai.md) — 通用 OpenAI 兼容
- [@aalis/plugin-llm-deepseek](../plugins/plugin-llm-deepseek.md) — DeepSeek（含 thinking）
- [@aalis/plugin-llm-ollama](../plugins/plugin-llm-ollama.md) — 本地 Ollama

## 相关

- 协议层 `Message / ToolCall / ToolDefinition` 在 `@aalis/core`
- 会话级 LLM 切换见 [api-session-manager](./api-session-manager.md)
