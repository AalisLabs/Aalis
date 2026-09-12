# plugin-todo-list — 任务计划

**包名**: `@aalis/plugin-todo-list`  
**源码**: `packages/plugin-todo-list/src/index.ts`

## 概述

会话级待办事项管理工具，AI 在执行复杂任务时可创建和跟踪任务列表。配合子任务使用时，工具描述要求父会话把「创建子任务」「等待子任务完成」「整合结果」列为计划步骤，避免遗漏等待或丢失结果。

## 插件声明

```typescript
meta.name = '@aalis/plugin-todo-list'
meta.displayName = '任务计划'
meta.subsystem = 'scheduler'
meta.inject = {}
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用任务计划工具 |

## 注册工具

| 工具 | 说明 |
|---|---|
| `manage_todo_list` | 以完整数组整体替换当前会话的待办列表（最多 50 项，标题不超过 120 字符），属于工具分组 `todo` |

## 待办项状态

| 状态 | 说明 |
|---|---|
| `not-started` | 尚未开始 |
| `in-progress` | 进行中（工具描述要求模型同一时间只标一项，插件本身不强制） |
| `completed` | 已完成 |

## 事件

| 事件 | 载荷 | 说明 |
|---|---|---|
| `todo:updated` | `(sessionId: string, items: TodoItem[])` | `manage_todo_list` 写入或 `clearTodos` 清空时触发（清空时 `items` 为 `[]`） |

WebUI 前端通过 WebSocket 接收 `todo_updated` 推送，实时显示任务进度面板。
