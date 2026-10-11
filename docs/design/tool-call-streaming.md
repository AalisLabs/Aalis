# 工具调用流式生成规约

## 背景

OpenAI、DeepSeek 等遵循 OpenAI Chat Completions 协议的 LLM 在生成 `tool_calls` 时，**完全不会发送 `delta.content`**：每个 SSE chunk 的 payload 只含 `delta.tool_calls[i].function.arguments` 的字符串增量。如果上层 LLM Provider 把这些增量直接 buffer 起来、等整段生成完才一次性 yield `ChatStreamChunk`，前端在这段时间内 **完全看不到任何反馈**，用户会以为程序卡死。

常见的做法是在这段时间显示「正在生成工具调用」加旋转动画。Aalis 需要在 WebUI 与未来其它前端中提供等价体验。

## 协议契约

### `ChatStreamChunk.toolCallProgress`（`@aalis/api-llm`）

```ts
export interface ToolCallProgress {
  /** 工具调用在本轮中的索引（OpenAI 协议里的 tool_calls[i].index） */
  index: number;
  /** 当前已确定的函数名（首个 delta 之后即可获得） */
  name: string;
  /** 已累积的 arguments JSON 字符数（不含 name），用于显示进度 */
  charsAccumulated: number;
}

export interface ChatStreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCalls?: ToolCall[];          // 仅在 done 时携带：最终完整 tool_calls
  toolCallProgress?: ToolCallProgress; // 增量进度：UI 提示用
  done?: boolean;
  usage?: { ... };
}
```

**Provider 实现职责**：每收到一次 `delta.tool_calls`（无论是否首个），里面的每个调用都必须各 yield 一个携带 `toolCallProgress` 的 chunk，一帧里带几个调用就 yield 几个（只报其中一个时，agent 按序号配的工具卡会对不上）。

**Provider 现状**：

| Provider | 实现状态 | 备注 |
| --- | --- | --- |
| `@aalis/plugin-llm-openai` | ✅ | 每个 delta 里的每个调用各 yield 一次 |
| `@aalis/plugin-llm-deepseek` | ✅ | 同 OpenAI |
| `@aalis/plugin-llm-ollama` | ✅（受限）| Ollama 一次性返回完整 tool_calls，故每个 tool 仅 emit 一次 progress |

### `StreamChunkMessage.toolCallProgress`（`@aalis/schema-message`）

agent 接到 provider 的 `toolCallProgress` 后，带上这次调用的 `callId` 转发到 `outbound:stream` 事件：

```ts
export interface StreamChunkMessage {
  sessionId: string;
  turnId: string;
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallProgress?: { index: number; name: string; charsAccumulated: number; callId: string };
  done?: boolean;
}
```

agent 在一次流式调用里按 `index` 给每个工具调用配一个 `callId`，同一个调用的几次进度带同一个。provider 每收到一个调用的增量就为它报一次进度，同一帧里有几个调用就各报一次。流结束后，provider 按 `index` 组装 `toolCalls`，序号就是调用在 `toolCalls` 里的位置：执行时同一位置、同一个工具名的调用沿用生成时的 `callId`，`tool:execute` 与 `ToolCallContext` 都带它；没报过进度的调用（provider 本地补出的调用等），以及 `agent:llm:after` 钩子改过调用列表、同一位置换了工具的，执行时另配，生成时的那张卡在回合结束时按没有执行收尾。

### 会话协议

会话服务（`@aalis/plugin-session-server`）收到带名字的进度时给出工具卡（`tool-call` 条目，`itemId` 就是 `callId`，状态 `generating`，只有工具名、`args` 为空），同一个调用之后的进度不再推；`tool:execute` 开始时同一张卡转为 `running`。生成了却没有执行的调用在回合结束时收尾，结果写「没有执行」：回合被停止的为 `aborted`，其余（达到工具调用上限、回合出错）为 `failed`。参数不合法、执行前的钩子出错这类没有执行就失败的调用，agent 照样发一对 `tool:execute`，卡片按结束的错误结果收成失败。见 [api-session-protocol](../api/api-session-protocol.md)。

## 测试要点

- **回归点**：原有 `chunk.contentDelta || chunk.usage` 决定是否 yield 的条件已扩展为 `|| chunk.toolCallProgress`，需保证不会因为单纯 progress chunk 干扰 token 计数与 segment 合并。

## 不在本规约中的内容

- 完整的 arguments JSON 流式渲染（让用户实时看到参数填充）——这是 OpenAI Playground 的体验，但实现复杂、对用户判断卡死与否无增益，本期不做。
- 跨 provider 的 reasoning（thinking）阶段流式——已通过 `reasoningDelta` 解决，不在此规约范围。
