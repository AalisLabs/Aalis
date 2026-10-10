# @aalis/api-todo-list

待办契约：`todo-list` 服务描述符、待办项类型 `TodoItem` 与 `todo:updated` 事件。不含服务实现，默认实现是 `@aalis/plugin-todo-list`。

## 角色

- `todoList`：服务描述符。会话的客户端经它读某会话当前的待办、清空待办。
- `TodoItem`、`TodoListService`：待办项与服务接口的类型。
- `todo:updated`：待办整份变化时发出，载荷是会话 id 与变化后的全部待办。

## 安装

```bash
pnpm add @aalis/api-todo-list
```

## 使用

```ts
import { todoList } from '@aalis/api-todo-list';

// uses: { todoList: optional(todoList) }
const items = caps.todoList.present ? await caps.todoList.use.get(sessionId) : [];
```

详见 [docs/api/api-todo-list.md](../../docs/api/api-todo-list.md)。
