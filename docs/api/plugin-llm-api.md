# plugin-llm-api — 大语言模型服务契约

**包名**: `@aalis/plugin-llm-api`  
**源码**: `packages/plugin-llm-api/src/index.ts`  
**实现**: `@aalis/plugin-openai`, `@aalis/plugin-ollama`, `@aalis/plugin-deepseek`, `@aalis/plugin-llm-router`

## 概述

定义所有 LLM provider 必须满足的服务契约，以及 capability 框架（`chat / tool_calling / streaming / vision / thinking / router`）。Agent / Memory-summary / Image-recognition 等消费方仅依赖本契约。

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
router          自身不调用模型，转发给其他 LLM 实例（plugin-llm-router）
```

声明依赖：

```ts
export const inject = {
  required: [{ service: 'llm', capabilities: ['chat', 'tool_calling'] }],
};
```

## 模型引用解析

```ts
export function parseModelRef(value: string | null | undefined): ModelRef;
export function formatModelRef(ref: ModelRef): string;
```

支持 `provider:model` 或 `model@provider` 的字符串形式互转，常用于会话级 `model` 配置与 `/model` 指令。

## 实现者

- [@aalis/plugin-openai](../plugins/plugin-openai.md) — 通用 OpenAI 兼容
- [@aalis/plugin-deepseek](../plugins/plugin-deepseek.md) — DeepSeek（含 thinking）
- [@aalis/plugin-ollama](../plugins/plugin-ollama.md) — 本地 Ollama
- `@aalis/plugin-llm-router` — 路由器，按规则转发

## 相关

- 协议层 `Message / ToolCall / ToolDefinition` 在 `@aalis/core`
- 会话级 LLM 切换见 [plugin-session-manager-api](./plugin-session-manager-api.md)
