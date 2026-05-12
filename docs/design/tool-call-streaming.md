# 工具调用流式生成规约

## 背景

OpenAI、DeepSeek 等遵循 OpenAI Chat Completions 协议的 LLM 在生成 `tool_calls` 时，**完全不会发送 `delta.content`**：每个 SSE chunk 的 payload 只含 `delta.tool_calls[i].function.arguments` 的字符串增量。如果上层 LLM Provider 把这些增量直接 buffer 起来、等整段生成完才一次性 yield `ChatStreamChunk`，前端在这段时间内 **完全看不到任何反馈**，用户会以为程序卡死。

OpenAI 自家的 ChatGPT / Codex CLI 都通过显示「Generating tool call…」加旋转动画规避此问题。Aalis 需要在 WebUI 与未来其它前端中提供等价体验。

## 协议契约

### `ChatStreamChunk.toolCallProgress`（`@aalis/plugin-llm-api`）

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
| `@aalis/plugin-openai` | ✅ | 每个 delta yield 一次 |
| `@aalis/plugin-deepseek` | ✅ | 同 OpenAI |
| `@aalis/plugin-ollama` | ✅（受限）| Ollama 一次性返回完整 tool_calls，故每个 tool 仅 emit 一次 progress |

### `StreamChunkMessage.toolCallProgress`（`@aalis/plugin-message-api`）

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

### WebUI 服务端（`@aalis/plugin-webui-server`）

- WebSocket 消息：在已有 `stream` 帧上增加 `toolCallProgress` 字段。
- `streamBuffers[sessionId]` 维护 `toolCallProgress: { index, name, charsAccumulated, startedAt }`：
  - 第一次出现某个 index 时记录 `startedAt = Date.now()`；
  - 后续同 index 的 delta 只刷新 `charsAccumulated`；
  - 收到任意 `contentDelta`/`reasoningDelta` 立刻清空（进入文本阶段）；
  - 收到 `done: true` 时清空。
- `stream_resume` 帧同时携带 `toolCallProgress`（含 `startedAt`），方便刷新页面后客户端继续显示「已用 Xs」。

### WebUI 客户端（`@aalis/plugin-webui-client`）

- `useWebSocket` 增加 `onToolCallProgress` 回调；
- `App` 维护 `toolCallProgress: { name, charsAccumulated, startedAt } | null`；
- `ChatPanel` 渲染 `<ToolCallProgressBanner>`：
  - 文案：`正在生成工具调用：<name>  已用 3.2s · 142 字符`
  - 使用 `setInterval(100)` 本地刷新 `已用 Xs`，避免依赖服务端心跳；
  - 由 `App` 在以下时机置空 banner：
    - LLM 发出 `contentDelta` 或 `reasoningDelta`（回到文本阶段）；
    - `tool:execute` start（实际执行开始，会有专用 segment 展示）；
    - stream `done: true`。

## 测试要点

- **回归点**：原有 `chunk.contentDelta || chunk.usage` 决定是否 yield 的条件已扩展为 `|| chunk.toolCallProgress`，需保证不会因为单纯 progress chunk 干扰 token 计数与 segment 合并。
- **多 tool 并发**：单条助手消息含多个 `tool_calls[i]` 时，UI 仅显示「最后一个 index」的进度（够用，避免横幅闪烁）。
- **刷新恢复**：在 tool_call 生成中段刷新页面，需立即看到 `已用 Xs` 横幅，时间从服务端记录的 `startedAt` 继续计算。

## 不在本规约中的内容

- 完整的 arguments JSON 流式渲染（让用户实时看到参数填充）——这是 OpenAI Playground 的体验，但实现复杂、对用户判断卡死与否无增益，本期不做。
- 跨 provider 的 reasoning（thinking）阶段流式——已通过 `reasoningDelta` 解决，不在此规约范围。
