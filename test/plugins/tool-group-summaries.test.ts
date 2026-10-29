import { afterEach, describe, expect, it } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import todoListPlugin from '../../packages/plugin-todo-list/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import codeRunnerPlugin from '../../packages/plugin-tool-code-runner/src/index.js';
import mathPlugin from '../../packages/plugin-tool-math/src/index.js';
import sessionToolPlugin from '../../packages/plugin-tool-session/src/index.js';
import toolSystemPlugin from '../../packages/plugin-tool-system/src/index.js';
import { isTextRef } from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { makeToolRegistry } from '../fixtures/tool-registry.js';

// ════════════════════════════════════════════════════════════
// 工具插件登记的每个分组都带给人看的一句概述（summary），是文字对象：WebUI 设置里分组选项按读者的语言显示它，description 照旧
// 只给模型。每个插件单独起在一个 App 里，存储与进程服务是替身（只为让要它们的插件激活，登记分组时不调用）。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const CASES: [string, PluginDefinition, string[]][] = [
  ['tool-system', toolSystemPlugin, ['system']],
  ['tool-code-runner', codeRunnerPlugin, ['code-runner']],
  ['tool-browser', browserPlugin, ['browser']],
  ['tool-math', mathPlugin, ['math']],
  ['tool-session', sessionToolPlugin, ['session-history']],
  ['todo-list', todoListPlugin, ['todo']],
];

describe('工具插件的分组带文字对象的概述', () => {
  it.each(CASES)('%s', async (_, definition, groups) => {
    const app = new App({ name: 'T', logger: silent });
    apps.push(app);
    await registerHubs(app);
    const registry = makeToolRegistry(silent);
    const host = app.bind({ provide });
    host.provide.use(tools, registry);
    host.provide.use(storage, {} as never);
    host.provide.use(processService, {} as never);
    await app.plugin(definition, {});
    await app.plugins.idle();
    expect(app.plugins.getPlugin(definition.name)?.state).toBe('active');
    const mine = registry.getGroups().filter(group => group.pluginName === definition.name);
    expect(mine.map(group => [group.name, isTextRef(group.summary)])).toEqual(groups.map(name => [name, true]));
  });
});
