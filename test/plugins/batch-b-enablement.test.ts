import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import userRelation from '../../packages/plugin-user-relation/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(memoryInMemory.name)?.state).toBe('active');
  const registry = new ToolRegistry(app.logger);
  app.bind({ provide }).provide(tools, registry);
  return { app, registry };
}

describe('Batch B 显式坏启用位', () => {
  it.each([
    { plugin: memoryHistory, name: 'recent_messages' },
    { plugin: userRelation, name: 'user_relation_search_persons' },
  ] as const)('$plugin.name 合法配置确实向同一个 registry 登记工具', async ({ plugin, name }) => {
    const { app, registry } = await boot();
    await app.plugin(plugin);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('active');
    expect(registry.getAll().map(tool => tool.name)).toContain(name);
  });

  it.each([
    { plugin: memoryHistory, config: { toolEnabled: 'false' } },
    { plugin: userRelation, config: { toolsEnabled: 'false' } },
    { plugin: userRelation, config: { extractionEnabled: 'false' } },
  ])('$plugin.name 拒绝坏值且不注册工具', async ({ plugin, config }) => {
    const { app, registry } = await boot();
    await app.plugin(plugin, config);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('error');
    expect(registry.getAll()).toEqual([]);
  });
});
