import { describe, expect, it } from 'vitest';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import todoList from '../../packages/plugin-todo-list/src/index.js';

// ════════════════════════════════════════════════════════════
// todo 的 sessionId→items 缓存随插件的这次激活存亡：页面动作与工具 handler 都是 apply 里的闭包，
// 共用同一份缓存。插件重载后不得命中上一次激活的陈旧条目；有 memory 时回源，没有就是空。
// ════════════════════════════════════════════════════════════

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<string>;

async function boot() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.plugins.register(memoryInMemory, {});
  const host = app.bind({ provide, services });
  const handlers = new Map<string, ToolHandler>();
  const actions = new Map<string, WebuiActionHandler>();
  host.provide(tools, {
    register(tool: { definition: { function: { name: string } }; handler: ToolHandler }) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => void handlers.delete(tool.definition.function.name);
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction(method: string, handler: WebuiActionHandler) {
      actions.set(method, handler);
      return () => void actions.delete(method);
    },
  } as never);
  await app.plugins.register(todoList, { enabled: true });
  await app.plugins.idle();
  const getTodos = (sessionId: string) => actions.get('getTodos')!({ sessionId }) as Promise<unknown[]>;
  return { app, host, manage: () => handlers.get('manage_todo_list')!, getTodos };
}

describe('plugin-todo-list: 缓存随激活存亡', () => {
  it('两个 App 各装一份：互不相干', async () => {
    const first = await boot();
    await first.manage()({ todoList: [{ id: 1, title: '写测试', status: 'in-progress' }] }, { sessionId: 's-1' });
    expect(await first.getTodos('s-1')).toHaveLength(1);
    const second = await boot();
    expect(await second.getTodos('s-1')).toEqual([]);
    expect(await first.getTodos('s-1'), '另一个 App 的装载不影响这一个').toHaveLength(1);
    await first.app.stop();
    await second.app.stop();
  });

  it('卸载再装：不命中上一次激活的缓存；memory 里的条目被清掉后读到的是空', async () => {
    const { app, host, manage, getTodos } = await boot();
    await manage()({ todoList: [{ id: 1, title: '写测试', status: 'in-progress' }] }, { sessionId: 's-3' });
    expect(await getTodos('s-3')).toHaveLength(1);

    await app.plugins.unload(todoList.name);
    const store = host.services.get(memory) as MemoryService;
    await store.deleteMetadata('todo-list', 's-3');

    await app.plugins.register(todoList, { enabled: true });
    await app.plugins.idle();
    expect(await getTodos('s-3')).toEqual([]);
    await app.stop();
  });

  it('状态原样保存并经页面动作读回', async () => {
    const { app, manage, getTodos } = await boot();
    await manage()({ todoList: [{ id: 1, title: '写测试', status: 'completed' }] }, { sessionId: 's-2' });
    const items = (await getTodos('s-2')) as Array<{ status: string }>;
    expect(items.map(i => i.status)).toEqual(['completed']);
    await app.stop();
  });
});
