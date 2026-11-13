import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import toolSystem from '../../packages/plugin-tool-system/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { makeToolRegistry } from '../fixtures/tool-registry.js';

// ════════════════════════════════════════════════════════════
// system_time 不看人设：人设往提示词里注入了当前时间，系统工具照样登记 system_time。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('system_time', () => {
  it('人设开了时间注入时照样登记', async () => {
    const app = new App({ logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const registry = makeToolRegistry(app.logger);
    app.bind({ provide }).provide.use(tools, registry);
    await app.plugin(personaPlugin, { timeInjection: true });
    await app.plugins.idle();
    await app.plugin(toolSystem);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(personaPlugin.name)?.state).toBe('active');
    expect(app.plugins.getPlugin(toolSystem.name)?.state).toBe('active');
    expect(registry.getAll().map(tool => tool.name)).toContain('system_time');
  });
});
