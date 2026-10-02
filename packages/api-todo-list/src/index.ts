/**
 * @aalis/api-todo-list — 待办契约
 *
 * 会话级的待办清单：模型用工具整份写入，会话的客户端读来显示、需要时清空。本包有服务描述符 `todoList`、
 * 待办项类型与 `todo:updated` 事件，实现见 @aalis/plugin-todo-list。
 */

import { defineService } from '@aalis/core';

export interface TodoItem {
  id: number;
  title: string;
  status: 'not-started' | 'in-progress' | 'completed';
}

export interface TodoListService {
  /** 某会话当前的待办，没有时是空数组 */
  get(sessionId: string): Promise<TodoItem[]>;
  /** 清空某会话的待办，并发一次空清单的 `todo:updated` */
  clear(sessionId: string): Promise<void>;
}

declare module '@aalis/core' {
  interface AalisEvents {
    /** 某会话的待办整份变了（写入、清空），items 是变化后的全部待办 */
    'todo:updated': [sessionId: string, items: TodoItem[]];
  }
}

export const todoList = defineService<TodoListService>('todo-list');
