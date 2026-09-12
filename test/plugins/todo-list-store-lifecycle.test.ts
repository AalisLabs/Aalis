import { describe, expect, it } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as todoList from '../../packages/plugin-todo-list/src/index.js';

// ════════════════════════════════════════════════════════════
// todo 的 sessionId→items 缓存是模块级 Map（actions 与工具 handler 共用）。
// 它此前零 dispose 清理：插件 bounce 或换 memory 后端后，读到的是上一世的缓存
// 而不回读新 provider，且条目按会话数单调增长。装载时清一次 + dispose 清空。
// ════════════════════════════════════════════════════════════

async function setup() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(memoryInMemoryModule);
  const handlers = new Map<string, (args: Record<string, unknown>, ctx: unknown) => Promise<string>>();
  app.ctx.provide('tools', {
    register: (tool: { definition: { function: { name: string } }; handler: never }) => {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.ctx.useModule(todoList, { enabled: true });
  await app.plugins.idle();
  return { app, manage: handlers.get('manage_todo_list')! };
}

describe('plugin-todo-list: 模块级缓存的生命周期', () => {
  it('插件卸载后缓存清空：换新 memory 后端时读新 provider，不返回上一世的条目', async () => {
    const first = await setup();
    await first.manage({ todoList: [{ id: 1, title: '写测试', status: 'in-progress' }] }, { sessionId: 's-1' });
    expect(await todoList.actions?.getTodos(first.app.ctx, { sessionId: 's-1' })).toHaveLength(1);
    await first.app.stop();

    // 新一世：新的 memory 后端（空库），同一 sessionId 不该命中旧缓存
    const second = await setup();
    expect(await todoList.actions?.getTodos(second.app.ctx, { sessionId: 's-1' })).toEqual([]);
    await second.app.stop();
  });

  it('不重启 App 的卸载+重装：缓存清空，回读后端而非上一装的残留', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(memoryInMemoryModule);
    const handlers = new Map<string, (args: Record<string, unknown>, ctx: unknown) => Promise<string>>();
    app.ctx.provide('tools', {
      register: (tool: { definition: { function: { name: string } }; handler: never }) => {
        handlers.set(tool.definition.function.name, tool.handler);
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);

    await app.plugins.register(todoList as never, { enabled: true });
    await app.plugins.idle();
    await handlers.get('manage_todo_list')!({ todoList: [{ id: 1, title: '写测试', status: 'in-progress' }] }, {
      sessionId: 's-3',
    } as never);
    expect(await todoList.actions?.getTodos(app.ctx, { sessionId: 's-3' })).toHaveLength(1);

    // 卸载（App 不重启，memory 后端还是同一个），再抹掉后端里的那条：
    // 此后还能读出条目就只可能来自模块级缓存的残留。
    await app.plugins.unload(todoList.name);
    const memory = app.ctx.getService<MemoryService>('memory');
    await memory!.deleteMetadata('todo-list', 's-3');
    expect(await todoList.actions?.getTodos(app.ctx, { sessionId: 's-3' }), '卸载即应清空缓存').toEqual([]);

    // 重装：仍读后端（空），不复活上一装的条目
    await app.plugins.register(todoList as never, { enabled: true });
    await app.plugins.idle();
    expect(await todoList.actions?.getTodos(app.ctx, { sessionId: 's-3' })).toEqual([]);
    await app.stop();
  });

  it('同一世内缓存仍生效（清理只发生在装载/卸载）', async () => {
    const { app, manage } = await setup();
    await manage({ todoList: [{ id: 1, title: '写测试', status: 'completed' }] }, { sessionId: 's-2' });
    const items = (await todoList.actions?.getTodos(app.ctx, { sessionId: 's-2' })) as Array<{ status: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('completed');
    await app.stop();
  });
});
