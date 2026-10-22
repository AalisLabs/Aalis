import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events, type Logger, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { seedRooms } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 执行守卫的拒绝语是 plugin-authority 字典里的文字对象：指令一路由 plugin-commands 作为回复交出，网关按房间的语言渲染
// （en 房间拿英文、zh-CN 房间拿原文）；工具一路交给模型，取原文。真的 plugin-authority、plugin-commands、plugin-gateway、
// plugin-tools、会话管理、会话设置与 plugin-i18n，记忆是内存实现，存储是替身。
// ════════════════════════════════════════════════════════════

const CHAT = 'zz-chat';
const USER = 'zz-user';
/** 预置在会话表里的房间：经网关的原生入站会跑完整条相位链，不经它收录 */
const ROOMS = [1, 2].map(n => `${CHAT}:bot:group:${n}`);
const DENIED = '权限不足: "command:zz-admin" 需等级 2（当前 0）';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function setup() {
  const { app } = hostedApp({}, { logger: silent });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-authority-i18n-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({ provide, events, commands, gateway, sessionSettings, tools });
  host.provide.use(storage, memoryStorage(new Map()));
  // 房间要在会话管理读表之前预置进记忆后端
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  await seedRooms(app.bind({ memory }).memory.use, Object.fromEntries(ROOMS.map(id => [id, id])));
  const plugins = [
    sessionManagerPlugin,
    sessionSettingsPlugin,
    gatewayPlugin,
    commandsPlugin,
    toolsPlugin,
    authorityPlugin,
    i18nPlugin,
  ];
  await app.pluginAll(plugins.map(definition => ({ definition, config: {} })));
  await app.plugins.idle();
  for (const { name } of [memoryInMemory, ...plugins]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  // 门槛 2 的指令与工具：未登记的用户是默认等级 0
  host.commands.use.command('zz-admin', '管理', { visibility: 'restricted' }).action(() => 'ran');
  host.tools.use.register({
    visibility: 'restricted',
    definition: {
      type: 'function',
      function: { name: 'zz_admin', description: '管理', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ran',
  });
  await vi.waitFor(() => expect(host.commands.use.get('zz-admin')).toBeDefined());

  const sent: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', message => {
    if (message.platform === CHAT) sent.push(message);
  });
  let rooms = 0;
  /** 在下一个预置的房间里把语言设成 language、敲一条指令，取它引出的回复 */
  const ask = async (language: string[], content: string): Promise<string> => {
    const sessionId = ROOMS[rooms++];
    await host.sessionSettings.use.update({ sessionId }, { plugin: i18nPlugin.name, key: 'language', value: language });
    const before = sent.length;
    void host.gateway.use.ingressMessage({ content, sessionId, platform: CHAT, userId: USER });
    await vi.waitFor(() => expect(sent.length).toBe(before + 1));
    return sent[before].content;
  };
  return { host, ask };
}

describe('执行守卫的拒绝语', () => {
  it('指令一路：en 房间的回复是英文，zh-CN 房间是原文', async () => {
    const s = await setup();
    expect(await s.ask(['en'], '/zz-admin')).toBe(
      'Insufficient permission: "command:zz-admin" needs level 2 (current 0)',
    );
    expect(await s.ask(['zh-CN'], '/zz-admin')).toBe(DENIED);
  });

  it('工具一路：交给模型的是原文', async () => {
    const s = await setup();
    const result = await s.host.tools.use.execute('zz_admin', {}, { sessionId: 'zz-s', platform: CHAT, userId: USER });
    expect(result.content).toBe(JSON.stringify({ error: DENIED.replace('command:zz-admin', 'tool:zz_admin') }));
  });
});
