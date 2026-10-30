import { afterEach, describe, expect, it } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, type Logger, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import drawPlugin from '../../packages/plugin-draw/src/index.js';
import fileReaderPlugin from '../../packages/plugin-file-reader/src/index.js';
import maimaiPlugin from '../../packages/plugin-maimai/src/index.js';
import mcpClientPlugin from '../../packages/plugin-mcp-client/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import officePlugin from '../../packages/plugin-office/src/index.js';
import okxPlugin from '../../packages/plugin-okx-trading/src/index.js';
import paperPlugin from '../../packages/plugin-paper/src/index.js';
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
import userProfilePlugin from '../../packages/plugin-user-profile/src/index.js';
import userRelationPlugin from '../../packages/plugin-user-relation/src/index.js';
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
// tool-onebot 只在出现 OneBot 平台时登记，激活之后另登记一个 OneBot 平台的替身；user-profile 要记忆（内存实现）与对话模型（替身），
// user-relation 只要记忆，同用这一份；白纸要会话管理（替身）。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
const hosts: PageHost[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const host of hosts.splice(0)) host.dispose();
});

const OKX = { apiKey: 'zz-key', secretKey: 'zz-secret', passphrase: 'zz-pass' };

/** 插件激活之前（before）或之后（after）要宿主另做的 */
interface Around {
  before?: (app: App) => Promise<void>;
  after?: (app: App) => Promise<void>;
}

/** 激活之后登记一个 OneBot 平台的替身，等 tool-onebot 跟上 */
const onebotOnline: Around = {
  async after(app) {
    app.bind({ provide }).provide.use(platform, {
      adapterName: 'onebot',
      platform: 'onebot',
      getConnections: () => [],
      sendMessage: async () => {},
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  },
};

/** 会话管理的替身：没有会话，场所都是默认工作区 */
const noSessions: Around = {
  async before(app) {
    app.bind({ provide }).provide.use(sessionManager, {
      placeOf: () => ({ kind: 'workspace', key: 'workspace:default' }),
      listSessions: () => [],
      getSession: () => undefined,
    } as never);
  },
};

/** 记忆用内存实现，对话模型是替身 */
const memoryAndModel: Around = {
  async before(app) {
    app
      .bind({ provide })
      .provide.use(llm, { id: 'zz-model', capabilities: ['chat'], chat: async () => ({ content: '' }) } as never);
    await app.plugin(memoryInMemory);
  },
};

const CASES: [string, PluginDefinition, string[], Record<string, unknown>?, Around?][] = [
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
  ['user-profile', userProfilePlugin, ['user-profile'], {}, memoryAndModel],
  ['user-relation', userRelationPlugin, ['user-relation'], {}, memoryAndModel],
  ['paper', paperPlugin, ['paper', 'works'], {}, noSessions],
];

/** 只起这一个插件（宿主另做的见 around），交出它登记的分组 */
async function groupsOf(definition: PluginDefinition, config: Record<string, unknown> = {}, around: Around = {}) {
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
  await around.before?.(app);
  await app.plugin(definition, config);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(definition.name)?.state).toBe('active');
  await around.after?.(app);
  return registry.getGroups().filter(group => group.pluginName === definition.name);
}

describe('工具插件的分组带文字对象的概述', () => {
  it.each(CASES)('%s', async (_, definition, groups, config, around) => {
    const mine = await groupsOf(definition, config, around);
    expect(mine.map(group => [group.name, isTextRef(group.summary)])).toEqual(groups.map(name => [name, true]));
  });

  it('mcp-client 的元数据组、user-profile 与 user-relation：原文与英文都不以句号收尾，与其余各组一致', async () => {
    const summaries = [];
    for (const [id, name] of [
      ['mcp-client', 'mcp:_meta'],
      ['user-profile', 'user-profile'],
      ['user-relation', 'user-relation'],
    ]) {
      const found = CASES.find(([caseId]) => caseId === id);
      if (!found) throw new Error(`CASES 里没有 ${id}`);
      const [, definition, , config, around] = found;
      const group = (await groupsOf(definition, config, around)).find(g => g.name === name);
      if (!isTextRef(group?.summary)) throw new Error(`${name} 没有文字对象的概述`);
      summaries.push([toSource(group.summary), resolveText(group.summary, ['en'])]);
    }
    expect(summaries).toEqual([
      [
        '让 agent 列出和切换已配置的 MCP 服务器（不能新增/删除条目）',
        'Let the agent list configured MCP servers and turn them on or off (entries cannot be added or removed)',
      ],
      ['查询已经积累的某人事实档案', 'Look up the fact profile built up for a person'],
      [
        '查询用户关系图：跨类节点解析 / BFS 子图 / 任意节点最短路径 / 多类型筛选边 / 节点时间线',
        'Query the user relation graph: node resolution across kinds / BFS subgraphs / shortest paths between any nodes / edges filtered by type / node timelines',
      ],
    ]);
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
        'OKX 虚拟币交易工具集（模拟盘），提供行情查询、账户管理、下单交易等功能',
        'OKX crypto trading tools (demo trading): market data, account management, order placement and more',
      ],
      [
        'OKX 虚拟币交易工具集（实盘），提供行情查询、账户管理、下单交易等功能',
        'OKX crypto trading tools (live trading): market data, account management, order placement and more',
      ],
    ]);
  });
});
