import type { ConfigSchema, Context } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type {} from '@aalis/plugin-session-manager-api';
import type { ToolCallContext } from '@aalis/plugin-tools-api';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-todo-list';
export const displayName = '任务计划';
export const subsystem = 'scheduler';
export const inject = {};

export const configSchema: ConfigSchema = {
  enabled: { type: 'boolean', label: '启用任务计划工具', default: true },
};

// ===== 内部存储 =====

export interface TodoItem {
  id: number;
  title: string;
  status: 'not-started' | 'in-progress' | 'completed';
}

/** sessionId → TodoItem[] */
const store = new Map<string, TodoItem[]>();

const TODO_NAMESPACE = 'todo-list';
const MAX_TODO_ITEMS = 50;
const MAX_TODO_TITLE_LENGTH = 120;

/** 将 todo 持久化到 MemoryService */
async function persistTodos(ctx: Context, sessionId: string, items: TodoItem[]): Promise<void> {
  const memory = ctx.getService<MemoryService>('memory');
  if (memory?.saveMetadata) {
    await memory.saveMetadata(TODO_NAMESPACE, sessionId, { items });
  }
}

/** 从 MemoryService 加载 todo（优先内存缓存） */
async function loadTodos(ctx: Context, sessionId: string): Promise<TodoItem[]> {
  const cached = store.get(sessionId);
  if (cached) return cached;
  const memory = ctx.getService<MemoryService>('memory');
  if (memory?.getMetadata) {
    const data = await memory.getMetadata(TODO_NAMESPACE, sessionId);
    if (data?.items && Array.isArray(data.items)) {
      const items = data.items as TodoItem[];
      store.set(sessionId, items);
      return items;
    }
  }
  return [];
}

// ===== 声明扩展事件 =====

declare module '@aalis/core' {
  interface AalisEvents {
    'todo:updated': [sessionId: string, items: TodoItem[]];
  }
}

// ===== WebuiHandlers =====

export const webuiHandlers: Record<string, (ctx: Context, args: Record<string, unknown>) => Promise<unknown>> = {
  async getTodos(ctx, args) {
    const sessionId = args.sessionId as string;
    if (!sessionId) return [];
    return await loadTodos(ctx, sessionId);
  },

  async clearTodos(ctx, args) {
    const sessionId = args.sessionId as string;
    if (!sessionId) throw new Error('缺少 sessionId');
    store.delete(sessionId);
    const memory = ctx.getService<MemoryService>('memory');
    if (memory?.deleteMetadata) {
      await memory.deleteMetadata(TODO_NAMESPACE, sessionId);
    }
    await ctx.emit('todo:updated', sessionId, []);
    return { success: true };
  },
};

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  if (config.enabled === false) return;

  // 注册工具分组
  ctx.registerToolGroup({
    name: 'todo',
    label: '任务计划',
    description: '创建和管理任务计划列表，拆分复杂任务并追踪进度',
  });

  // ---- manage_todo_list ----
  ctx.registerTool({
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
      await persistTodos(ctx, callCtx.sessionId, items);
      await ctx.emit('todo:updated', callCtx.sessionId, items);

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
  ctx.on('session:deleted', (sessionId: string) => {
    store.delete(sessionId);
    const memory = ctx.getService<MemoryService>('memory');
    if (memory?.deleteMetadata) {
      memory.deleteMetadata(TODO_NAMESPACE, sessionId).catch(() => {});
    }
  });
}
