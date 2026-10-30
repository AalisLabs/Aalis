import { afterEach, describe, expect, it } from 'vitest';
import { platform } from '../../packages/api-platform/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, type Logger, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import drawPlugin from '../../packages/plugin-draw/src/index.js';
import fileReaderPlugin from '../../packages/plugin-file-reader/src/index.js';
import maimaiPlugin from '../../packages/plugin-maimai/src/index.js';
import mcpClientPlugin from '../../packages/plugin-mcp-client/src/index.js';
import officePlugin from '../../packages/plugin-office/src/index.js';
import okxPlugin from '../../packages/plugin-okx-trading/src/index.js';
import schedulerPlugin from '../../packages/plugin-scheduler/src/index.js';
import skillsPlugin from '../../packages/plugin-skills/src/index.js';
import subtaskPlugin from '../../packages/plugin-subtask/src/index.js';
import todoListPlugin from '../../packages/plugin-todo-list/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import codeRunnerPlugin from '../../packages/plugin-tool-code-runner/src/index.js';
import mathPlugin from '../../packages/plugin-tool-math/src/index.js';
import toolOnebotPlugin from '../../packages/plugin-tool-onebot/src/index.js';
import sessionToolPlugin from '../../packages/plugin-tool-session/src/index.js';
import toolSystemPlugin from '../../packages/plugin-tool-system/src/index.js';
import websearchPlugin from '../../packages/plugin-websearch-serper/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { isTextRef, resolveText, toSource } from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { memoryStorage } from '../fixtures/paper.js';
import { makeToolRegistry } from '../fixtures/tool-registry.js';

// ════════════════════════════════════════════════════════════
// 工具插件登记的每个分组都带给人看的一句概述（summary），是文字对象：WebUI 设置里分组选项按读者的语言显示它，description 照旧
// 只给模型。每个插件单独起在一个 App 里，存储是内存替身、进程服务是空替身（只为让要它们的插件激活），WebUI 是测试台，另有真的
// cron-engine（定时与编排要它），要凭据的插件给占位凭据。OKX 的概述按模拟盘与实盘分两句；mcp-client 按服务器桥接的分组也有，服务器是一启动就退出的 node 进程。
// tool-onebot 只在出现 OneBot 平台时登记，激活之后另登记一个 OneBot 平台的替身。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
const hosts: PageHost[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const host of hosts.splice(0)) host.dispose();
});

const OKX = { apiKey: 'zz-key', secretKey: 'zz-secret', passphrase: 'zz-pass' };

/** 激活之后登记一个 OneBot 平台的替身，等 tool-onebot 跟上 */
async function onebotOnline(app: App): Promise<void> {
  app.bind({ provide }).provide.use(platform, {
    adapterName: 'onebot',
    platform: 'onebot',
    getConnections: () => [],
    sendMessage: async () => {},
  });
  await new Promise(resolve => setTimeout(resolve, 0));
}

const CASES: [string, PluginDefinition, string[], Record<string, unknown>?, ((app: App) => Promise<void>)?][] = [
  ['tool-system', toolSystemPlugin, ['system']],
  ['tool-code-runner', codeRunnerPlugin, ['code-runner']],
  ['tool-browser', browserPlugin, ['browser']],
  ['tool-math', mathPlugin, ['math']],
  ['tool-session', sessionToolPlugin, ['session-history']],
  ['todo-list', todoListPlugin, ['todo']],
  ['file-reader', fileReaderPlugin, ['file-reader']],
  ['draw', drawPlugin, ['draw']],
  ['office', officePlugin, ['office']],
  ['websearch-serper', websearchPlugin, ['search'], { apiKey: 'zz-key' }],
  ['okx-trading', okxPlugin, ['okx'], OKX],
  ['maimai', maimaiPlugin, ['maimai'], { developerToken: 'zz-token' }],
  [
    'mcp-client',
    mcpClientPlugin,
    ['mcp:zz', 'mcp:_meta'],
    { servers: [{ id: 'zz', command: process.execPath, args: ['-e', 'process.exit(3)'] }] },
  ],
  ['skills', skillsPlugin, ['skills']],
  ['subtask', subtaskPlugin, ['subtask']],
  ['scheduler', schedulerPlugin, ['scheduler']],
  ['workflow', workflowPlugin, ['workflow']],
  ['tool-onebot', toolOnebotPlugin, ['onebot-daily', 'onebot-group', 'onebot-personal'], {}, onebotOnline],
];

/** 只起这一个插件（激活之后先跑 after），交出它登记的分组 */
async function groupsOf(
  definition: PluginDefinition,
  config: Record<string, unknown> = {},
  after?: (app: App) => Promise<void>,
) {
  const app = new App({ name: 'T', logger: silent });
  apps.push(app);
  await registerHubs(app);
  const registry = makeToolRegistry(silent);
  const host = app.bind({ provide });
  host.provide.use(tools, registry);
  host.provide.use(storage, memoryStorage(new Map()));
  host.provide.use(processService, {} as never);
  const pages = pageHost();
  hosts.push(pages);
  host.provide.use(webuiServer, pages.service);
  await app.plugin(cronEnginePlugin, {});
  await app.plugin(definition, config);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(definition.name)?.state).toBe('active');
  await after?.(app);
  return registry.getGroups().filter(group => group.pluginName === definition.name);
}

describe('工具插件的分组带文字对象的概述', () => {
  it.each(CASES)('%s', async (_, definition, groups, config, after) => {
    const mine = await groupsOf(definition, config, after);
    expect(mine.map(group => [group.name, isTextRef(group.summary)])).toEqual(groups.map(name => [name, true]));
  });

  it('okx-trading：模拟盘与实盘各一句', async () => {
    const summaries = [];
    for (const demo of [true, false]) {
      const [group] = await groupsOf(okxPlugin, { ...OKX, demo });
      if (!isTextRef(group.summary)) throw new Error('OKX 的分组没有文字对象的概述');
      summaries.push([toSource(group.summary), resolveText(group.summary, ['en'])]);
    }
    expect(summaries).toEqual([
      [
        'OKX 虚拟币交易工具集 (模拟盘)，提供行情查询、账户管理、下单交易等功能',
        'OKX crypto trading tools (demo trading): market data, account management, order placement and more',
      ],
      [
        'OKX 虚拟币交易工具集 (实盘)，提供行情查询、账户管理、下单交易等功能',
        'OKX crypto trading tools (live trading): market data, account management, order placement and more',
      ],
    ]);
  });
});
