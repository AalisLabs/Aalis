import { afterEach, describe, expect, it } from 'vitest';
import { type TodoItem, todoList } from '../../packages/api-todo-list/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import todoListPlugin from '../../packages/plugin-todo-list/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 待办服务（api-todo-list）：会话客户端经它读当前计划、清空计划。读到的就是工具写下的那份；
// 清空后发一次空清单的 todo:updated。工具关掉（enabled: false）时服务照常提供：读得到之前留下的计划，也能清空。
// ════════════════════════════════════════════════════════════

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<string>;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(enabled: boolean) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory, {});
  const host = app.bind({ provide, events, todoList });
  const handlers = new Map<string, ToolHandler>();
  host.provide.use(tools, {
    register(tool: { definition: { function: { name: string } }; handler: ToolHandler }) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => void handlers.delete(tool.definition.function.name);
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugin(todoListPlugin, { enabled });
  await app.plugins.idle();
  const updates: Array<[string, TodoItem[]]> = [];
  host.events.use.on('todo:updated', (sessionId, items) => void updates.push([sessionId, items]));
  return { app, service: host.todoList.use, handlers, updates };
}

describe('待办服务', () => {
  it('get 读到工具写下的计划；clear 清空并发空清单的 todo:updated', async () => {
    const { service, handlers, updates } = await boot(true);
    const items: TodoItem[] = [{ id: 1, title: '写用例', status: 'in-progress' }];
    await handlers.get('manage_todo_list')?.({ todoList: items }, { sessionId: 's-1' });
    expect(await service.get('s-1')).toEqual(items);
    expect(await service.get('s-2')).toEqual([]);

    await service.clear('s-1');
    expect(await service.get('s-1')).toEqual([]);
    expect(updates.at(-1)).toEqual(['s-1', []]);
  });

  it('工具关掉时服务照常提供，工具不登记', async () => {
    const { service, handlers } = await boot(false);
    expect(handlers.size).toBe(0);
    expect(await service.get('s-1')).toEqual([]);
    await service.clear('s-1');
  });
});
