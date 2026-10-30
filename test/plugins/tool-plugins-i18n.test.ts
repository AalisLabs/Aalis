import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import todoListPlugin from '../../packages/plugin-todo-list/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import toolSystemPlugin from '../../packages/plugin-tool-system/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, renderIn } from '../fixtures/host-language.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { roomCommands, seedRooms } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 工具插件甲给人看的出口按读者的语言：/tools 的回复与 /clear 清待办的结果行（网关按房间的语言，房间没设时随全局默认层），
// 浏览器页的动作报错与回执（测试台不渲染，按语言渲染后比）。中文与改动前逐字相同。真的 tool-system、todo-list、网关、指令与
// plugin-i18n；没有存储与进程服务，tool-system 只登记得上 system 与 http 两组。
// ════════════════════════════════════════════════════════════

const CHAT = 'zz-chat';
const ROOM = `${CHAT}:bot:group:1`;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const hosts: PageHost[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const host of hosts.splice(0)) host.dispose();
});

async function room(language: string) {
  const { app } = hostedApp(i18nSection([language]), { logger: silent });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const host = app.bind({ memory });
  await seedRooms(host.memory.use, { [ROOM]: ROOM });
  const plugins = [
    toolsPlugin,
    toolSystemPlugin,
    todoListPlugin,
    sessionManagerPlugin,
    sessionSettingsPlugin,
    gatewayPlugin,
    commandsPlugin,
    i18nPlugin,
  ];
  await app.pluginAll(plugins.map(definition => ({ definition, config: {} })));
  await app.plugins.idle();
  for (const { name } of plugins) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  /** 给 sessions 个会话各存一份待办 */
  const seedTodos = (...sessions: string[]) =>
    Promise.all(sessions.map(id => host.memory.use.saveMetadata('todo-list', id, { items: [] })));
  return { ask: await roomCommands(app, ROOM, CHAT), seedTodos };
}

const CASES = {
  en: {
    tools: 'Machine interaction tools:\n  system\n  http',
    clear: [
      "Cleared the to-do list of this session\nCleared this session's message history",
      'Cleared the to-do lists of all sessions (1 session)\nCleared all message history and archives',
      'Cleared the to-do lists of all sessions (2 sessions)\nCleared all message history and archives',
    ],
    browser: ['Page zz-page does not exist', 'Closed all pages'],
  },
  'zh-CN': {
    tools: '机器交互工具：\n  system\n  http',
    clear: [
      '当前会话待办已清空\n当前会话消息历史已清空',
      '所有会话待办已清空（1 个会话）\n所有消息历史和归档已清空',
      '所有会话待办已清空（2 个会话）\n所有消息历史和归档已清空',
    ],
    browser: ['页面 zz-page 不存在', '已关闭全部页面'],
  },
};

describe('工具插件甲给人看的出口按读者的语言', () => {
  it.each(Object.entries(CASES))('%s：/tools 的回复，/clear 清待办的结果行', async (language, expected) => {
    const { ask, seedTodos } = await room(language);
    expect(await ask('/tools')).toBe(expected.tools);
    const session = await ask('/clear -t context');
    await seedTodos('zz-a');
    const one = await ask('/clear all -t context');
    await seedTodos('zz-a', 'zz-b');
    expect([session, one, await ask('/clear all -t context')]).toEqual(expected.clear);
  });

  it.each(
    Object.entries(CASES),
  )('%s：浏览器页关闭不存在的页面的报错，关闭全部页面的回执', async (language, expected) => {
    const app = new App({ name: 'T', logger: silent });
    apps.push(app);
    const pages = pageHost();
    hosts.push(pages);
    app.bind({ provide }).provide.use(webuiServer, pages.service);
    await app.plugin(browserPlugin, {});
    await app.plugins.idle();
    const missing = await pages.act('browser', 'closePage', { rowKey: 'zz-page' });
    const all = await pages.act('browser', 'closeAllPages');
    expect([
      renderIn((missing.body as { error: string }).error, language),
      renderIn((all.body as { message: string }).message, language),
    ]).toEqual(expected.browser);
  });
});
