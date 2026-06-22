# llm 服务

## 1. 定位

`llm` 是 Aalis 的 **LLM 对话服务**：把一次「消息列表 + 工具定义 → 文本/思考/工具调用」的推理调用抽象成统一契约，屏蔽 OpenAI / DeepSeek / Ollama 等后端差异。

- 服务注册名：`getService<LLMModel>('llm')`（DI 容器里的字符串键）。
- 契约包：`@aalis/plugin-llm-api`（`packages/plugin-llm-api/src/index.ts`，`aalis.types: true` 的纯类型契约包）。
- 关键设计：**每个 model 是一个独立 entry**。一个 provider 插件（如 OpenAI）会按 `listModels()` 结果为**每个模型**单独 `ctx.provide('llm', handle, …)`，entry 已绑定具体 `(provider, model)`，`ChatModelRequest` 不再携带 `model` 字段（`packages/plugin-llm-api/src/index.ts:61-91`）。

## 2. 契约

### 核心服务接口 `LLMModel`

每个 entry 的实例满足 `LLMModel`（`packages/plugin-llm-api/src/index.ts:92-127`）：

```ts
interface LLMModel {
  readonly id: string;            // model id（provider 内唯一，如 'gpt-4o'）
  readonly providerId: string;    // 所属 provider 的 contextId（plugin instanceId）
  readonly contextLength: number; // 上下文窗口 tokens
  readonly maxOutputTokens?: number; // per-model 输出上限提示（可选）

  // 能力元数据：chat/vision/tool_calling/audio/video…——领域数据，不是 DI 选择机制
  readonly capabilities: readonly LLMCapability[];

  chat(request: ChatModelRequest): Promise<ChatResponse>;
  chatStream?(request: ChatModelRequest): AsyncIterable<ChatStreamChunk>;

  // 让 webui 触发重新探测远端模型列表并增删 entries（远端动态发现型 provider 实现，静态型可不实现）
  refresh?(): Promise<{ added: string[]; removed: string[]; total: number }>;
}
```

### 请求 / 响应类型

`ChatModelRequest`（`packages/plugin-llm-api/src/index.ts:68-76`）——**不含 model/provider**，entry 已绑定：

```ts
interface ChatModelRequest {
  messages: Message[];          // 来自 @aalis/plugin-message-api
  tools?: ToolDefinition[];     // 来自 @aalis/plugin-tools-api
  temperature?: number;
  maxTokens?: number;           // 调用方期望的输出上限——provider 必须尊重（见 §6/§7）
  signal?: AbortSignal;         // 取消
  think?: boolean;              // 思考开关：undefined=随模型默认，true/false=显式覆盖
}
```

`ChatResponse`（`:10-19`）：`{ content: string | null; toolCalls?: ToolCall[]; reasoningContent?: string | null; usage?: { promptTokens, completionTokens, totalTokens } }`。

`ChatStreamChunk`（`:35-47`）：流式增量。字段互斥语义要点——
- `contentDelta` / `reasoningDelta`：正文 / 思考增量。
- `toolCallProgress`（`:26-33`，`{ index, name, charsAccumulated }`）：工具调用**生成进度**，仅供 UI 渲染「正在生成工具调用」，与最终的 `toolCalls` 互斥。
- `toolCalls`：**最终**组装好的工具调用，应随 `done: true` 一起 yield。
- `usage`：可在末帧给出。

### 能力枚举 `LLMCapability`

字面量值（`packages/plugin-llm-api/src/index.ts:131-156`）：`chat` / `tool_calling` / `streaming` / `vision` / `thinking` / `audio`（原生音频理解）/ `audio_transcription`（语音转文本，独立于 audio）/ `video`（原生视频，OpenAI 逐帧 Vision 不算）。运行时常量从 `LLMCapabilities` 导入。

### 解析助手（消费方用）

- `resolveLLMModel(ctx, ref?, requiredCaps?): LLMModelEntry | undefined`（`:219-229`）——把 `{ provider?, model? }` 解析为最匹配 entry。解析顺序：① provider+model 都有 → 拼 entryId `${provider}/${model}` 精确查；② 仅 provider → 该 provider 下首个；③ 仅 model → 全局按 `instance.id` 匹配；④ 都空 → 取首个满足能力者（即按 preference/priority/注册顺序的容器胜者）。
- `listLLMModels(ctx, { caps? }): LLMModelEntry[]`（`:204-206`）——列举（可按能力过滤），供 `/model` 列表与前端下拉。
- `LLMModelEntry`（`:173-177`）：`{ instance: LLMModel; contextId: string; label? }`。
- `ModelRef`（`:183-188`）：`{ provider?, model? }`，由 ConfigSchema `type: 'llm-ref'` 字段编辑（`:158-168`），YAML 存为嵌套对象。

> 关键：`resolveLLMModel` / `listLLMModels` 的 `requiredCaps` 过滤源是 **handle 自带的 `instance.capabilities` 元数据**，不依赖 core 的能力选择（core 0.5.0 起已移除能力维度的 DI 选择，见 `:194-198`）。

## 3. 谁提供 / 谁消费

**参考实现（provider）**：
- `@aalis/plugin-openai`（`packages/plugin-openai/src/index.ts`）——OpenAI 兼容 `/v1/chat/completions`，远端动态发现 + 实现 `refresh`。
- `@aalis/plugin-deepseek`（`packages/plugin-deepseek/src/index.ts`）——DeepSeek，含 thinking / reasoning_effort / DSML 泄漏恢复。
- `@aalis/plugin-ollama`（`packages/plugin-ollama/src/index.ts`）——本地 Ollama，`/api/show` 真实能力探测 + 音频改路 OpenAI 兼容端点。

**典型消费方**：
- `@aalis/plugin-agent`（`packages/plugin-agent/src/index.ts:104-116` 解析、`:226` 消费 `chatStream`、`:43-45 / :437` 用 `maxOutputTokens` 算 token 预算）——核心对话循环。
- `@aalis/plugin-media`（`packages/plugin-media/src/llm-adapter.ts:426-449`）——扫描所有 `llm` entry，按 `capabilities` 把 vision/audio/video 模型包成 MediaProcessor（`chat({ messages, maxTokens, think })`，`:318/:365`）。
- `@aalis/plugin-websearch-serper`（`packages/plugin-websearch-serper/src/index.ts:253-272`）——可选依赖 `llm` 压缩搜索结果。
- 其它：`plugin-memory-summary` / `plugin-user-profile` / `plugin-user-relation` / `plugin-session-manager`。

## 4. 写一个 provider

### 最小必须 vs 可选

| 成员 | 必须 | 说明 |
| --- | --- | --- |
| `id` / `providerId` / `contextLength` / `capabilities` | 必须 | entry 元数据 |
| `chat()` | 必须 | 非流式契约 |
| `chatStream()` | 强烈建议 | 不实现则该 model 无 `streaming` 能力，agent 会跳过它（agent 直接调 `chatStream!`，见 §7） |
| `maxOutputTokens` | 建议 | 否则消费方回退默认值，token 预算估算变粗 |
| `refresh()` | 可选 | 仅远端动态发现型需要；webui 据此显示「刷新」按钮 |

### 双源 manifest 必须同步

provider 既要在源码导出 `provides`，又要在 `package.json` 写 `aalis.service.provides`（见 [manifest 元数据](../concepts/manifest-metadata.md)）：

源码（`packages/plugin-deepseek/src/index.ts:32-35`）：
```ts
export const subsystem = 'llm';
export const provides = ['llm'];
export const reusable = true; // LLM provider 通常允许多实例（不同 baseUrl/账号）
```

`package.json`（`packages/plugin-deepseek/package.json`）：
```json
{ "aalis": { "service": { "provides": ["llm"] } } }
```
若依赖可选服务（如 Ollama 用 `process` 读本地文件），两处都要写 `inject.optional` / `aalis.service.optional`（`packages/plugin-ollama/src/index.ts:16`、`package.json`）。

### 注册：每个 model 一个 entry

参考 `packages/plugin-deepseek/src/index.ts:824-854`：

```ts
class MyModelHandle implements LLMModel {
  constructor(
    private client: MyClient,
    readonly id: string,
    readonly providerId: string,
    readonly contextLength: number,
    readonly maxOutputTokens: number,
    readonly capabilities: readonly LLMCapability[],
  ) {}

  async chat(request: ChatModelRequest): Promise<ChatResponse> {
    // 出口必须先 prepareLLMMessages（见 §6）
    const messages = prepareLLMMessages(request.messages).map(m => this.toAPIMessage(m));
    const body = {
      model: this.id,
      messages,
      max_tokens: request.maxTokens ?? this.client.maxTokens, // 尊重调用方 maxTokens！
      temperature: request.temperature ?? this.client.temperature,
      ...(request.tools?.length ? { tools: request.tools.map(toAPITool) } : {}),
    };
    // … fetch；非流式同样要 prepareLLMMessages …
  }

  // 不实现 chatStream → 该 model 无 streaming 能力
  async *chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> { /* SSE 解析 → yield chunk */ }
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const client = new MyClient(config, ctx.logger);
  const modelIds = await client.fetchRemoteModelIds(); // + 合并 customModels
  for (const modelId of modelIds) {
    const handle = new MyModelHandle(client, modelId, ctx.id, contextLength, maxOutputTokens, resolveCaps(modelId));
    ctx.provide('llm', handle, {
      entryId: `${ctx.id}/${modelId}`,         // 关键：per-entry id，resolveLLMModel 按它精确查找
      label: `MyProvider / ${modelId}`,         // webui 下拉显示
    });
  }
}
```

要点：
- **`entryId` 必须是 `${ctx.id}/${modelId}`**——`resolveLLMModel` 用 `contextId === \`${provider}/${model}\`` 精确命中（`packages/plugin-llm-api/src/index.ts:225`）；不按此约定会导致 `llm-ref` 选择失效。
- 不要传 `priority`，默认 `ServicePriority.Backend(0)` 即可；用户通过 preference / persona 选默认 model（见 §5）。同名多 provider 并存由容器按 preference>priority>注册顺序裁决（[服务模型](../concepts/service-model.md)）。
- `capabilities` 要**诚实**反映该 model 实际能力——它驱动 media 的多模态处理器注册与前端过滤（§6）。
- `ctx.provide` 返回 dispose 函数；实现 `refresh()` 时缓存它以便增删 entry（`packages/plugin-ollama/src/index.ts:1079-1095`）。

## 5. 标准消费姿势

### lazy getService + 每次重取

不要缓存 entry/handle：provider bounce（重载）会让旧 instance 失效，必须每次用时重取（见 [惰性服务访问](../concepts/lazy-service-access.md)）。推荐用 `resolveLLMModel` 而非直接 `getService`，因为它顺带做 ref 解析与能力过滤：

```ts
import { resolveLLMModel } from '@aalis/plugin-llm-api';

const entry = resolveLLMModel(ctx, cfg.compressionLLM /* ModelRef */, ['chat']);
if (!entry) return rawResults;                 // 服务缺失/无满足能力者 → 优雅降级
try {
  const resp = await entry.instance.chat({ messages, maxTokens: 1024 });
  return resp.content?.trim() || rawResults;
} catch (err) {
  ctx.logger.warn(`LLM 调用失败，降级：${err}`);
  return rawResults;                            // 错误边界：provider 抛错要兜住
}
```
（实证：`packages/plugin-websearch-serper/src/index.ts:253-272`，并配 `inject.optional: ['llm']`，`:22-23`。）

### 可选依赖处理

消费方若把 LLM 当可选增强，用 `inject.optional`，`resolveLLMModel`/`getService` 返回 `undefined` 时降级（如上）。若是硬依赖（如 agent），用 `inject` 必选，并在 ref 解析不到时报错。

### 流式消费

agent 直接调 `llm.chatStream!(request)`（`packages/plugin-agent/src/index.ts:226`）——因此它通过 `resolveLLMModel(ctx, ref, ['chat'])` 拿到的 model 默认假定能 chat；若要流式，应确保选中的 model 声明了 `streaming`，或对 `chatStream` 存在性做判定后回退 `chat`。流中要尊重 `signal.aborted`（`:228-229`）。

### 选默认 model

未传 ref 时，`resolveLLMModel` 取容器胜者。要锁定全局默认 model，用 `ctx.preferService('llm', contextId)`（contextId = `${provider}/${model}`）或 persona.yaml 的 `defaultServices`（`packages/plugin-llm-api/src/index.ts:88-90`）；会话级覆盖走 `session-manager.resolveConfig`（`packages/plugin-agent/src/index.ts:104-115`）。token 预算估算用 `maxOutputTokens`：`tokenBudget ≈ contextLength - maxOutputTokens - safetyMargin`（`:43-45 / :437-442`）。

## 6. 能力 / 风险 → 影响

### 出口必须调 `prepareLLMMessages`（强约束）

provider 在**序列化前**（流式与非流式两条路径都要）必须先调 `prepareLLMMessages(request.messages)`（`@aalis/plugin-message-api`，`packages/plugin-message-api/src/index.ts:380-390`）。它把自定义 role 转成 `WellKnownRole`（`system/user/assistant/tool`，`:69`）并给 content 加前缀（如 `notice`→system 加 `[系统通知]`、kind `cross-session-delegation` 加 `[跨会话委派]`，`:344-360`）。逐条再用 `toLLMRole`（`:366-371`）做幂等防御。**跳过它会导致**：① provider 收到非法 role 报错；② `[系统通知]`/`[跨会话委派]` 等语义前缀丢失。详见 [消息→LLM 管线](../concepts/message-llm-pipeline.md)。

### 任何 message-URL 抓取必须走 `safeFetch`

若 provider 需要从消息里的 URL 拉取图片/音频字节（如 Ollama 把 image URL 下载转 base64），必须用 `safeFetch`（`@aalis/util-network-guard`）而非裸 `fetch`，以防 SSRF（实证：`packages/plugin-ollama/src/index.ts:615`）。调 provider 自家 API 端点的 `fetch` 不受此限（那是配置可信的 baseUrl）。详见 [安全模型](../concepts/security-model.md)。

### capabilities 是领域元数据，驱动下游发现

`capabilities` 决定 media 是否把该 model 当 vision/audio/video 处理器（`packages/plugin-media/src/llm-adapter.ts:436-449`）。乱标会让不支持的 model 被喂多模态输入而报错；漏标则该能力不可用。Ollama 的正确做法是优先用 `/api/show` 的真实 `capabilities`，再回退家族表（`packages/plugin-ollama/src/index.ts:923-965`）。

### 该服务**不涉及** authority/确认/沙盒

`llm` 是出口推理服务，本身不做 authority 风险分级或 HITL 确认——这些发生在工具层（`tools` 服务 + `session-confirm`）。provider 不要在 chat 路径里塞鉴权逻辑。

## 7. 边界与坑（审计标注）

1. **尊重调用方 `maxTokens`**：provider 必须用 `request.maxTokens ?? 配置默认`，不能硬编码字面量。OpenAI 早期把上限硬编码为 `4096`，现已修正为 `request.maxTokens ?? this.maxTokens`（`packages/plugin-openai/src/index.ts:207`），DeepSeek（`:245`）、Ollama（`num_predict`，`:268`）同。新 provider 照此实现。

2. **OpenAI o 系列推理模型**：o1/o3/o4 等**不接受** `max_tokens`（需 `max_completion_tokens`）、**不接受**非默认 `temperature`。provider 必须按模型名分支：`isReasoningModel` 命中时用 `max_completion_tokens` 且**省略** `temperature`（`packages/plugin-openai/src/index.ts:151-154, 201-209`）。

3. **DeepSeek `forceJsonOutput` 会破坏 tool_calls**：`response_format: {type:'json_object'}` 与 `tool_calls` 互斥，同时下发会破坏工具调用循环。provider 必须**仅在无 tools 时**加 `response_format`（`packages/plugin-deepseek/src/index.ts:264-268, 384-388`）。DeepSeek 还会把原生工具调用标记（DSML）泄漏进 `content`，需本地解析恢复（`:299-328`）；流式分支同（`:484-498`）。

4. **Ollama 非流式路径也必须 `prepareLLMMessages`**：曾有 bug 仅在流式分支调用，导致非流式丢 `[系统通知]`/`[跨会话委派]` 前缀。现已对齐（`packages/plugin-ollama/src/index.ts:257-259`）。音频请求会自动改路到 OpenAI 兼容 `/v1/chat/completions`（`/api/chat` 不支持 audios），该路径也先 `prepareLLMMessages`（`:704-735`）。

5. **`chatStream` 是可选的，但 agent 直接 `chatStream!()`**：agent 用非空断言调用（`packages/plugin-agent/src/index.ts:226`），意味着被选为对话 model 的 entry 实际需要实现 `chatStream`。只实现 `chat` 的 model 不应被 preference 选为对话默认（可只用于 media 处理器等只调 `chat` 的场景）。

6. **`think` 默认语义**：`request.think === undefined` 表示「随模型默认」，`false` 表示显式关闭。Ollama 原生 thinking 模型必须显式传 `think:false` 才能关闭，仅省略字段会被默认启用导致 content 为空（`packages/plugin-ollama/src/index.ts:280-283`）。

7. **per-model entry 注册顺序 = 优先级稳定性**：Ollama 并行探测能力时保留顺序以保证注册顺序稳定（`packages/plugin-ollama/src/index.ts:1113-1115`），因为相同 priority 下注册顺序是 DI 胜者的最后一道裁决（[服务模型](../concepts/service-model.md)）。

## 8. 交叉链接

- [服务模型](../concepts/service-model.md)——按名 DI、同名多实现、preference>priority>注册顺序裁决、`ctx.provide`。
- [惰性服务访问](../concepts/lazy-service-access.md)——为何每次重取、provider bounce。
- [manifest 元数据](../concepts/manifest-metadata.md)——`provides`/`inject` 双源同步。
- [消息→LLM 管线](../concepts/message-llm-pipeline.md)——`prepareLLMMessages` / role 转译 / kind 前缀。
- [安全模型](../concepts/security-model.md)——`safeFetch` SSRF 防护。
- [core/service](../core/service.md)、[core/tools](../core/tools.md)、[core/context](../core/context.md)、[core/authority](../core/authority.md)。
