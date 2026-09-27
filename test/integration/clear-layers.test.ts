import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { type BoundCommands, commands as commandsService } from '../../packages/api-commands/src/index.js';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type VectorStoreService, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, LogHub, provide, services } from '../../packages/core/src/index.js';
import onebot from '../../packages/plugin-adapter-onebot/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { SQLiteMemoryService } from '../../packages/plugin-memory-sqlite/src/index.js';
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

/** backend：换用给定的记忆后端（不装 memory-inmemory），info 及以上的日志记进 logHub */
async function world(backend?: { memory: MemoryService; logHub: LogHub }) {
  const app = new App({ name: 'T', logLevel: backend ? 'info' : 'error', logHub: backend?.logHub });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, services, commands: commandsService });
  if (backend) host.provide(memory, backend.memory);
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
    ...(backend ? [] : [{ definition: memoryInMemory }]),
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

  async function run(name: 'clear' | 'clear.all' | 'profile.clear.nuke', types?: string[]): Promise<string> {
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

  return { run, snapshot, vec, mem, store };
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

  it('逐个指定已装插件处理的类型：各插件的结果行都标注了类型，回执不报「没有插件处理」', async () => {
    const { run } = await world();
    const out = await run('clear.all', ['context', 'summary', 'vector', 'user-profile', 'user-relation']);
    for (const text of [
      '所有消息历史',
      '所有会话摘要',
      '所有向量记忆',
      '用户档案已清空',
      '第三方行为指令已清空',
      '关系图已清空',
    ])
      expect(out).toContain(text);
    expect(out).not.toContain('没有已启用的插件处理');
  });

  it('会话级逐个指定 context、summary、vector：各行标注了类型，回执不报「没有插件处理」', async () => {
    const { run } = await world();
    const out = await run('clear', ['context', 'summary', 'vector']);
    for (const text of ['当前会话消息历史已清空', '当前会话摘要已清空', '向量记忆已清空 (0 条)'])
      expect(out).toContain(text);
    expect(out).not.toContain('没有已启用的插件处理');
  });

  it('消息历史清理失败：照实报失败，失败行标注 context，回执不报「没有插件处理」', async () => {
    const { run, mem } = await world();
    mem.clearSession = async () => {
      throw new Error('后端故障');
    };
    const out = await run('clear', ['context']);
    expect(out).toContain('⚠ 清空失败: 后端故障');
    expect(out).not.toContain('没有已启用的插件处理');
  });

  it('各插件清理失败：照实报失败，失败行同样标注类型，回执不报「没有插件处理」', async () => {
    const { run, mem, store } = await world();
    const broken = async () => {
      throw new Error('后端故障');
    };
    mem.listMetadata = broken;
    mem.commitMetadata = broken;
    store.clear = broken;
    const all = await run('clear.all', ['summary', 'vector', 'user-profile', 'user-relation']);
    for (const text of [
      '⚠ 摘要清空失败: 后端故障',
      '⚠ 向量清空失败: 后端故障',
      '⚠ 用户档案清空失败: 后端故障',
      '⚠ 指令清空失败: 后端故障',
      '⚠ 关系图清空失败: 后端故障',
    ])
      expect(all).toContain(text);
    expect(all).not.toContain('没有已启用的插件处理');

    // 向量存储不支持按条件删除：会话级清理照实报未清除
    delete store.deleteByFilter;
    const session = await run('clear', ['vector']);
    expect(session.startsWith('⚠ 当前向量存储不支持会话级清空')).toBe(true);
    expect(session).not.toContain('没有已启用的插件处理');
  });

  // 读不出的条目（手改或损坏）listMetadata 会跳过：此前按它枚举键清理，这些条目删不掉、回执条数也不含它们
  it('sqlite 后端：读不出的条目随所在命名空间一并清掉，回执条数计入，各插件记一条 info 点名', async () => {
    const db = new Database(':memory:');
    const logHub = new LogHub();
    const infos: string[] = [];
    logHub.onEntry(e => {
      if (e.level === 'info' && e.message.includes('读不出')) infos.push(e.message);
    });
    const { run } = await world({ memory: new SQLiteMemoryService(db, { logger: { warn() {} } }), logHub });
    const insertBad = db.prepare("INSERT INTO metadata (namespace, key, data) VALUES (?, 'bad', '{not json')");
    for (const ns of Object.keys(SEED)) if (ns !== 'memory-vector') insertBad.run(ns);

    const out = await run('clear.all');

    const left = db.prepare('SELECT namespace, key FROM metadata').all() as Array<{ namespace: string; key: string }>;
    expect(left.map(r => `${r.namespace}/${r.key}`).sort(), '会话表与第三方绑定照旧不清').toEqual([
      'maimai-binding/bad',
      'maimai-binding/onebot:u1',
      'sessions/bad',
      'sessions/s-cur',
      'sessions/s-other',
    ]);
    for (const text of [
      '用户档案已清空 (2 条)',
      '第三方行为指令已清空 (2 条)',
      '关系图已清空 (2 条)',
      '所有会话待办已清空（3 个会话）',
      '合并转发原文已清空（2 条）',
      '所有会话摘要已清空',
    ])
      expect(out).toContain(text);
    expect(infos.toSorted()).toEqual(
      [
        'summary/bad',
        'todo-list/bad',
        'onebot:forward/bad',
        'user:profile/bad',
        'aalis:instructions/bad',
        'user-relation/bad、user-relation-vec/bad',
      ]
        .map(named => `清理时一并删除了 ${named.split('、').length} 条读不出的数据：${named}`)
        .toSorted(),
    );
  });

  it('sqlite 后端：/profile clear nuke 连读不出的档案一并清掉，回执条数计入，记一条 info 点名', async () => {
    const db = new Database(':memory:');
    const logHub = new LogHub();
    const infos: string[] = [];
    logHub.onEntry(e => {
      if (e.level === 'info' && e.message.includes('读不出')) infos.push(e.message);
    });
    const { run, snapshot } = await world({ memory: new SQLiteMemoryService(db, { logger: { warn() {} } }), logHub });
    db.prepare("INSERT INTO metadata (namespace, key, data) VALUES ('user:profile', 'bad', '{not json')").run();

    expect(await run('profile.clear.nuke')).toBe('✅ 已清空全部用户档案（2 条）');

    const left = db.prepare("SELECT key FROM metadata WHERE namespace = 'user:profile'").all();
    expect(left).toEqual([]);
    expect((await snapshot()).namespaces, '只清用户档案').toEqual(without('user:profile'));
    expect(infos).toEqual(['清理时一并删除了 1 条读不出的数据：user:profile/bad']);
  });
});
