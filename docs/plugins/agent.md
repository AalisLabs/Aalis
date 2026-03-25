# Agent 插件 — DefaultAgent

默认对话编排器，负责从消息接收到回复发送的完整流程。

**包名**: `@aalis/plugin-agent-default`  
**源码**: `packages/plugin-agent-default/src/index.ts`

---

## 元信息

```typescript
provides = ['agent']
inject = { optional: ['llm', 'memory', 'persona'] }
```

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `systemPrompt` | string | 内置行为准则 | Agent 行为指令，追加在人设提示词之后 |
| `memoryTokenBudget` | number | 4096 | 长期记忆注入的 system 消息的预留 token 额度 |

---

## handleMessage 完整流程

```
收到 IncomingMessage
        │
        ▼
  ┌─ Hook: message:before ──── 插件可修改/拦截消息
  │
  ├─ 检查 LLM 服务是否可用
  │     └─ 不可用 → 发送错误提示
  │
  ├─ buildMessages() ──── 组装消息列表
  │     ├─ [system] 系统提示词
  │     ├─ [历史消息] 从 memory 取 50 条
  │     └─ [user] 当前用户消息
  │
  ├─ 收集工具定义 → tools.getDefinitions()
  │
  ├─ Hook: llm-call:before ──── 可注入 system 消息、修改 tools
  │
  ├─ trimMessages() ──── 裁剪到 tokenBudget
  │
  ├─ consumeStream() ──── 流式调用 LLM
  │     └─ 逐 chunk 触发 message:stream 事件
  │
  ├─ Hook: llm-call:after ──── 可处理 LLM 返回
  │
  ├─ ┌── 工具调用循环 (最多 maxToolIterations 次) ──┐
  │   │ Hook: tool-call:before                       │
  │   │ emit tool:execute (phase: start)              │
  │   │ tools.execute()                               │
  │   │ Hook: tool-call:after                         │
  │   │ emit tool:execute (phase: end)                │
  │   │ 再次 LLM 调用 (经过 hooks + trimMessages)    │
  │   └──────────────────────────────────────────────┘
  │
  ├─ Hook: response:before ──── 可修改最终回复
  │
  ├─ 保存 user 消息到 memory
  │
  ├─ emit message:stream (done: true)
  │
  └─ 判断 replyContent
        ├─ 空字符串 → 静默，不发送不存储
        └─ 非空 → 保存 assistant 消息 + emit message:send
```

---

## 系统提示词构建

```typescript
buildSystemPrompt()
  ├─ 有 PersonaService → personaPrompt + "\n\n" + systemPrompt (行为准则)
  └─ 无 PersonaService → IDENTITY_PROMPT + systemPrompt
```

默认行为准则包括：诚实回答、主动使用工具、不确定则坦诚、利用上下文、简洁清晰。

---

## 流式消费 — consumeStream

调用 `llm.chatStream(request)` 并逐 chunk 处理：

| chunk 字段 | 处理 |
|---|---|
| `contentDelta` | 累积到 content，emit `message:stream` |
| `reasoningDelta` | 累积到 reasoningContent，emit `message:stream` |
| `done` | 提取最终 `toolCalls` |
| `usage` | 记录 token 用量 |

最终返回完整的 `ChatResponse`。

---

## Token 估算

```typescript
estimateMsgTokens(msg): number
  → 4（基准开销）
  + ceil(content.length / 3)
  + ceil(JSON.stringify(toolCalls).length / 3)
  + ceil(reasoningContent.length / 3)
```

粗略估算，每 3 个字符约等于 1 个 token。

---

## trimMessages — 上下文裁剪算法

**目标**: 将消息列表裁剪到 `tokenBudget = contextLength - maxTokens - 512` 以内。

### 保护规则

- 首条 `system`（主提示词）**永不删除**
- 末条消息（当前用户消息）**永不删除**
- Hook 注入的 `system` 消息有独立的 `memoryTokenBudget` 保护

### 裁剪策略（按优先级）

**第 0 轮 — 长期记忆缩减**
如果非首条的 system 消息总 token 超过 `memoryTokenBudget`，按比例缩减每条的 content：

```
ratio = memoryTokenBudget / systemTokens
targetLen = max(200, floor(content.length × ratio))
content = content.slice(0, targetLen) + '\n... [记忆内容已缩减]'
```

**第 1 轮 — 删除最旧历史**
从索引 1 开始，跳过 system 消息，删除最旧的用户/assistant/tool 消息。

关键：`assistant`（含 `toolCalls`）与后续的 `tool` 消息**必须成组删除**，否则 LLM 会因缺失 tool 结果而报错。

**第 2 轮 — 删除 system 注入**
极端情况下，从后往前删除 hook 注入的 system 消息。

---

## 空回复静默

当 `response:before` hook（如 Persona 的 outputFormat）将 `replyContent` 设置为空字符串时：
- 不保存 assistant 消息到记忆
- 不触发 `message:send` 事件
- 仅记录 debug 日志

这实现了角色扮演中的"沉默"行为。
