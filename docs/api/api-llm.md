# api-llm — 大语言模型服务契约

**包名**: `@aalis/api-llm`  
**源码**: `packages/api-llm/src/index.ts`  
**实现**: `@aalis/plugin-llm-openai`, `@aalis/plugin-llm-ollama`, `@aalis/plugin-llm-deepseek`

## 概述

定义所有 LLM provider 必须满足的服务契约，以及 capability 框架（`chat / tool_calling / streaming / vision / thinking`）。每个 provider 用 `provide(llm, handle, { entryId: '${lifecycle.id}/${modelId}', label })` 为 **每个模型** 独立注册一个 entry。能力元数据在 handle 的 `capabilities` 字段上，不放进 `provide` 选项。Agent / Memory-summary 等消费方仅依赖本契约。

## 关键类型

```ts
interface ChatModelRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  think?: string;                // 深度思考的档位 id，见下文「深度思考的档位」
}
// 不含 model / provider——entry 本身已绑定到具体 model

interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  reasoningContent?: string | null;
  usage?: { promptTokens; completionTokens; totalTokens; cachedPromptTokens? };
}
```

`Message` / `ToolCall` 来自 `@aalis/schema-message`；`ToolDefinition` 来自 `@aalis/api-tools`。

## 服务接口

一个 model 就是一个 `'llm'` service entry。描述符 `llm` 是普通调用型 `ServiceRef<LLMModel>`。

```ts
interface LLMModel {
  readonly id: string;
  readonly providerId: string;
  readonly contextLength: number;
  readonly maxOutputTokens?: number;
  readonly capabilities: readonly LLMCapability[];
  readonly thinking?: ThinkingLevels; // 能调深度思考的模型才声明
  chat(request: ChatModelRequest): Promise<ChatResponse>;
  chatStream?(request: ChatModelRequest): AsyncIterable<ChatStreamChunk>;
  refresh?(): Promise<{ added: string[]; removed: string[]; total: number }>;
}
```

选哪个 model 靠服务偏好（`services.prefer(llm, contextId)`）与会话级覆盖，不再由调用方传 `provider`。

## Capability 框架

```
chat            必须 —— 提供 .chat()
tool_calling    支持 tools 字段
streaming       提供 .chatStream()
vision          支持 image 内容段
thinking        会思考（产出 reasoning_content）；能不能按请求调档看 thinking 档位
```

## 深度思考的档位

能调深度思考的模型在 handle 上声明它允许的档位，不能调的不声明：

```ts
interface ThinkingLevel { readonly id: string; readonly label: string }
interface ThinkingLevels {
  readonly levels: readonly ThinkingLevel[]; // 由浅到深，至少两档；开关型就是「关、开」两档
  readonly default: string;                  // 请求没带档位时用的那一档，须是 levels 里的一个
}

export function requestedThinking(model, request): string | undefined;
export function lightestThinking(model): string | undefined;
```

- 档位由各提供者按自己的协议定义（id 是它自己的写法），不做跨服务商的统一档位表。请求的 `think` 填其中一档的 id，没带时按模型的默认档；模型不能调时不带。
- 提供者把档位翻成线上字段之前先过 `requestedThinking`：请求带了模型没有的档位（含模型不能调时带了档位）时它抛错，请求不发出去。
- 摘要、标题、结构化提取这类机械任务要压低思考时，带 `lightestThinking(model)`（最浅的一档；模型不能调时为 `undefined`）。
- 会话设置「深度思考」存的是档位 id，可选项按会话生效的模型现取（plugin-agent 登记，见 [plugin-agent](../plugins/plugin-agent.md)）。

各提供者的档位：

| 提供者 | 哪些模型声明 | 档位 | 默认档 |
|---|---|---|---|
| DeepSeek | 能力里有 `thinking` 的 | 关、高、自动、最高 | 实例配置 `thinking` |
| OpenAI | 能力里有 `thinking` 的；`reasoning_effort` 写法下 o1-mini、o1-preview 不声明 | 按实例配置 `thinkingParam`：`reasoning_effort` 写法按模型族，gpt-5.1 起为关、低、中、高，gpt-5 为最低、低、中、高，其余为低、中、高；`thinking` 写法为关、开 | 端点自己的默认（gpt-5.1 起为关，其余为中；`thinking` 写法为开） |
| Ollama | 能力里有 `thinking` 的 | 关、开 | 实例配置 `thinking` |

消费方：

```ts
import { llm } from '@aalis/api-llm';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-llm-consumer',
  uses: { llm },
  apply({ llm }) {
    const handle = llm.current;
    if (!handle) return;
    void handle.chat({ messages: [{ role: 'user', content: 'hi' }] });
  },
});
```

## 模型引用解析

```ts
export interface ModelRef { provider?: string; model?: string }

export function listLLMModels(
  source: ServiceRef<LLMModel>,
  opts?: { caps?: readonly LLMCapability[] },
): LLMModelEntry[];

export function resolveLLMModel(
  source: ServiceRef<LLMModel>,
  ref?: ModelRef | null,
  requiredCaps?: LLMCapability[],
): LLMModelEntry | undefined;
```

按 `{ provider, model }` 查 entry：provider+model 完全匹配优先，其次只 provider / 只 model，均为空则在满足 `requiredCaps` 的范围内按偏好 > priority > 注册顺序拿首个。上层 ConfigSchema 用 `type: 'llm-ref'` 字段统一编辑。

## 提供方骨架

```ts
import { llm, type LLMModel } from '@aalis/api-llm';
import { definePlugin, lifecycle, logger, provide } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-llm',
  reusable: true,
  provides: [llm],
  uses: { provide, lifecycle, logger },
  apply({ provide, lifecycle }) {
    const handle: LLMModel = {
      id: 'demo',
      providerId: lifecycle.id,
      contextLength: 8192,
      capabilities: ['chat'],
      async chat() {
        return { content: '' };
      },
    };
    provide(llm, handle, { entryId: `${lifecycle.id}/demo`, label: 'demo' });
  },
});
```

## 实现者

- [@aalis/plugin-llm-openai](../plugins/plugin-llm-openai.md) — 通用 OpenAI 兼容
- [@aalis/plugin-llm-deepseek](../plugins/plugin-llm-deepseek.md) — DeepSeek（含思考档位）
- [@aalis/plugin-llm-ollama](../plugins/plugin-llm-ollama.md) — 本地 Ollama

## 相关

- 协议层 `Message` / `ToolCall` 在 `@aalis/schema-message`；`ToolDefinition` 在 `@aalis/api-tools`
- 会话级 LLM 切换见 [api-session-manager](./api-session-manager.md)
