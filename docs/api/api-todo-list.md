# api-todo-list — 待办契约

**包名**: `@aalis/api-todo-list`  
**源码**: `packages/api-todo-list/src/index.ts`  
**实现**: `@aalis/plugin-todo-list`

## 概述

会话级的待办清单：模型用 `manage_todo_list` 工具整份写入，会话的客户端读来显示（会话协议的 `plan` 条目），需要时清空。本包定义服务描述符 `todoList`（服务名 `todo-list`）、服务接口 `TodoListService`、待办项类型 `TodoItem` 与 `todo:updated` 事件，不含实现。

## 服务接口

```ts
interface TodoListService {
  get(sessionId: string): Promise<TodoItem[]>;
  clear(sessionId: string): Promise<void>;
}

interface TodoItem {
  id: number;
  title: string;
  status: 'not-started' | 'in-progress' | 'completed';
}
```

- `get`：某会话当前的待办，没有时是空数组。
- `clear`：清空某会话的待办，并发一次空清单的 `todo:updated`。

## 事件（AalisEvents）

```ts
'todo:updated': [sessionId: string, items: TodoItem[]]
```

某会话的待办整份变了（写入、清空、随 `memory:clear` 清理），`items` 是变化后的全部待办。

## 使用

```ts
import { todoList } from '@aalis/api-todo-list';
import { definePlugin, events, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-plan-view',
  uses: { todoList: optional(todoList), events },
  apply({ todoList, events }) {
    events.on('todo:updated', (sessionId, items) => {
      // 待办整份替换
    });
    // 需要当前计划时：(await todoList.current?.get(sessionId)) ?? []
  },
});
```

## 实现者列表

- [@aalis/plugin-todo-list](../plugins/plugin-todo-list.md)
