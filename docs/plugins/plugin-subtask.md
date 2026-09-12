# plugin-subtask — 子任务

**包名**: `@aalis/plugin-subtask`  
**源码**: `packages/plugin-subtask/src/index.ts`

## 概述

为 AI Agent 提供子任务创建与并行协调能力。注册 `subtask` 工具组，并通过 `agent:llm:before` / `agent:turn:after` 中间件实现父/子会话的上下文注入与子任务自动完成。

## 插件声明

```typescript
meta.name = '@aalis/plugin-subtask'
meta.subsystem = 'session'
meta.inject = { optional: ['session-manager', 'message-archive'] }
```

## 注册工具组

`subtask`

| 工具 | 说明 |
|---|---|
| `create_subtask` | 创建子会话并异步派发任务（不阻塞当前会话） |
| `check_subtask` | 查询一个或多个子任务的当前状态和结果 |
| `send_to_subtask` | 向子任务追加消息（追问/补充指令；可重新激活已完成的子任务） |
| `delete_subtask` | 递归删除子任务会话；仅允许删除当前会话的直接子任务 |
| `wait_subtasks` | 阻塞直到指定子任务全部结束（completed、error 或会话已不存在）或超时；超时取 `timeout_seconds` 与 `maxWaitMs` 中的较小者（事件驱动，非轮询） |

## 工作方式

1. `create_subtask` 在 `session-manager` 中创建子会话：以父会话的 resolved config 为底，`llm` 按「工具参数 provider+model > 插件 `defaultProvider`+`defaultModel` > 继承父会话」的优先级覆盖（provider 与 model 须同时提供才生效），然后发送 `inbound:message` 事件触发子任务 agent 处理。子会话中不能再调用 `create_subtask`
2. 子会话的系统提示由 `agent:llm:before` 中间件注入子任务上下文（任务指令、共享资源规则）
3. 父会话侧不改动首条系统提示（避免破坏 provider 前缀缓存），而是在消息列表尾部插入一条独立的 system 消息"活跃子任务提醒"，列出进行中、出错和已完成的子任务；最后一条是 user 消息时插在它之前，否则追加到末尾。每轮先移除上一轮的提醒，再按最新状态重新生成
4. 子任务 agent 本轮以 `replied` 结束、回复非空且子会话尚未完成或出错时，`agent:turn:after` 中间件以该回复为结果调用 `sm.completeSession`；若 `message-archive` 服务可用，调用前还会在子会话历史中合成一条 `report_to_parent` tool call 记录及其结果消息
5. `wait_subtasks` 监听 `session:completed` / `session:updated` 事件等待全部子任务终结

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用子任务工具 |
| `pollIntervalMs` | number | `3000` | 等待轮询间隔 (ms) |
| `maxWaitMs` | number | `300000` | 单次等待最大时长 (ms) |
| `defaultProvider` | string | `''` | 子任务默认 LLM provider：不填则继承父会话。建议填轻量本地模型（如 ollama）让子任务跑在更便宜的模型上，节省 token |
| `defaultModel` | string | `''` | 子任务默认模型名：与 defaultProvider 配套。例如 qwen3:8b、deepseek-chat。两个都不填则继承父会话模型。 |

`pollIntervalMs` 当前未被源码读取（`wait_subtasks` 为事件驱动），配置后不生效。

## 相关插件

会话历史读取已拆分到独立插件：[plugin-tool-session](./plugin-tool-session.md)。
