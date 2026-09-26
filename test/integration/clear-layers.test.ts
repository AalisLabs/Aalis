import { afterEach, describe, expect, it } from 'vitest';
import { type BoundCommands, commands as commandsService } from '../../packages/api-commands/src/index.js';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type VectorStoreService, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import onebot from '../../packages/plugin-adapter-onebot/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import todoList from '../../packages/plugin-todo-list/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import userRelation from '../../packages/plugin-user-relation/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /clear 按层清理（同一 App 装上持有各命名空间的插件，经 /clear 指令驱动）：
//   - context 管会话级短期上下文：消息（含归档）、摘要、待办；全局时另清 OneBot 合并转发原文。
//   - 向量、用户档案（含第三方行为指令）、关系图属跨会话长期层，只在显式指定类型或不带类型的
//     /clear all 时清；会话级 /clear 不动档案与关系图。
//   - 会话表（sessions）与第三方绑定（maimai-binding）任何类型都不清。
// 记忆后端的 clearAll 只清消息；各命名空间由归属插件的 memory:clear 中间件清理。
// user-profile 关掉 enableInstructions：指令照样随 user-profile 清。
// ════════════════════════════════════════════════════════════

const SEED: Record<string, string[]> = {
  summary: ['s-cur', 's-other'],
  'todo-list': ['s-cur', 's-other'],
  'onebot:forward': ['F1'],
  'user:profile': ['onebot:u1'],
  'aalis:instructions': ['Aalis'],
  'user-relation': ['person:onebot:u1'],
  'user-relation-vec': ['event:e1'],
  'memory-vector': ['legacy-model'],
  sessions: ['s-cur', 's-other'],
  'maimai-binding': ['onebot:u1'],
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function world() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, services, commands: commandsService });
  const vec = { cleared: 0, deletedBy: [] as Array<Record<string, unknown>> };
  const store: VectorStoreService = {
    add: async () => {},
    search: async () => [],
    size: async () => 0,
    clear: async () => {
      vec.cleared++;
    },
    deleteByFilter: async filter => {
      vec.deletedBy.push(filter);
      return 0;
    },
    save: async () => {},
  };
  host.provide(vectorstore, store);
  host.provide(embedding, { modelId: 'test:A', embed: async () => [0.1, 0.2] });
  host.provide(llm, { id: 'stub-model', capabilities: ['chat'], chat: async () => ({ content: '{}' }) } as never);
  host.provide(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  // storage / process 只为让 onebot 过激活闸：附件缓存的清理因此报失败，不在本测范围
  host.provide(storage, {} as never);
  host.provide(processService, {} as never);

  await app.pluginAll([
    { definition: memoryInMemory },
    { definition: commandsPlugin, config: {} },
    { definition: memorySummary, config: {} },
    {
      definition: memoryVector,
      config: {
        search: { topK: 5, timeWeight: 0, userPriorityBoost: 1, perItemMaxChars: 0, minScore: 0 },
        contextExpand: { window: 0, crossSession: true },
        indexing: { concurrency: 1, maxQueueSize: 10 },
        crossSessionMode: 'all',
        recallRoles: 'all',
      },
    },
    { definition: todoList, config: {} },
    { definition: onebot, config: { connections: [] } },
    { definition: userProfile, config: { enableInstructions: false } },
    { definition: userRelation, config: {} },
  ]);
  await app.plugins.idle();
  const inactive = app.plugins
    .getStatus()
    .filter(p => p.state !== 'active')
    .map(p => `${p.instanceId}: ${p.state}`);
  expect(inactive).toEqual([]);

  const mem = host.services.get(memory) as MemoryService;
  for (const [ns, keys] of Object.entries(SEED))
    for (const key of keys) await mem.saveMetadata(ns, key, { seeded: true });
  for (const s of ['s-cur', 's-other']) {
    for (let i = 0; i < 3; i++) await mem.saveMessage(s, { role: 'user', content: `${s}-${i}`, timestamp: 1000 + i });
    await mem.trimHistory!(s, 1);
  }

  async function run(name: 'clear' | 'clear.all', types?: string[]): Promise<string> {
    const cmd = (host.commands as BoundCommands).current?.getAll().find(c => c.name === name);
    if (!cmd?.handler) throw new Error(`/${name} 未注册`);
    const out = await cmd.handler({
      session: { sessionId: 's-cur', platform: 'webui', userId: 'u1', sessionType: 'private', raw: `/${name}` },
      options: types ? { type: types } : {},
    });
    return String(out);
  }

  /** 各命名空间剩下的 key，与各会话剩下的消息条数（含归档） */
  async function snapshot() {
    const namespaces: Record<string, string[]> = {};
    for (const ns of Object.keys(SEED)) namespaces[ns] = (await mem.listMetadata(ns)).map(e => e.key).sort();
    const messages: Record<string, number> = {};
    for (const s of ['s-cur', 's-other']) messages[s] = (await mem.getFullHistory!(s)).length;
    return { namespaces, messages };
  }

  return { run, snapshot, vec };
}

/** SEED 去掉给定命名空间（整个清空）后的期望 */
function without(...cleared: string[]): Record<string, string[]> {
  return Object.fromEntries(Object.entries(SEED).map(([ns, keys]) => [ns, cleared.includes(ns) ? [] : [...keys]]));
}

describe('/clear 按层清理', () => {
  it('/clear all -t context：清全部消息、摘要、待办与转发原文，长期层与会话表、绑定保留', async () => {
    const { run, snapshot, vec } = await world();
    await run('clear.all', ['context']);
    expect(await snapshot()).toEqual({
      namespaces: without('summary', 'todo-list', 'onebot:forward'),
      messages: { 's-cur': 0, 's-other': 0 },
    });
    expect(vec).toEqual({ cleared: 0, deletedBy: [] });
  });

  it('/clear all：清全部类型；会话表与第三方绑定保留', async () => {
    const { run, snapshot, vec } = await world();
    await run('clear.all');
    expect(await snapshot()).toEqual({
      namespaces: without(
        'summary',
        'todo-list',
        'onebot:forward',
        'user:profile',
        'aalis:instructions',
        'user-relation',
        'user-relation-vec',
        'memory-vector',
      ),
      messages: { 's-cur': 0, 's-other': 0 },
    });
    expect(vec).toEqual({ cleared: 1, deletedBy: [] });
  });

  it('/clear（会话级）：只清本会话的消息、摘要、待办与向量，转发原文与长期层不动', async () => {
    const { run, snapshot, vec } = await world();
    await run('clear');
    expect(await snapshot()).toEqual({
      namespaces: { ...SEED, summary: ['s-other'], 'todo-list': ['s-other'] },
      messages: { 's-cur': 0, 's-other': 3 },
    });
    expect(vec).toEqual({ cleared: 0, deletedBy: [{ sessionId: 's-cur' }] });
  });
});
