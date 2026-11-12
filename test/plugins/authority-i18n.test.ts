import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { type StorageRootInfo, storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { seedRooms } from '../fixtures/rooms.js';
import { toolRequest } from '../fixtures/tool-call.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 执行守卫的拒绝语是 plugin-authority 字典里的文字对象：指令一路由 plugin-commands 作为回复交出，网关按房间的语言渲染
// （en 房间拿英文、zh-CN 房间拿原文）；工具一路交给模型，取原文。/authority 与 /level 的回复同样按房间的语言。真的
// plugin-authority、plugin-commands、plugin-gateway、plugin-tools、会话管理、会话设置与 plugin-i18n，记忆是内存实现，存储是
// 替身。权限页与 users.json 读不出的提示另走真的 webui-server，按全局层的语言。
// ════════════════════════════════════════════════════════════

const CHAT = 'zz-chat';
const USER = 'zz-user';
const OWNER = 'zz-owner';
/** 预置在会话表里的房间：经网关的原生入站会执行整条相位链，不经它收录 */
const ROOMS = [1, 2, 3, 4, 5, 6].map(n => `${CHAT}:bot:group:${n}`);
const DENIED = '权限不足："command:zz-admin" 需等级 2（当前 0）';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function setup() {
  const { app } = hostedApp({ owners: [{ platform: CHAT, userId: OWNER }] }, { logger: silent });
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
  /** 在下一个预置的房间里把语言设成 language、以 userId 敲一条指令，取它引出的回复 */
  const ask = async (language: string[], content: string, userId = USER): Promise<string> => {
    const sessionId = ROOMS[rooms++];
    await host.sessionSettings.use.update({ sessionId }, { plugin: i18nPlugin.name, key: 'language', value: language });
    const before = sent.length;
    void host.gateway.use.ingressMessage({ content, sessionId, platform: CHAT, userId });
    await vi.waitFor(() => expect(sent.length).toBe(before + 1));
    return sent[before].content;
  };
  return { host, ask };
}

describe('执行守卫的拒绝语', () => {
  it('指令一路：en 房间的回复是英文，zh-CN 房间是原文', async () => {
    const s = await setup();
    expect(await s.ask(['en'], '/zz-admin')).toBe(
      'Insufficient permission: “command:zz-admin” needs level 2 (current 0)',
    );
    expect(await s.ask(['zh-CN'], '/zz-admin')).toBe(DENIED);
  });

  it('工具一路：交给模型的是原文', async () => {
    const s = await setup();
    const result = await s.host.tools.use.execute(
      'zz_admin',
      {},
      toolRequest({ sessionId: 'zz-s', platform: CHAT, userId: USER }),
    );
    expect(result.content).toBe(JSON.stringify({ error: DENIED.replace('command:zz-admin', 'tool:zz_admin') }));
  });
});

describe('/authority 与 /level 的回复', () => {
  const REPLIES = {
    en: [
      'Set zz-chat:zz-user to level 1',
      'The level must be an integer',
      'Your level: 1',
      'Level of zz-chat:zz-other: 0',
      'You (owner, level ∞, all permissions)',
      'zz-chat:zz-owner (owner, level ∞, all permissions)',
    ],
    'zh-CN': [
      '已把 zz-chat:zz-user 的等级设为 1',
      '等级必须是整数',
      '您的等级：1',
      'zz-chat:zz-other 的等级：0',
      '您（owner，等级 ∞，拥有全部权限）',
      'zz-chat:zz-owner（owner，等级 ∞，拥有全部权限）',
    ],
  };

  it.each(
    Object.entries(REPLIES),
  )('%s 房间：设等级，问自己、问别人，owner 问自己、别人问 owner', async (language, expected) => {
    const s = await setup();
    const replies = [
      await s.ask([language], `/level ${CHAT}:${USER} 1`, OWNER),
      await s.ask([language], `/level ${CHAT}:${USER} 1.5`, OWNER),
      await s.ask([language], '/authority'),
      await s.ask([language], `/authority ${CHAT}:zz-other`),
      await s.ask([language], '/authority', OWNER),
      await s.ask([language], `/authority ${CHAT}:${OWNER}`),
    ];
    expect(replies).toEqual(expected);
  });
});

describe('权限页与 users.json 读不出的提示按全局层的语言', () => {
  const TOKEN = 'zz-authority-i18n-token-placeholder';
  const DATA_ROOT: StorageRootInfo = {
    name: 'data',
    label: 'data',
    kind: 'data',
    browsable: true,
    readable: true,
    writable: true,
    deletable: true,
  };

  /** users.json 是 version 4（读不懂、拒写）；工具服务替身登记着 zz-a 的一个工具 */
  async function page() {
    const port = await freePort();
    const { app } = hostedApp(i18nSection(['en']), { logger: silent });
    apps.push(app);
    const host = app.bind({ provide });
    host.provide.use(storage, {
      listRoots: () => [DATA_ROOT],
      readFile: async () => JSON.stringify({ version: 4, users: {} }),
      writeFile: async () => undefined,
    } as never);
    host.provide.use(tools, {
      getAll: () => [{ name: 'zz_tool', pluginName: 'zz-a', risk: 'safe' }],
      getGroups: () => [],
      setExecutionGuard: () => {},
    } as never);
    await registerHubs(app);
    await app.plugin(i18nPlugin);
    await app.plugin(authorityPlugin);
    await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
    await app.plugins.idle();
    await app.start();
    await waitListening(port);
    const request = async (path: string, init: RequestInit = {}) =>
      (
        await fetch(`http://127.0.0.1:${port}${path}`, {
          ...init,
          headers: { cookie: `aalis_webui_token=${TOKEN}`, 'content-type': 'application/json' },
        })
      ).json();
    const at = `/api/pages/${encodeURIComponent(authorityPlugin.name)}/authority`;
    /** 调一个动作：回执或报错 */
    const act = async (action: string, body: Record<string, unknown>) => {
      const reply = await request(`${at}/actions/${action}`, { method: 'POST', body: JSON.stringify(body) });
      return reply.message ?? reply.error;
    };
    const data = async (id: string, rowKey?: string) =>
      (await request(`${at}/data/${id}${rowKey === undefined ? '' : `?rowKey=${encodeURIComponent(rowKey)}`}`)).data;
    return { request, act, data };
  }

  it('en：添加规则与门槛的回执和报错，规则表与操作的种类', async () => {
    const p = await page();
    expect([
      await p.act('denyCapability', { input: { pattern: 'tool:zz' } }),
      await p.act('denyCapability', { input: { pattern: 'tool:zz' } }),
      await p.act('denyCapability', { input: { pattern: ' ' } }),
      await p.act('waiveConfirm', { input: { pattern: 'tool:zz' } }),
      await p.act('removeRule', { rowKey: 'waive:tool:zz' }),
      await p.act('removeRule', { rowKey: 'waive:tool:zz' }),
      await p.act('setOperationLevel', { rowKey: 'tool:zz_tool', input: { level: 3 } }),
      await p.act('setOperationLevel', { rowKey: 'tool:zz_tool', input: {} }),
      await p.act('setOperationLevel', { rowKey: 'tool:zz_none', input: {} }),
      await p.act('setGroupLevel', { rowKey: 'zz-a', input: { level: 2 } }),
      await p.act('setGroupLevel', { rowKey: 'zz-a', input: {} }),
      await p.act('setGroupLevel', { rowKey: 'zz-none', input: {} }),
    ]).toEqual([
      'Added tool:zz to the deny list',
      'tool:zz is already on the deny list',
      'The capability cannot be empty',
      'Added tool:zz to the confirmation waiver list',
      'Removed tool:zz from the confirmation waiver list',
      'No such rule: waive:tool:zz',
      'Set the threshold of tool:zz_tool to 3',
      'tool:zz_tool is back to the default threshold',
      'No operation tool:zz_none',
      'Set the threshold of 1 operation of zz-a to 2',
      '1 operation of zz-a is back to the default threshold',
      'zz-none has no registered commands or tools',
    ]);
    expect((await p.data('rules')).map((row: { kind: string }) => row.kind)).toEqual(['Deny (even the owner)']);
    expect((await p.data('operations', 'zz-a')).map((row: { kind: string }) => row.kind)).toEqual(['Tool']);
  });

  it('en：users.json 读不出来，「需要处理」的提示与原因', async () => {
    const p = await page();
    const { items } = await p.request('/api/attention');
    expect(
      items
        .filter((item: { kind: string }) => item.kind === 'notice')
        .map((item: { title: string; detail: string }) => [item.title, item.detail]),
    ).toEqual([
      [
        'The user level table users.json cannot be read; the bans and levels in it were not loaded',
        'Fix state/users.json in the data directory, then restart: it must be readable and intact version 5 JSON; old versions are not migrated, so if you do not need its records, move it away and restart. Until it is fixed, level changes only last for this run. Reason: not a valid v5 structure (version: 4)',
      ],
    ]);
  });
});
