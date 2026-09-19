import { memory } from '@aalis/api-memory';
import type {} from '@aalis/api-session-manager';
import { type ToolCallContext, tools } from '@aalis/api-tools';
import { webuiServer } from '@aalis/api-webui';
import { type BoundOf, config, definePlugin, events, optional } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';

const configSchema: ConfigSchema = {
  enabled: { type: 'boolean', label: '启用任务计划工具', default: true },
};

// ===== 内部存储 =====

export interface TodoItem {
  id: number;
  title: string;
  status: 'not-started' | 'in-progress' | 'completed';
}

const TODO_NAMESPACE = 'todo-list';
const MAX_TODO_ITEMS = 50;
const MAX_TODO_TITLE_LENGTH = 120;

// ===== 声明扩展事件 =====

declare module '@aalis/core' {
  interface AalisEvents {
    'todo:updated': [sessionId: string, items: TodoItem[]];
  }
}

// ===== 插件入口 =====

const uses = { tools, events, config, memory: optional(memory), webui: optional(webuiServer) };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-todo-list',
  displayName: '任务计划',
  subsystem: 'scheduler',
  configSchema,
  uses,
  apply(caps) {
    if (caps.config.enabled === false) return;
    registerTodoList(caps);
  },
});

function registerTodoList({ tools, events, memory, webui }: Caps): void {
  /** sessionId → TodoItem[]：随这次激活存亡，插件重载或换 memory 后端后不会命中陈旧条目 */
  const store = new Map<string, TodoItem[]>();

  /**
   * 持久化依赖 memory 服务，而本插件不 require 它（没有 memory 也能当纯回合内清单用）：
   * 无 memory 时静默 no-op，todo 只存活于这次激活的缓存里。
   */
  async function persistTodos(sessionId: string, items: TodoItem[]): Promise<void> {
    await memory.current?.saveMetadata(TODO_NAMESPACE, sessionId, { items });
  }

  /** 从 memory 加载 todo（优先缓存） */
  async function loadTodos(sessionId: string): Promise<TodoItem[]> {
    const cached = store.get(sessionId);
    if (cached) return cached;
    const data = await memory.current?.getMetadata(TODO_NAMESPACE, sessionId);
    if (data?.items && Array.isArray(data.items)) {
      const items = data.items as TodoItem[];
      store.set(sessionId, items);
      return items;
    }
    return [];
  }

  // ===== 页面动作 =====

  webui.registerAction('getTodos', async args => {
    const sessionId = args.sessionId as string;
    if (!sessionId) return [];
    return await loadTodos(sessionId);
  });

  webui.registerAction('clearTodos', async args => {
    const sessionId = args.sessionId as string;
    if (!sessionId) throw new Error('缺少 sessionId');
    store.delete(sessionId);
    await memory.current?.deleteMetadata(TODO_NAMESPACE, sessionId);
    await events.emit('todo:updated', sessionId, []);
    return { success: true };
  });

  // 注册工具分组
  tools.registerGroup({
    name: 'todo',
    label: '任务计划',
    description: '创建和管理任务计划列表，拆分复杂任务并追踪进度',
  });

  // ---- manage_todo_list ----
  tools.register({
    groups: ['todo'],
    definition: {
      type: 'function',
      function: {
        name: 'manage_todo_list',
        description: [
          '管理当前会话的任务计划列表，用于规划和追踪多步骤任务的执行进度。',
          '传入完整的 todoList 数组以创建或更新计划。每次调用需提供所有 todo 项（包括已有项和新增项）。',
          '',
          '工作流程：',
          '1. 收到复杂任务时，规划 todo 列表（所有项 status=not-started）',
          '2. 开始某项前，将其标记为 in-progress（同一时间最多一项 in-progress）',
          '3. 完成某项后，立即将其标记为 completed',
          '4. 继续下一项，重复步骤 2-3',
          '',
          '你可以随时调整计划：重新排序、修改标题、插入新步骤、删除多余步骤均可。',
          '发现更优执行顺序或需要增补步骤时，直接传入更新后的完整数组即可。',
          '',
          '【子任务协作时必须使用 todo】：',
          '当需要创建子任务时，todo 列表应包含：准备工作（如创建共享文档）→ 创建子任务 → 等待子任务完成 → 整合结果/保存文档。',
          '这样能确保不会遗忘等待子任务或丢失结果。',
          '',
          'Todo 状态：',
          '- not-started: 尚未开始',
          '- in-progress: 正在执行（限一项）',
          '- completed: 已完成',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            todoList: {
              type: 'array',
              description: '完整的任务列表数组，每次调用必须包含所有项',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number', description: '唯一 ID，从 1 开始递增' },
                  title: { type: 'string', description: '简洁的任务描述（3-10 字）' },
                  status: {
                    type: 'string',
                    enum: ['not-started', 'in-progress', 'completed'],
                    description: '任务状态',
                  },
                },
                required: ['id', 'title', 'status'],
              },
            },
          },
          required: ['todoList'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args: Record<string, unknown>, callCtx: ToolCallContext) => {
      const rawList = args.todoList;
      if (!Array.isArray(rawList)) {
        return JSON.stringify({ error: 'todoList 必须是数组' });
      }
      if (rawList.length > MAX_TODO_ITEMS) {
        return JSON.stringify({ error: `todoList 最多允许 ${MAX_TODO_ITEMS} 项` });
      }
      const longTitleIndex = rawList.findIndex((item: unknown) => {
        const obj = item as Record<string, unknown>;
        return String(obj.title ?? '').length > MAX_TODO_TITLE_LENGTH;
      });
      if (longTitleIndex >= 0) {
        return JSON.stringify({
          error: `第 ${longTitleIndex + 1} 项 todo 标题最多允许 ${MAX_TODO_TITLE_LENGTH} 个字符`,
        });
      }

      const items: TodoItem[] = rawList.map((item: unknown) => {
        const obj = item as Record<string, unknown>;
        const title = String(obj.title ?? '');
        return {
          id: Number(obj.id),
          title,
          status: ['not-started', 'in-progress', 'completed'].includes(obj.status as string)
            ? (obj.status as TodoItem['status'])
            : 'not-started',
        };
      });

      store.set(callCtx.sessionId, items);
      await persistTodos(callCtx.sessionId, items);
      await events.emit('todo:updated', callCtx.sessionId, items);

      const total = items.length;
      const completed = items.filter(i => i.status === 'completed').length;
      const inProgress = items.filter(i => i.status === 'in-progress').length;

      return JSON.stringify({
        success: true,
        summary: `${completed}/${total} 已完成${inProgress > 0 ? `，${inProgress} 项进行中` : ''}`,
      });
    },
  });

  // 会话删除时清理
  events.on('session:deleted', (sessionId: string) => {
    store.delete(sessionId);
    memory.current?.deleteMetadata(TODO_NAMESPACE, sessionId).catch(() => {});
  });
}
