# plugin-prompt-budget — Prompt 预算自检（AI 内省）

**包名**: `@aalis/plugin-prompt-budget`  
**源码**: `packages/plugin-prompt-budget/src/index.ts`  
**子系统**: agent

## 设计动机

`plugin-agent` 已 emit `token:usage` 事件（含 12 桶 breakdown），WebUI 通过 `plugin-webui-server` 订阅渲染面板。但 **AI 自己在工具循环里跑时看不到 WebUI**，怀疑"是不是 prompt 太大了"的时候没有内省路径。

本插件提供一个**主动 query** 工具：让模型在 tool loop 中直接查到自己最近一次 LLM 调用的预算消耗，决定是否调用 `memory.compress` / 减少 tool 输出 / 调整策略。

## 插件声明

```ts
meta.name = '@aalis/plugin-prompt-budget'
meta.subsystem = 'agent'
```

无 `inject` 依赖（订阅事件不强依赖 emit 方；若无 agent 则永远返回 noData）。

## 行为

1. 在 `apply()` 中订阅 `'token:usage'`，维护 `Map<sessionId, snapshot + observedAt>` 缓存（每个 session 只保留最近一次）
2. 注册一个名为 `prompt_budget_info` 的工具供 AI 调用

## 工具：`prompt_budget_info`

**用途**：查询当前 session 最近一次 LLM 调用的 prompt token 消耗。

**参数**：

| 名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sessionId` | string | 否 | 默认用 `callCtx.sessionId`；传入可查其他会话 |

**返回**（JSON 字符串）：

正常：

```json
{
  "sessionId": "...",
  "ageMs": 1234,
  "observedAt": "2026-...",
  "tag": "OK | INFO | WARN | CRITICAL",
  "used": 12345,
  "contextWindow": 32000,
  "usageRatio": 0.3859,
  "maxTokens": 4096,
  "tokenBudget": 27904,
  "breakdown": {
    "system": 567, "persona": 234, "memorySummary": 0,
    "memoryVector": 0, "skills": 123, "platform": 12,
    "subtask": 0, "systemOther": 45, "history": 8901,
    "toolResults": 2300, "toolDefs": 89, "reservedForReply": 4096
  },
  "top3": [{ "name": "history", "tokens": 8901 }, ...],
  "advice": "预算健康，无需干预。"
}
```

无数据（首轮调用前 / 该 session 从未调过 LLM）：

```json
{
  "noData": true,
  "sessionId": "...",
  "advice": "本 session 尚未产生 token:usage 事件..."
}
```

## tag 阈值

| usageRatio | tag | advice |
|---|---|---|
| `>= 0.85` | CRITICAL | 上下文几乎用尽。建议：调用 memory.compress / 清理 toolResults / 缩减 system prompt。 |
| `>= 0.70` | WARN | 上下文压力较高。可考虑主动压缩历史或减少后续工具调用的输出体量。 |
| `>= 0.50` | INFO | （健康范围） |
| `< 0.50` | OK | 预算健康，无需干预。 |

阈值与 `plugin-agent` 内的节流 logger 一致，便于 WebUI 日志、AI 自检、人类观察对齐口径。

## 与其他模块的关系

```
plugin-agent                             plugin-webui-server
   │                                          ▲
   │ emit('token:usage', snapshot)            │
   │           ┌──────────────────────────────┘ 推 WebSocket
   ▼           │
 [event bus]  ─┼─→ plugin-prompt-budget  ──→ 工具 prompt_budget_info
               │                              （AI 自查）
               └─→ plugin-memory-summary  ──→ 阈值触发自动压缩
```

完全只读消费者，不修改 emit 数据。

## 实现复杂度

- 总代码 < 140 行
- 0 业务逻辑、0 计算，仅缓存最近一次事件
- 无运行时依赖（仅 `@aalis/core` + `@aalis/plugin-tools-api` 的 Context 扩展声明）

## 何时启用

- 长会话 / 工具密集场景下 AI 误判 token 余量频繁时
- 配合 `memory-summary` 自动压缩用：让 AI 在自动压缩触发前提前主动减负
- 调试 system prompt 膨胀：top3 字段能立刻看出哪个桶在涨

## 相关

- token:usage 事件结构与 12 桶含义：[plugin-agent](./plugin-agent.md)
- 自动压缩：[plugin-memory-summary](./plugin-memory-summary.md)
- WebUI 面板：[plugin-webui-server](./plugin-webui-server.md)
