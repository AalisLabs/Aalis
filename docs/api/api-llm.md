# api-llm — 大语言模型服务契约

**包名**: `@aalis/api-llm`  
**源码**: `packages/api-llm/src/index.ts`  
**实现**: `@aalis/plugin-llm-openai`, `@aalis/plugin-llm-ollama`, `@aalis/plugin-llm-deepseek`

## 概述

定义所有 LLM provider 必须满足的服务契约，以及 capability 框架（`chat / tool_calling / streaming / vision / thinking`）。每个 provider 用 `provide.use(llm, handle, { entryId: '${lifecycle.use.id}/${modelId}', label })` 为 **每个模型** 独立注册一个 entry。能力元数据在 handle 的 `capabilities` 字段上，不放进 `provide` 选项。Agent / Memory-summary 等消费方仅依赖本契约。

## 关键类型

```ts
interface ChatModelRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  think?: string;                // 深度思考的档位 id，见下文「深度思考的档位」
  purpose?: string;              // 记账：这次调用做什么用，见下文「记账」
  sessionId?: string;            // 记账：所在的会话
  caller?: string;               // 记账：调用方的插件实例，由绑定接口填
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

一个 model 就是一个 `'llm'` service entry。描述符 `llm` 自定义了绑定：业务层是 `LLMModel` 形状的活句柄，`chat` / `chatStream` 在请求里填上调用方这次激活的实例 id（`caller`），其余成员照原样转发。按模型选就是按条目 id 选：`caps.llm.of('<provider>/<model>')`；按能力筛遍历 `caps.llm.list()`，读条目的 `use.capabilities`。

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
  balance?(signal?: AbortSignal): Promise<LLMBalance[]>; // 服务商有余额接口才实现，见下文「记账」
}
```

选哪个 model 靠服务偏好（由用户在 WebUI 或配置 `servicePreferences` 里设）与会话级覆盖，不再由调用方传 `provider`。

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
    if (!llm.present) return;
    void llm.use.chat({ messages: [{ role: 'user', content: 'hi' }] });
  },
});
```

## 记账

每次模型调用结束、服务商报了用量时发一条 `llm:usage` 事件，记账插件（如 [plugin-usage-stats](../plugins/plugin-usage-stats.md)）订阅它：

```ts
interface LLMUsageEvent {
  provider: string;      // 模型所属 provider 的实例 id（LLMModel.providerId）
  model: string;
  caller?: string;       // 调用方的插件实例
  sessionId?: string;    // 所在的会话
  purpose?: string;      // 做什么用
  inputTokens: number;
  cachedTokens?: number; // inputTokens 里前缀缓存命中的部分；服务商不报时没有，与 0 不同
  outputTokens: number;
}

export function metered(model: LLMModel, events: Pick<Events, 'emit'>): LLMModel;
```

- **谁发：** 服务商登记模型时套一层 `metered`：`provide.use(llm, metered(handle, events.use), { entryId })`。`chat` 拿到 `usage` 时发一次；`chatStream` 在流结束时（含中途停止）按最后一次报的 `usage` 发一次；服务商没报用量的调用不记。服务商回的数运行时没人核，`metered` 发之前规整一次：输入或输出不是非负有限数的调用当没报，不记；缓存命中不是非负有限数时不带，比输入多时截到输入。服务商自己的 `chat` 与 `chatStream` 不用管记账，发事件不等监听器。三个第一方服务商都套了它。不套的服务商，调用不进用量统计，会话的 token 累计（会话管理取 `llm:usage` 记账）也不算它：这是提供者的约定，宿主不另核。
- **调用方：** `caller` 由 `llm` 的绑定接口按调用方这次激活填上，调用方自己填的不算。
- **用途与会话：** 调用方在请求里带，可以缺。`purpose` 是给人看的短语，第一方的写法：对话代理的回合是「对话」，子会话里的回合是「子任务」；压缩服务的摘要是「摘要」；媒体识别看图（含视频与动图的帧）是「识图」，转写语音（含视频的音轨）是「转写」。

**余额查询：** 服务商有余额接口时在模型上实现 `balance`，同一 provider 下所有 model entries 共享同一份，按 `providerId` 找任一 entry 调一次即可。返回一个币种一项；查不到（不可达、超时、认证失败、回应认不出）时抛错，消息带原因。

```ts
interface LLMBalance { readonly currency: string; readonly amount: number }
```

## 模型引用解析

```ts
export interface ModelRef { provider?: string; model?: string }

export function listLLMModels(
  source: Pick<ServiceSelection<LLMModel>, 'list'>,
  opts?: { caps?: readonly LLMCapability[] },
): ProviderEntry<LLMModel>[];

export function resolveLLMModel(
  source: Pick<ServiceSelection<LLMModel>, 'list'>,
  ref?: ModelRef | null,
  requiredCaps?: LLMCapability[],
): ProviderEntry<LLMModel> | undefined;
```

`source` 传 `caps.llm` 即可。返回的是选择层的条目：`id` 是条目 id，`use` 是那个模型的业务句柄；按能力过滤读 `use.capabilities`，只给 model 时按 `use.id` 匹配。

`entryId` 写成 `` `${lifecycle.use.id}/${modelId}` `` 是本契约的约定，core 不检查：`resolveLLMModel` 给全两项时按 `${provider}/${model}` 精确比较条目的 `id`，只给 provider 时按 `${provider}/` 前缀匹配，不按约定写的条目这两种引用都命不中。

按 `{ provider, model }` 查 entry：provider+model 完全匹配优先，其次只 provider / 只 model，均为空则在满足 `requiredCaps` 的范围内按 `list()` 的次序拿首个（本插件选中的那一家在前，其余按 priority 与注册顺序）。上层 ConfigSchema 用 `type: 'llm-ref'` 字段统一编辑。

## 提供方骨架

```ts
import { llm, type LLMModel, metered } from '@aalis/api-llm';
import { definePlugin, events, lifecycle, logger, provide } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-llm',
  reusable: true,
  provides: [llm],
  uses: { provide, events, lifecycle, logger },
  apply({ provide, events, lifecycle }) {
    const handle: LLMModel = {
      id: 'demo',
      providerId: lifecycle.use.id,
      contextLength: 8192,
      capabilities: ['chat'],
      async chat() {
        return { content: '' };
      },
    };
    provide.use(llm, metered(handle, events.use), { entryId: `${lifecycle.use.id}/demo`, label: 'demo' });
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
