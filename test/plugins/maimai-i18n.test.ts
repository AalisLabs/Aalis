import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import type { App, Logger } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import maimaiPlugin from '../../packages/plugin-maimai/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection } from '../fixtures/host-language.js';
import { registerHubs } from '../fixtures/hubs.js';
import { roomCommands, seedRooms } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// /help 里 /maimai 子指令的说明与参数说明按房间的语言（房间没设时随全局默认层）；查询目标的说明按 defaultBindOnPrivateChat
// 分两句，开着时多写私聊里按 QQ 号查。真的 maimai（只开指令）、网关、指令与 plugin-i18n。
// ════════════════════════════════════════════════════════════

const CHAT = 'zz-chat';
const ROOM = `${CHAT}:bot:group:1`;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function room(language: string, defaultBindOnPrivateChat: boolean) {
  const { app } = hostedApp(i18nSection([language]), { logger: silent });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  await seedRooms(app.bind({ memory }).memory.use, { [ROOM]: ROOM });
  const plugins = [sessionManagerPlugin, sessionSettingsPlugin, gatewayPlugin, commandsPlugin, i18nPlugin];
  await app.pluginAll([
    ...plugins.map(definition => ({ definition, config: {} })),
    {
      definition: maimaiPlugin,
      config: { developerToken: 'zz-token', enableTools: false, defaultBindOnPrivateChat },
    },
  ]);
  await app.plugins.idle();
  for (const { name } of [...plugins, maimaiPlugin]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  return roomCommands(app, ROOM, CHAT);
}

const CASES: [string, boolean, string][] = [
  [
    'en',
    true,
    [
      '/maimai recent — Look up recent plays',
      '',
      'Usage: /maimai recent [target] [count]',
      '',
      'Arguments:',
      '- [target]: Friend code, or qq:QQ number; when left out, your bound friend code is queried, or your QQ number in a OneBot private chat without a binding',
      '- [count]: How many to show, 10 by default, at most 50',
    ].join('\n'),
  ],
  [
    'en',
    false,
    [
      '/maimai recent — Look up recent plays',
      '',
      'Usage: /maimai recent [target] [count]',
      '',
      'Arguments:',
      '- [target]: Friend code, or qq:QQ number; when left out, your bound friend code is queried',
      '- [count]: How many to show, 10 by default, at most 50',
    ].join('\n'),
  ],
  [
    'zh-CN',
    true,
    [
      '/maimai recent — 查询最近游玩',
      '',
      '用法：/maimai recent [target] [count]',
      '',
      '参数：',
      '- [target]：好友码，或 qq:QQ 号；不写时查你绑定的好友码，OneBot 私聊里没绑定时按你的 QQ 号查',
      '- [count]：显示几条，默认 10，最多 50',
    ].join('\n'),
  ],
  [
    'zh-CN',
    false,
    [
      '/maimai recent — 查询最近游玩',
      '',
      '用法：/maimai recent [target] [count]',
      '',
      '参数：',
      '- [target]：好友码，或 qq:QQ 号；不写时查你绑定的好友码',
      '- [count]：显示几条，默认 10，最多 50',
    ].join('\n'),
  ],
];

describe('/maimai 的帮助按房间的语言', () => {
  it.each(CASES)('%s，defaultBindOnPrivateChat=%s：/help maimai recent', async (language, bind, expected) => {
    const ask = await room(language, bind);
    expect(await ask('/help maimai recent')).toBe(expected);
  });
});
