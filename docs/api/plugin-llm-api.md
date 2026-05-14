# plugin-llm-api — 大语言模型服务契约

**包名**: `@aalis/plugin-llm-api`  
**源码**: `packages/plugin-llm-api/src/index.ts`  
**实现**: `@aalis/plugin-openai`, `@aalis/plugin-ollama`, `@aalis/plugin-deepseek`

## 概述

定义所有 LLM provider 必须满足的服务契约，以及 capability 框架（`chat / tool_calling / streaming / vision / thinking`）。每个 provider 用 `ctx.provide('llm', handle, { entryId: '<provider>/<modelId>', capabilities })` 为 **每个模型** 独立注册一个 entry。Agent / Memory-summary / Image-recognition 等消费方仅依赖本契约。

## 关键类型

```ts
interface ChatRequest {
  messages: Message[];          // core 协议层 Message（含 role/content/tool_calls 等）
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
  provider?: string;
  signal?: AbortSignal;
  think?: boolean;              // 开启思考链（仅 thinking capability 支持）
}

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

```ts
interface LLMService {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  getTemperature(): number;
  getMaxTokens(): number;
  getContextLength(): number;
  listModels?(): Promise<ModelInfo[]>;
  getDefaultModelId?(): string | undefined;
}
```

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
  required: [{ service: 'llm', capabilities: ['chat', 'tool_calling'] }],
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

- [@aalis/plugin-openai](../plugins/plugin-openai.md) — 通用 OpenAI 兼容
- [@aalis/plugin-deepseek](../plugins/plugin-deepseek.md) — DeepSeek（含 thinking）
- [@aalis/plugin-ollama](../plugins/plugin-ollama.md) — 本地 Ollama

## 相关

- 协议层 `Message / ToolCall / ToolDefinition` 在 `@aalis/core`
- 会话级 LLM 切换见 [plugin-session-manager-api](./plugin-session-manager-api.md)
