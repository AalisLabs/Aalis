import { afterEach, describe, expect, it } from 'vitest';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import toolSystem from '../../packages/plugin-tool-system/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-storage.js';
import { makeToolRegistry } from '../fixtures/tool-registry.js';

// ════════════════════════════════════════════════════════════
// /tools 列真正注册了的工具组：开关开着、却因缺服务跳过注册的组（shell 缺 process）不列，回复不带表情与勾。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('/tools', () => {
  it('shell 开着但没有 process 服务：回复里没有 shell，只列注册了的组', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, commands: commandsService });
    host.provide.use(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
    host.provide.use(tools, makeToolRegistry(app.logger));
    host.provide.use(storage, memoryStorage().service as never);
    await app.plugin(commandsPlugin, {});
    await app.plugin(toolSystem);
    await app.plugins.idle();

    const cmd = host.commands.use.getAll().find(c => c.name === 'tools');
    if (!cmd?.handler) throw new Error('/tools 未注册');
    const out = await cmd.handler({
      session: { sessionId: 's', platform: 'webui', userId: 'u1', sessionType: 'private', raw: '/tools' },
      options: {},
    });
    expect(String(toSource(out))).toBe(['机器交互工具:', '  file', '  system', '  http'].join('\n'));
  });
});
