# LLM 插件 — DeepSeek / OpenAI

两个 LLM 插件共享相似架构，均实现 `LLMService` 接口并提供 `llm` 能力。

**包名**:
- `@aalis/plugin-deepseek` → `packages/plugin-deepseek/src/index.ts`
- `@aalis/plugin-openai` → `packages/plugin-openai/src/index.ts`

---

## 通用架构

两者都遵循相同的 OpenAI-compatible Chat Completions API 协议 (`/v1/chat/completions`)，因此 DeepSeek 和 OpenAI（以及任何兼容的第三方服务）可简单通过更换 `baseUrl` 来切换。

### 提供的能力

```
provides = ['llm']
```

注册时附带 capabilities 数组，由框架 ServiceContainer 根据 Agent 需求进行匹配：

```typescript
ctx.provide('llm', service, { capabilities });
```

### LLMService 接口方法

| 方法 | 说明 |
|---|---|
| `chat(request)` | 单次请求，返回完整 `ChatResponse` |
| `chatStream(request)` | 流式请求，返回 `AsyncIterable<ChatStreamChunk>` |
| `listModels()` | 获取可用模型列表（用于 WebUI 动态选项） |
| `getTemperature()` | 当前温度参数 |
| `getMaxTokens()` | 最大生成 token |
| `getContextLength()` | 上下文窗口大小 |
| `getMaxToolIterations()` | 工具调用最大循环次数 |

---

## DeepSeek 插件

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | (必填) | DeepSeek API 密钥 |
| `baseUrl` | string | `https://api.deepseek.com` | API 端点 |
| `model` | select | `deepseek-chat` | 模型名称（支持 `/models` 动态列表） |
| `temperature` | number | 0.7 | 0-2 |
| `maxTokens` | number | 8192 | 单次最大生成 token |
| `contextLength` | number | 131072 | 上下文窗口 |
| `maxToolIterations` | number | 10 | 工具调用循环上限 |
| `strictToolCalls` | boolean | false | 启用 strict JSON Schema 工具调用 |
| `capabilities` | multiselect | (自动推断) | 手动声明模型能力 |

### 思考模式 (Thinking)

当模型能力包含 `thinking` 时（如 `deepseek-reasoner`），DeepSeek 插件会：

1. 请求体添加 `thinking: { type: 'enabled' }`
2. **不传递** `temperature` 参数（思考模式下由模型自行控制）
3. 解析响应中的 `reasoning_content` 字段
4. 在流式输出中通过 `reasoningDelta` 传递推理链片段
5. 工具调用循环中保留 `reasoning_content`（通过 `msg.reasoningContent`）

### 能力映射

```typescript
'deepseek-chat'     → ['chat', 'tool_calling', 'streaming']
'deepseek-reasoner' → ['chat', 'tool_calling', 'streaming', 'thinking']
// 未匹配 → 模糊规则：名称含 'reasoner' / 'chat' → 对应能力
// 最终 fallback: ['chat', 'streaming']
```

### 流式工具调用累积

流式响应中 tool_calls 是通过多个 delta 分片到达的。插件使用 `toolCallBuffers: Map<index, {id, name, args}>` 逐步累积：

```
delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "exec" } }] }
delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }
delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }
→ 最终组装: { id: "call_1", function: { name: "exec", arguments: '{"cmd":"ls"}' } }
```

在 `[DONE]` 信号或流结束时，通过最终的 `{ done: true, toolCalls }` chunk 输出。

---

## OpenAI 插件

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | (必填) | OpenAI API 密钥 |
| `baseUrl` | string | `https://api.openai.com` | API 端点 |
| `model` | select | `gpt-4o` | 模型名称 |
| `temperature` | number | 0.7 | 0-2 |
| `maxTokens` | number | 4096 | 单次最大生成 token |
| `contextLength` | number | 128000 | 上下文窗口 |
| `maxToolIterations` | number | 10 | 工具调用循环上限 |
| `capabilities` | multiselect | (自动推断) | 手动声明模型能力 |

### 能力映射

```typescript
'gpt-4o'         → ['chat', 'tool_calling', 'streaming']
'gpt-4o-mini'    → ['chat', 'tool_calling', 'streaming']
'gpt-4-turbo'    → ['chat', 'tool_calling', 'streaming']
'gpt-4'          → ['chat', 'tool_calling', 'streaming']
'gpt-3.5-turbo'  → ['chat', 'tool_calling', 'streaming']
'o1' / 'o1-mini' → ['chat', 'thinking']          // 无 tool_calling
'o3' / 'o3-mini' → ['chat', 'tool_calling', 'streaming', 'thinking']
'o4-mini'        → ['chat', 'tool_calling', 'streaming', 'thinking']
// 未匹配 → DEFAULT: ['chat', 'tool_calling', 'streaming']
```

### 与 DeepSeek 的差异

| 特性 | DeepSeek | OpenAI |
|---|---|---|
| 思考模式 | `thinking: { type: 'enabled' }` | 无特殊处理（o 系列模型能力不同） |
| `reasoning_content` | 支持 | 不支持 |
| `strictToolCalls` | 配置项级别 strict | 仅 per-tool strict |
| 默认 maxTokens | 8192 | 4096 |
| 默认 contextLength | 131072 | 128000 |

---

## 消息转换

两个插件都在内部使用 `toAPIMessage()` 将框架 `Message` 转换为 API 格式：

- `tool_calls` → 从 `msg.toolCalls` 映射
- `tool_call_id` → 从 `msg.toolCallId` 复制
- `name` → 从 `msg.name` 复制
- `reasoning_content` → 仅 DeepSeek，从 `msg.reasoningContent` 复制

`toAPITool()` 将 `ToolDefinition` 转换为 API 的 `tools` 数组元素。
