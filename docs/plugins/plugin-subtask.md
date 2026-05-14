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
| `wait_subtasks` | 阻塞直到指定子任务全部完成或超时（事件驱动，非轮询） |

## 工作方式

1. `create_subtask` 在 `session-manager` 中创建子会话，复制父会话的 resolved config，发送 `inbound:message` 事件触发子任务 agent 处理
2. 子会话的系统提示由 `agent:llm:before` 中间件注入子任务上下文（任务指令、共享资源规则）
3. 父会话的系统提示同样被注入"活跃子任务提醒"，每轮重新生成最新状态
4. 子任务 agent 正常回复后，`agent:turn:after` 中间件自动调用 `sm.completeSession`，并在子会话历史中合成 `report_to_parent` tool call 记录
5. `wait_subtasks` 监听 `session:completed` / `session:updated` 事件等待全部子任务终结

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | true | 启用子任务工具 |
| `pollIntervalMs` | number | 3000 | （兼容字段，当前实现采用事件驱动）|
| `maxWaitMs` | number | 300000 | `wait_subtasks` 单次最大等待时长 |

## 相关插件

会话历史读取已拆分到独立插件：[plugin-tool-session](./plugin-tool-session.md)。
