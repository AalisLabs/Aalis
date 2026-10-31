import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { failureText } from '../../packages/api-doctor/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import type { App, Logger } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import layaPlugin from '../../packages/plugin-trigger-laya/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import { isTextError } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, renderIn } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { roomCommands, seedRooms } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 触发与人设给人看的出口按读者的语言：Laya 的配置报错（插件失败原因）、/clear 清人设状态的结果行（网关按房间的语言，房间
// 没设时随全局默认层）。真的触发、人设、网关、指令与 plugin-i18n；生效的触发插件是 trigger-policy，
// Laya 不是生效者，不连侧车。
// ════════════════════════════════════════════════════════════

const CHAT = 'zz-chat';
const ROOM = `${CHAT}:bot:group:1`;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 全局默认层的语言是 language；laya 是 Laya 的配置 */
async function setup(language: string, laya: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'zz-trigger-persona-i18n-'));
  homes.push(home);
  const { app } = hostedApp(i18nSection([language]), { logger: silent });
  apps.push(app);
  provideHostPaths(app, home);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  await seedRooms(app.bind({ memory }).memory.use, { [ROOM]: ROOM });
  const plugins = [
    sessionManagerPlugin,
    sessionSettingsPlugin,
    gatewayPlugin,
    commandsPlugin,
    personaPlugin,
    triggerPolicyPlugin,
    i18nPlugin,
  ];
  await app.pluginAll([
    ...plugins.map(definition => ({ definition, config: {} })),
    { definition: layaPlugin, config: laya },
  ]);
  await app.plugins.idle();
  for (const { name } of plugins) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  return { app, ask: await roomCommands(app, ROOM, CHAT) };
}

const CASES = {
  en: {
    configError: 'plugin-trigger-laya config error: endpoint must be an HTTP address',
    clear: ['Cleared the persona state of this session', 'Cleared the persona state of all sessions'],
  },
  'zh-CN': {
    configError: 'plugin-trigger-laya 配置错误：endpoint 须为 HTTP 地址',
    clear: ['当前会话角色状态已清空', '所有会话角色状态已清空'],
  },
};

describe('触发与人设给人看的出口按读者的语言', () => {
  it.each(Object.entries(CASES))('%s：/clear 清人设状态的回执', async (language, expected) => {
    const { ask } = await setup(language);
    expect([await ask('/clear -t persona'), await ask('/clear all -t persona')]).toEqual(expected.clear);
  });

  it.each(Object.entries(CASES))('%s：Laya 的 endpoint 不是 HTTP 地址时的插件失败原因', async (language, expected) => {
    const { app } = await setup(language, { endpoint: 'ftp://zz.invalid' });
    const failure = app.plugins.getStatus().find(e => e.name === layaPlugin.name)?.failure;
    if (!isTextError(failure)) throw new Error(`失败原因没有文字对象：${String(failure)}`);
    expect(failure.name).toBe('ConfigError');
    expect(renderIn(failureText({ failure }), language)).toBe(expected.configError);
  });
});
