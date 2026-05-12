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

- WebSocket 消息：在已有 `stream` 帧上增加 `toolCallProgress` 字段（**单条增量**：每个 chunk 只带当前更新的那一个 index）。
- `streamBuffers[sessionId]` 维护 `toolCallsProgress: Map<number, { name, charsAccumulated, startedAt }>`：
  - 同 index 复用 `startedAt`（首次记录时间）；新 index 各自记录；
  - 收到任意 `contentDelta`/`reasoningDelta` 立刻 `clear()`（进入文本阶段）；
  - 收到 `done: true` 时 `clear()`；
  - 收到 `tool:execute` `phase='start'` 时 `clear()`（实际执行开始，占位卡让位给 ToolCallBlock）。
- `stream_resume` 帧携带 `toolCallsProgress: Array<{ index, name, charsAccumulated, startedAt }>`（按 index 升序），刷新页面后**所有并发生成中的工具**立刻恢复显示。

### WebUI 客户端（`@aalis/plugin-webui-client`）

- `useWebSocket` 增加：
  - `onToolCallProgress(progress)`：单条增量；
  - `onToolCallProgressClear()`：stream done 等场景统一清空；
- `App` 维护 `toolCallsProgress: Map<number, { name, charsAccumulated, startedAt }>`；
- `ChatPanel`：**不再使用横幅**，而是**内联到 assistant 气泡末尾**，每个并发工具一张 `<ToolCallProgressCard>`：
  - 视觉与 `ToolCallBlock` 同框（共用 `.tool-call-block` 类，附加 `.tool-call-block-pending` 修饰），生成 → 执行 → 完成是同一区域**原地渐变**；
  - 文案：`<icon> <name>  142 字符 · 3.2s`；
  - 由 `App` 在以下时机清空 Map：
    - LLM 发出 `contentDelta` 或 `reasoningDelta`（回到文本阶段）；
    - `tool:execute` `phase='start'`（实际执行开始，由 `<ToolCallBlock>` 接管）；
    - stream `done: true`。
- 首轮等待（尚无 assistant 气泡）场景下，直接在 typing-indicator 占位的同一气泡里渲染占位卡。

## 测试要点

- **回归点**：原有 `chunk.contentDelta || chunk.usage` 决定是否 yield 的条件已扩展为 `|| chunk.toolCallProgress`，需保证不会因为单纯 progress chunk 干扰 token 计数与 segment 合并。
- **多 tool 并发**：单条助手消息含多个 `tool_calls[i]` 时，UI 按 index 升序渲染 N 张占位卡，**互不覆盖**；阶段切换为执行时整批让位给真正的 `<ToolCallBlock>`。
- **刷新恢复**：在 tool_call 生成中段刷新页面，`stream_resume` 会带回**所有 in-progress** 工具的快照，`已用 Xs` 从服务端 `startedAt` 继续计算。

## 不在本规约中的内容

- 完整的 arguments JSON 流式渲染（让用户实时看到参数填充）——这是 OpenAI Playground 的体验，但实现复杂、对用户判断卡死与否无增益，本期不做。
- 跨 provider 的 reasoning（thinking）阶段流式——已通过 `reasoningDelta` 解决，不在此规约范围。
