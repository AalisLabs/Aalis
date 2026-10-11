# llm 服务

## 1. 定位

`llm` 是 Aalis 的 **LLM 对话服务**：把一次「消息列表 + 工具定义 → 文本/思考/工具调用」的推理调用抽象成统一契约，屏蔽 OpenAI / DeepSeek / Ollama 等后端差异。

- 服务注册名：`'llm'`（描述符 `llm`，消费方经 `llm.use` 调用；按模型选用 `llm.of('<provider>/<model>')`）。
- 契约包：`@aalis/api-llm`（`packages/api-llm/src/index.ts`），导出 `llm` 描述符与 `resolveLLMModel` 等 helper。
- 关键设计：**每个 model 是一个独立 entry**。一个 provider 插件（如 OpenAI）会按 `listModels()` 结果为**每个模型**单独 `provide.use(llm, handle, …)`，entry 已绑定具体 `(provider, model)`，`ChatModelRequest` 不再携带 `model` 字段（`packages/api-llm/src/index.ts`）。

## 2. 契约

### 核心服务接口 `LLMModel`

每个 entry 的实例满足 `LLMModel`（`packages/api-llm/src/index.ts`）：

```ts
interface LLMModel {
  readonly id: string;            // model id（provider 内唯一，如 'gpt-4o'）
  readonly providerId: string;    // 所属 provider 的 contextId（plugin instanceId）
  readonly contextLength: number; // 上下文窗口 tokens
  readonly maxOutputTokens?: number; // per-model 输出上限提示（可选）

  // 能力元数据：chat/vision/tool_calling/audio/video…——领域数据，不是 DI 选择机制
  readonly capabilities: readonly LLMCapability[];

  // 能调深度思考的模型允许的档位：由浅到深、各有 id 与显示名、一个默认档；不能调的不声明
  readonly thinking?: ThinkingLevels;

  chat(request: ChatModelRequest): Promise<ChatResponse>;
  chatStream?(request: ChatModelRequest): AsyncIterable<ChatStreamChunk>;

  // 让 webui 触发重新探测远端模型列表并增删 entries（远端动态发现型 provider 实现，静态型可不实现）
  refresh?(): Promise<{ added: string[]; removed: string[]; total: number }>;

  // 查服务商账户的余额（服务商有余额接口才实现）；一个币种一项，查不到时抛错
  balance?(signal?: AbortSignal): Promise<LLMBalance[]>;
}
```

### 请求 / 响应类型

`ChatModelRequest`（`packages/api-llm/src/index.ts`）——**不含 model/provider**，entry 已绑定：

```ts
interface ChatModelRequest {
  messages: Message[];          // 来自 @aalis/schema-message
  tools?: ToolDefinition[];     // 来自 @aalis/api-tools
  temperature?: number;
  maxTokens?: number;           // 调用方期望的输出上限——provider 必须尊重（见 §6/§7）
  signal?: AbortSignal;         // 取消
  think?: string;               // 思考档位 id（模型 thinking.levels 之一）；不带=按模型的默认档
  purpose?: string;             // 记账：这次调用做什么用（给人看的短语），调用方填
  sessionId?: string;           // 记账：所在的会话，调用方填
  caller?: string;              // 记账：调用方的插件实例，由 llm 的绑定接口填
}
```

每次调用结束、服务商报了用量时发 `llm:usage`（服务商、模型、调用方、会话、用途、输入、缓存命中、输出），由服务商登记时套的 `metered` 发出，见 [api-llm 的记账](../api/api-llm.md#记账)。

`ChatResponse`：`{ content: string | null; toolCalls?: ToolCall[]; reasoningContent?: string | null; usage?: { promptTokens, completionTokens, totalTokens, cachedPromptTokens? } }`。`cachedPromptTokens` 是 `promptTokens` 中命中 provider 前缀缓存的部分（≤ `promptTokens`），provider 不支持或本次无命中时省略；`undefined`（不可知）与 `0`（明确无命中）语义不同，消费方不要用 `?? 0` 抹平。

`ChatStreamChunk`：流式增量。字段互斥语义要点——
- `contentDelta` / `reasoningDelta`：正文 / 思考增量。
- `toolCallProgress`（`{ index, name, charsAccumulated }`）：工具调用**生成进度**，仅供 UI 渲染「正在生成工具调用」，与最终的 `toolCalls` 互斥。
- `toolCalls`：**最终**组装好的工具调用，应随 `done: true` 一起 yield。
- `usage`：可在末帧给出。

### 能力枚举 `LLMCapability`

字面量值（`packages/api-llm/src/index.ts`）：`chat` / `tool_calling` / `streaming` / `vision` / `thinking` / `audio`（原生音频理解）/ `audio_transcription`（语音转文本，独立于 audio）/ `video`（原生视频，OpenAI 逐帧 Vision 不算）。运行时常量从 `LLMCapabilities` 导入。

### 解析助手（消费方用）

- `resolveLLMModel(source, ref?, requiredCaps?): ProviderEntry<LLMModel> | undefined`——`source` 是 `Pick<ServiceSelection<LLMModel>, 'list'>`（传 `caps.llm` 即可），在 `list()` 上把 `{ provider?, model? }` 解析为最匹配的条目。解析顺序：① provider+model 都有 → 拼条目 id `${provider}/${model}` 精确查；② 仅 provider → 该 provider 下首个；③ 仅 model → 按模型自己的 `use.id` 严格匹配；④ 都空 → 取首个满足能力者（本插件选中的那一家在前，其余按挑选规则排）。
- `listLLMModels(source, { caps? }): ProviderEntry<LLMModel>[]`——列举（可按能力过滤），供 `/model` 列表与前端下拉。
- 条目是 core 的 `ProviderEntry<LLMModel>`：`{ id, label?, priority, selected, basis?, use }`，`use` 是这个模型的业务句柄，钉在这一条登记上（与按 id 解析的 `llm.of(id)` 不同，见 [选择层与业务层](../core/context.md#选择层与业务层)）。按模型选直接 `caps.llm.of('<provider>/<model>')`；按能力筛遍历 `caps.llm.list()`，读 `p.use.capabilities`。
- `ModelRef`：`{ provider?, model? }`，由 ConfigSchema `type: 'llm-ref'` 字段编辑，YAML 存为嵌套对象。
- `requestedThinking(model, request)`：提供者用，请求带的档位不是这个模型声明的（含模型不能调时带了）就抛错。
- `lightestThinking(model)`：消费方用，机械任务要压低思考时带模型最浅的一档；模型不能调时为 `undefined`。

> 关键：`resolveLLMModel` / `listLLMModels` 的 `requiredCaps` 过滤源是 **模型自带的 `use.capabilities` 元数据**，不依赖 core 的能力选择（core 0.5.0 起已移除能力维度的 DI 选择）。

## 3. 谁提供 / 谁消费

**参考实现（provider）**：
- `@aalis/plugin-llm-openai`（`packages/plugin-llm-openai/src/index.ts`）——OpenAI 兼容 `chat/completions`（`baseUrl` 为完整前缀，含版本段），远端动态发现 + 实现 `refresh`。
- `@aalis/plugin-llm-deepseek`（`packages/plugin-llm-deepseek/src/index.ts`）——DeepSeek，含思考档位（翻成 thinking.type 与 reasoning_effort）/ DSML 泄漏恢复。
- `@aalis/plugin-llm-ollama`（`packages/plugin-llm-ollama/src/index.ts`）——本地 Ollama，`/api/show` 真实能力探测 + 音频改路 OpenAI 兼容端点。

**典型消费方**：
- `@aalis/plugin-agent`（`packages/plugin-agent/src/index.ts`，解析并消费 `chatStream`、用 `maxOutputTokens` 算 token 预算）——核心对话循环。
- `@aalis/plugin-media`（`packages/plugin-media/src/llm-adapter.ts`）——扫描所有 `llm` entry，按 `capabilities` 把 vision/audio 模型包成 MediaProcessor（`chat({ messages, maxTokens, think })`，关掉思考链时带最浅的一档）。
- `@aalis/plugin-websearch-serper`（`packages/plugin-websearch-serper/src/index.ts`）——可选依赖 `llm` 压缩搜索结果。
- 其它：`plugin-memory-summary` / `plugin-user-profile` / `plugin-user-relation` / `plugin-session-manager`。

## 4. 写一个 provider

### 最小必须 vs 可选

| 成员 | 必须 | 说明 |
| --- | --- | --- |
| `id` / `providerId` / `contextLength` / `capabilities` | 必须 | entry 元数据 |
| `chat()` | 必须 | 非流式契约 |
| `chatStream()` | 强烈建议 | agent 只按 `chat` 能力挑 model，再直接调 `chatStream!`：不实现时，选中这个 model 的回合失败（见 §7） |
| `maxOutputTokens` | 建议 | 否则消费方回退默认值，token 预算估算变粗 |
| `refresh()` | 可选 | 仅远端动态发现型需要；没有时 webui 的「刷新」按钮照常显示，点击后提示该 provider 不支持运行时刷新 |
| `balance()` | 可选 | 服务商有余额接口才实现；记账插件的「余额」一页按它出现 |

### 双源 manifest 必须同步

provider 既要在源码导出 `provides`，又要在 `package.json` 写 `aalis.service.provides`（见 [manifest 元数据](../concepts/manifest-metadata.md)）：

源码入口是 `export default definePlugin({ name, subsystem: 'llm', reusable: true, provides: [llm], uses: { config, logger, lifecycle, provide, events }, apply })`（`packages/plugin-llm-deepseek/src/index.ts`）。多实例靠 `reusable`，归组靠 `subsystem`；不要再写具名 `export const subsystem`。

`package.json`（`packages/plugin-llm-deepseek/package.json`）：
```json
{ "aalis": { "service": { "provides": ["llm"] } } }
```
若依赖可选服务（如 Ollama 用 `process` 读本地文件），两处都要写 `uses optional` / `aalis.service.optional`（`packages/plugin-llm-ollama/src/index.ts`、`package.json`）。

### 注册：每个 model 一个 entry

参考 `packages/plugin-llm-deepseek/src/index.ts`：

```ts
import { llm, metered } from '@aalis/api-llm';
import type { ChatModelRequest, ChatResponse, LLMCapability, LLMModel } from '@aalis/api-llm';
import { config, definePlugin, events, lifecycle, logger, provide } from '@aalis/core';
import { prepareLLMMessages } from '@aalis/schema-message';

class MyModelHandle implements LLMModel {
  id = 'demo';
  providerId = '';
  contextLength = 8192;
  maxOutputTokens = 2048;
  capabilities: readonly LLMCapability[] = [];

  async chat(request: ChatModelRequest): Promise<ChatResponse> {
    const messages = prepareLLMMessages(request.messages);
    void messages;
    return { content: '' };
  }
}

export default definePlugin({
  name: '@acme/plugin-example',
  provides: [llm],
  uses: { provide, events, logger, lifecycle, config },
  async apply({ provide, events, logger, lifecycle, config }) {
    void config;
    const handle = new MyModelHandle();
    handle.providerId = lifecycle.use.id;
    provide.use(llm, metered(handle, events.use), {
      entryId: `${lifecycle.use.id}/${handle.id}`,
      label: `MyProvider / ${handle.id}`,
    });
    logger.use.info('llm model registered');
  },
});
```

要点：
- **`entryId` 必须是 `${lifecycle.use.id}/${modelId}`**——`resolveLLMModel` 用条目 `id === \`${provider}/${model}\`` 精确命中，`llm.of(...)` 也按它找（`packages/api-llm/src/index.ts`）；不按此约定会导致 `llm-ref` 选择失效。
- 不要传 `priority`，默认 `0` 即可；用户通过 preference 选默认 model（见 §5）。同名多 provider 并存时，消费方选中哪一家按本插件偏好 > 全局偏好 > priority > 注册顺序（[服务模型](../concepts/service-model.md)）。
- `capabilities` 要**如实**反映该 model 实际能力——它驱动 media 的多模态处理器注册与前端过滤（§6）。
- `provide.use` 返回 dispose 函数；实现 `refresh()` 时缓存它以便增删 entry（`packages/plugin-llm-ollama/src/index.ts`）。
- 登记时套上 `metered(handle, events.use)`：拿到用量的调用发 `llm:usage`，自己的 `chat` 与 `chatStream` 不用管记账（[api-llm 的记账](../api/api-llm.md#记账)）。

## 5. 消费方标准用法

### 业务句柄是活的 + 按 ref 解析

`llm.use` 是活的业务句柄，条目的 `use` 钉在那一条登记上，两者的规则见 [选择层与业务层](../core/context.md#选择层与业务层)。按配置里的 `ModelRef` 选模型时用 `resolveLLMModel`，它顺带做 ref 解析与能力过滤；调用经条目的 `use`，`llm` 的绑定给请求盖上 `caller`：

```ts
import { resolveLLMModel } from '@aalis/api-llm';

const entry = resolveLLMModel(llm, cfg.compressionLLM /* ModelRef */, ['chat']);
if (!entry) return rawResults;                 // 服务缺失/无满足能力者 → 优雅降级
try {
  const resp = await entry.use.chat({ messages, maxTokens: 1024 });
  return resp.content?.trim() || rawResults;
} catch (err) {
  logger.use.warn(`LLM 调用失败，降级：${err}`);
  return rawResults;                            // 错误边界：provider 抛错要兜住
}
```
（实证：`packages/plugin-websearch-serper/src/index.ts`，并配 `uses optional: ['llm']`。）

### 可选依赖处理

消费方若把 LLM 当可选增强，用 `uses optional`，`resolveLLMModel` 返回 `undefined`（或 `llm.present` 为 `false`）时降级（如上）。若是硬依赖，用 `uses` 必选，并在 ref 解析不到时报错。agent 以 optional 声明 llm，没有模型时照常激活，取不到模型的回合报出原因。

### 流式消费

agent 按 `resolveLLMModel(this.caps.llm, ref, ['chat'])` 只要求 `chat` 能力，对解析到的条目取 `use` 后直接调 `chatStream!`（`packages/plugin-agent/src/index.ts`），不检查 `streaming`。自己写的消费方要流式时，按 `streaming` 能力筛选，或对 `chatStream` 存在性做判定后回退 `chat`。流中要尊重 `signal.aborted`。

### 选默认 model

未传 ref 时，`resolveLLMModel` 取 `list()` 里首个满足能力的条目（本插件选中的那一个模型在前）。全局默认 model 由用户设：WebUI 设置「会话默认」全局默认层的「模型」，或配置的 `servicePreferences`（见 [配置](../core/config.md)）；插件代码不写偏好，管理面代码对应 `services.use.prefer('llm', contextId)`（contextId = `${provider}/${model}`）。会话级覆盖走 `session-manager.resolveConfig`（`packages/plugin-agent/src/index.ts`）。token 预算估算用 `maxOutputTokens`：`tokenBudget ≈ contextLength - maxOutputTokens - safetyMargin`。

## 6. 能力 / 风险 → 影响

### 出口必须调 `prepareLLMMessages`（强约束）

provider 在**序列化前**（流式与非流式两条路径都要）必须先调 `prepareLLMMessages(request.messages)`（`@aalis/schema-message`，`packages/schema-message/src/index.ts`）。它把自定义 role 转成 `WellKnownRole`（`system/user/assistant/tool`）并给 content 加前缀（如 `notice`→system 加 `[系统通知]`、kind `cross-session-delegation` 加 `[跨会话委派]`）。逐条再用 `toLLMRole` 做幂等防御。**跳过它会导致**：① provider 收到非法 role 报错；② `[系统通知]`/`[跨会话委派]` 等语义前缀丢失。详见 [消息→LLM 管线](../concepts/message-llm-pipeline.md)。

### 任何 message-URL 抓取必须走 `safeFetch`

若 provider 需要从消息里的 URL 拉取图片/音频字节（如 Ollama 把 image URL 下载转 base64），必须用 `safeFetch`（`@aalis/util-network-guard`）而非裸 `fetch`，以防 SSRF（实证：`packages/plugin-llm-ollama/src/index.ts`）。调 provider 自家 API 端点的 `fetch` 不受此限（那是配置可信的 baseUrl）。详见 [安全模型](../concepts/security-model.md)。

### capabilities 是领域元数据，驱动下游发现

`capabilities` 决定 media 是否把该 model 当 vision/audio 处理器（`packages/plugin-media/src/llm-adapter.ts`）。乱标会让不支持的 model 被喂多模态输入而报错；漏标则该能力不可用。Ollama 的正确做法是优先用 `/api/show` 的真实 `capabilities`，再回退家族表（`packages/plugin-llm-ollama/src/index.ts`）。

### 该服务**不涉及** authority/确认/沙盒

`llm` 是出口推理服务，本身不做 authority 风险分级或 HITL 确认——这些发生在工具层（`tools` 服务的执行守卫，确认经 `approvals` 审批）。provider 不要在 chat 路径里塞鉴权逻辑。

## 7. 注意事项与边界情形（审计标注）

1. **尊重调用方 `maxTokens`**：provider 必须用 `request.maxTokens ?? 配置默认`，不能硬编码字面量。OpenAI 早期把上限硬编码为 `4096`，现已修正为 `request.maxTokens ?? this.maxTokens`（`packages/plugin-llm-openai/src/index.ts`），DeepSeek、Ollama（`num_predict`）同。新 provider 照此实现。

2. **OpenAI 推理模型**：o 系列（o1/o3/o4 等）与 gpt-5 系列（`gpt-5`、`gpt-5-mini`、`gpt-5-nano`、`gpt-5-chat` 等）**不接受** `max_tokens`（需 `max_completion_tokens`）、**不接受**非默认 `temperature`。provider 必须按模型名分支：`isReasoningModel` 命中时用 `max_completion_tokens` 且**省略** `temperature`（`packages/plugin-llm-openai/src/index.ts`）。

3. **DeepSeek `forceJsonOutput` 会破坏 tool_calls**：`response_format: {type:'json_object'}` 与 `tool_calls` 互斥，同时下发会破坏工具调用循环。provider 必须**仅在无 tools 时**加 `response_format`（`packages/plugin-llm-deepseek/src/index.ts`）。DeepSeek 还会把原生工具调用标记（DSML）泄漏进 `content`，需本地解析恢复；流式分支同理。

4. **Ollama 非流式路径也必须 `prepareLLMMessages`**：曾有 bug 仅在流式分支调用，导致非流式丢 `[系统通知]`/`[跨会话委派]` 前缀。现已对齐（`packages/plugin-llm-ollama/src/index.ts`）。音频请求会自动改路到 OpenAI 兼容 `/v1/chat/completions`（`/api/chat` 不支持 audios），该路径也先 `prepareLLMMessages`。

5. **`chatStream` 是可选的，但 agent 直接 `chatStream!()`**：agent 用非空断言调用（`packages/plugin-agent/src/index.ts`），意味着被选为对话 model 的 entry 实际需要实现 `chatStream`。只实现 `chat` 的 model 不应被 preference 选为对话默认（可只用于 media 处理器等只调 `chat` 的场景）。

6. **`think` 的语义**：`request.think === undefined` 表示「按模型的默认档」，带了就必须是模型声明的档位之一，提供者经 `requestedThinking` 拒绝别的值。各提供者按自己的协议翻译：DeepSeek 总是明说 `thinking.type`（v4 系列不发会保持开启），Ollama 对能思考的模型总是明说 `think`（原生思考模型省略字段会默认思考，content 可能为空），OpenAI 只在请求带了档位时发字段（`packages/plugin-llm-*/src/index.ts`）。

7. **per-model entry 注册顺序 = 优先级稳定性**：Ollama 并行探测能力时保留顺序以保证注册顺序稳定（`packages/plugin-llm-ollama/src/index.ts`），因为相同 priority 下注册顺序是挑选规则的最后一道裁决（[服务模型](../concepts/service-model.md)）。

## 8. 交叉链接

- [服务模型](../concepts/service-model.md)——按名 DI、同名多实现、本插件偏好 > 全局偏好 > priority > 注册顺序、`provide`。
- [惰性服务访问](../concepts/lazy-service-access.md)——业务句柄为什么是活的、provider bounce。
- [manifest 元数据](../concepts/manifest-metadata.md)——`provides`/`uses` 双源同步。
- [消息→LLM 管线](../concepts/message-llm-pipeline.md)——`prepareLLMMessages` / role 转译 / kind 前缀。
- [安全模型](../concepts/security-model.md)——`safeFetch` SSRF 防护。
- [core/service](../core/service.md)、[plugins/plugin-tools](../plugins/plugin-tools.md)、[core/context](../core/context.md)、[plugins/plugin-authority](../plugins/plugin-authority.md)。
