# plugin-todo-list — 待办事项管理

**包名**: `@aalis/plugin-todo-list`  
**源码**: `packages/plugin-todo-list/src/index.ts`

## 概述

会话级待办事项管理工具，AI 在执行复杂任务时可创建和跟踪任务列表。特别在子任务系统中用于协调多个并行子任务的进度。

## 插件声明

```typescript
meta.name = '@aalis/plugin-todo-list'
meta.inject = {}
```

## 注册工具

| 工具 | 说明 |
|---|---|
| `manage_todo_list` | 管理待办事项（创建/更新/标记完成） |

## 待办项状态

| 状态 | 说明 |
|---|---|
| `not-started` | 尚未开始 |
| `in-progress` | 进行中（同一时间最多一个） |
| `completed` | 已完成 |

## 事件

| 事件 | 载荷 | 说明 |
|---|---|---|
| `todo:updated` | `{ sessionId, items }` | 待办列表变化时触发 |

WebUI 前端通过 WebSocket 接收 `todo_updated` 推送，实时显示任务进度面板。
