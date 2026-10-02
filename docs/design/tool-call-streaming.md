# 工具调用流式生成规约

## 背景

OpenAI、DeepSeek 等遵循 OpenAI Chat Completions 协议的 LLM 在生成 `tool_calls` 时，**完全不会发送 `delta.content`**：每个 SSE chunk 的 payload 只含 `delta.tool_calls[i].function.arguments` 的字符串增量。如果上层 LLM Provider 把这些增量直接 buffer 起来、等整段生成完才一次性 yield `ChatStreamChunk`，前端在这段时间内 **完全看不到任何反馈**，用户会以为程序卡死。

OpenAI 自家的 ChatGPT / Codex CLI 都通过显示「Generating tool call…」加旋转动画规避此问题。Aalis 需要在 WebUI 与未来其它前端中提供等价体验。

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

**Provider 实现职责**：每收到一次 `delta.tool_calls`（无论是否首个），都必须 yield 一个携带 `toolCallProgress` 的 chunk（可以与 `contentDelta` 同时携带，但通常单独）。

**Provider 现状**：

| Provider | 实现状态 | 备注 |
| --- | --- | --- |
| `@aalis/plugin-llm-openai` | ✅ | 每个 delta yield 一次 |
| `@aalis/plugin-llm-deepseek` | ✅ | 同 OpenAI |
| `@aalis/plugin-llm-ollama` | ✅（受限）| Ollama 一次性返回完整 tool_calls，故每个 tool 仅 emit 一次 progress |

### `StreamChunkMessage.toolCallProgress`（`@aalis/schema-message`）

agent 接到 provider 的 `toolCallProgress` 后，转发到 `outbound:stream` 事件：

```ts
export interface StreamChunkMessage {
  sessionId: string;
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallProgress?: { index: number; name: string; charsAccumulated: number };
  done?: boolean;
}
```

Agent 端无需新增状态——只要把 `chunk.toolCallProgress` 透传到事件即可。

### 会话协议

会话服务（`@aalis/plugin-session-server`）目前不把 `toolCallProgress` 推给客户端：会话协议的条目里没有「生成中的工具调用」这一种，工具卡在 `tool:execute` 开始执行时才出现（见 [api-session-protocol](../api/api-session-protocol.md)）。

## 测试要点

- **回归点**：原有 `chunk.contentDelta || chunk.usage` 决定是否 yield 的条件已扩展为 `|| chunk.toolCallProgress`，需保证不会因为单纯 progress chunk 干扰 token 计数与 segment 合并。

## 不在本规约中的内容

- 完整的 arguments JSON 流式渲染（让用户实时看到参数填充）——这是 OpenAI Playground 的体验，但实现复杂、对用户判断卡死与否无增益，本期不做。
- 跨 provider 的 reasoning（thinking）阶段流式——已通过 `reasoningDelta` 解决，不在此规约范围。
