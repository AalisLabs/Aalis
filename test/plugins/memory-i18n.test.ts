import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type VectorStoreService, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeSummaryLLM } from '../fixtures/memory-summary.js';
import { memoryStorage } from '../fixtures/paper.js';
import { roomCommands, seedRooms } from '../fixtures/rooms.js';
import { client } from '../fixtures/session-client.js';

// ════════════════════════════════════════════════════════════
// 记忆增强给人看的出口按读者的语言：/clear 清摘要与向量记忆的结果行（网关按房间的语言，房间没设时随全局默认层）、正在压缩的
// 会话再发 session/compress 的错误帧（会话协议按全局默认层的语言）。中文与改动前逐字相同。真的 memory-summary、
// memory-vector、网关、指令、会话服务与 plugin-i18n；摘要模型、向量库与嵌入是替身。
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

/** 全局默认层的语言是 language；摘要模型挂在闸门上，放行前压缩一直在跑；向量库按会话删的条数依次是 1、2 */
async function setup(language: string) {
  const home = mkdtempSync(join(tmpdir(), 'zz-memory-i18n-'));
  homes.push(home);
  const { app } = hostedApp(i18nSection([language]), { logger: silent });
  apps.push(app);
  provideHostPaths(app, home);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const host = app.bind({ provide, memory, sessionProtocol });
  await seedRooms(host.memory.use, { [ROOM]: ROOM });
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const summaryModel = fakeSummaryLLM({
    reply: async () => {
      await gate;
      return 'SUMMARY-TEXT';
    },
  });
  host.provide.use(llm, summaryModel.model);
  const deleted = [1, 2];
  const store: VectorStoreService = {
    add: async () => {},
    search: async () => [],
    size: async () => 0,
    clear: async () => {},
    deleteByFilter: async () => deleted.shift() ?? 0,
    save: async () => {},
  };
  host.provide.use(vectorstore, store);
  host.provide.use(embedding, { modelId: 'zz', embed: async () => [1, 0] });
  host.provide.use(storage, memoryStorage(new Map()));
  const plugins = [
    memorySummary,
    memoryVector,
    sessionManagerPlugin,
    sessionSettingsPlugin,
    sessionServerPlugin,
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
  const ask = await roomCommands(app, ROOM, CHAT);
  return { host, summaryModel, release, ask };
}

describe('/clear 清摘要与向量记忆的结果行按房间的语言', () => {
  it.each([
    [
      'en',
      [
        'Cleared the summary of this session',
        'Cleared all session summaries',
        'Cleared the vector memory of this session (1 entry)',
        'Cleared the vector memory of this session (2 entries)',
        'Cleared all vector memory',
      ],
    ],
    [
      'zh-CN',
      [
        '当前会话摘要已清空',
        '所有会话摘要已清空',
        '向量记忆已清空（1 条）',
        '向量记忆已清空（2 条）',
        '所有向量记忆已清空',
      ],
    ],
  ])('%s', async (language, expected) => {
    const { ask } = await setup(language);
    const replies = [];
    for (const line of [
      '/clear -t summary',
      '/clear all -t summary',
      '/clear -t vector',
      '/clear -t vector',
      '/clear all -t vector',
    ]) {
      replies.push(await ask(line));
    }
    expect(replies).toEqual(expected);
  });
});

describe('正在压缩的会话再发 session/compress：错误帧按全局默认层的语言', () => {
  it.each([
    ['en', 'This session is being compacted; try again later'],
    ['zh-CN', '这个会话正在压缩，稍后再试'],
  ])('%s', async (language, expected) => {
    const { host, summaryModel, release } = await setup(language);
    for (const content of ['在吗', '在的', '聊聊']) await host.memory.use.saveMessage(ROOM, { role: 'user', content });
    const c = client(host.sessionProtocol.use);
    await c.init();
    const first = c.raw({ jsonrpc: '2.0', id: 'zz-first', method: 'session/compress', params: { sessionId: ROOM } });
    await expect.poll(() => summaryModel.requests.length).toBe(1);
    expect((await c.fail('session/compress', { sessionId: ROOM })).message).toBe(expected);
    release();
    await first;
  });
});
