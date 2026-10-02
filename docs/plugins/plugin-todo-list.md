# plugin-todo-list — 任务计划

**包名**: `@aalis/plugin-todo-list`  
**源码**: `packages/plugin-todo-list/src/index.ts`  
**契约**: [api-todo-list](../api/api-todo-list.md)（服务描述符 `todoList`、`TodoItem`、`todo:updated` 事件）

## 概述

会话级待办事项管理工具，AI 在执行复杂任务时可创建和跟踪任务列表。配合子任务使用时，工具描述要求父会话把「创建子任务」「等待子任务完成」「整合结果」列为计划步骤，避免遗漏等待或丢失结果。

待办经 memory 服务的 metadata 接口持久化（namespace `todo-list`，key 为会话 ID）。memory 未装时不报错，但待办只存活于本次装载的内存缓存：插件卸载或重装即清空。

待办属于会话级短期上下文，以 `context` 类型参与 `memory:clear`：会话级清理（`/clear` 与删除会话）删除本会话的待办，全局清理（`/clear all`）删除全部会话的待办。

插件提供 `todo-list` 服务：`get(sessionId)` 读当前待办，`clear(sessionId)` 清空并发空清单的 `todo:updated`。会话服务用它给订阅的快照带上当前计划、执行 `plan/clear`。服务不随 `enabled` 开关：工具关掉之后，之前留下的待办照样读得到、清得掉。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-todo-list',
  displayName: '任务计划',
  subsystem: 'scheduler',
  provides: [todoList],
  uses: {
    tools: optional(tools),
    events,
    config,
    logger,
    provide,
    memory: optional(memory),
    webui: optional(webuiServer),
    hooks: optional(hooks),
  },
  apply(caps) { /* 见源码 */ },
});
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
| `todo:updated` | `(sessionId: string, items: TodoItem[])` | `manage_todo_list` 写入、服务的 `clear`（页面动作 `clearTodos` 与会话协议的 `plan/clear` 都经它）或 `memory:clear` 清理时触发（后两者 `items` 为 `[]`，全局清理时每个被清的会话各触发一次） |

事件声明在 api-todo-list。WebUI 前端通过 WebSocket 接收 `todo_updated` 推送，实时显示任务进度面板；会话服务把它推成会话协议的 `plan` 条目。

## 配置校验

`enabled` 显式写成非布尔值时会报配置错误，避免无效值把已关闭的工具意外启用。
