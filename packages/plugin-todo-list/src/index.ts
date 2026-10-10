import { hooks } from '@aalis/api-hooks';
import { clearMetadataNamespaces, memory } from '@aalis/api-memory';
import { type TodoItem, type TodoListService, todoList } from '@aalis/api-todo-list';
import { type ToolCallContext, tools } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, events, logger, optional, provide } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';

const configSchema = defineConfig({
  enabled: { type: 'boolean', label: '启用任务计划工具', default: true, onInvalid: 'error' },
});

// ===== 内部存储 =====

const TODO_NAMESPACE = 'todo-list';
const MAX_TODO_ITEMS = 50;
const MAX_TODO_TITLE_LENGTH = 120;

// ===== 插件入口 =====

const uses = {
  tools: optional(tools),
  events,
  config,
  logger,
  provide,
  memory: optional(memory),
  hooks: optional(hooks),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-todo-list',
  displayName: '任务计划',
  subsystem: 'scheduler',
  configSchema,
  provides: [todoList],
  uses,
  apply(caps) {
    const cfg = parseConfig(configSchema, caps.config.use, caps.logger.use);
    // 读与清空不随工具开关：工具关掉之后，之前留下的计划照样看得到、清得掉
    const service = createTodoList(caps);
    caps.provide.use(todoList, service.api, { label: '任务计划' });
    if (!cfg.enabled) return;
    registerTodoTool(caps, service);
  },
});

type TodoStore = ReturnType<typeof createTodoList>;

function createTodoList({ events, memory }: Caps) {
  /**
   * sessionId → TodoItem[]：随这次激活存亡，插件重载后不会命中陈旧条目。
   * 只在没有 memory 时充当存储，有 memory 时不作读缓存：memory 是 optional，胜者换人时
   * 本插件不重启，读穿缓存会一直停在旧后端的清单上。
   */
  const store = new Map<string, TodoItem[]>();

  const api: TodoListService = {
    /** 有 memory 时每次读当前胜者，没有时读 store */
    async get(sessionId) {
      if (!memory.present) return store.get(sessionId) ?? [];
      const mem = memory.use;
      const data = await mem.getMetadata(TODO_NAMESPACE, sessionId);
      return data?.items && Array.isArray(data.items) ? (data.items as TodoItem[]) : [];
    },
    async clear(sessionId) {
      store.delete(sessionId);
      if (memory.present) await memory.use.deleteMetadata(TODO_NAMESPACE, sessionId);
      await events.use.emit('todo:updated', sessionId, []);
    },
  };

  return {
    store,
    api,
    /**
     * 持久化依赖 memory 服务，而本插件不 require 它（没有 memory 也能当纯回合内清单用）：
     * 无 memory 时静默 no-op，todo 只存活于这次激活的 store 里。
     */
    async save(sessionId: string, items: TodoItem[]): Promise<void> {
      store.set(sessionId, items);
      if (memory.present) await memory.use.saveMetadata(TODO_NAMESPACE, sessionId, { items });
      await events.use.emit('todo:updated', sessionId, items);
    },
  };
}

function registerTodoTool({ tools, events, logger, memory, hooks }: Caps, todos: TodoStore): void {
  const { store } = todos;

  // 注册工具分组
  tools.use.registerGroup({
    name: 'todo',
    label: '任务计划',
    description: '创建和管理任务计划列表，拆分复杂任务并追踪进度',
  });

  // ---- manage_todo_list ----
  tools.use.register({
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

      await todos.save(callCtx.sessionId, items);

      const total = items.length;
      const completed = items.filter(i => i.status === 'completed').length;
      const inProgress = items.filter(i => i.status === 'in-progress').length;

      return JSON.stringify({
        success: true,
        summary: `${completed}/${total} 已完成${inProgress > 0 ? `，${inProgress} 项进行中` : ''}`,
      });
    },
  });

  // 参与 memory:clear：待办属会话级短期上下文，随 context 一起清。删除会话也经这条钩子（会话级、不带类型）
  hooks.use.middleware('memory:clear', async (data, next) => {
    if (data.types && !data.types.includes('context')) {
      await next();
      return;
    }
    try {
      if (data.scope === 'all') {
        const mem = memory.present ? memory.use : undefined;
        // 读不出的条目一并删除，计入会话数
        const [keys] = mem ? await clearMetadataNamespaces(mem, [TODO_NAMESPACE], logger.use) : [[]];
        const cleared = [...new Set([...keys, ...store.keys()])];
        store.clear();
        data.results.push({
          source: 'todo-list',
          success: true,
          message: `所有会话待办已清空（${cleared.length} 个会话）`,
        });
        for (const sessionId of cleared) await events.use.emit('todo:updated', sessionId, []);
      } else if (data.sessionId) {
        await todos.api.clear(data.sessionId);
        data.results.push({ source: 'todo-list', success: true, message: '当前会话待办已清空' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      data.results.push({ source: 'todo-list', success: false, message: `待办清空失败: ${msg}` });
    }
    await next();
  });
}
