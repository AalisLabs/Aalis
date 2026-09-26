import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type EmbeddingService, embedding } from '../../packages/api-embedding/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import {
  type VectorSearchResult,
  type VectorStoreService,
  vectorstore,
} from '../../packages/api-vectorstore/src/index.js';
import { App, events, LogHub, logger, provide } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 向量只能与同一 embedding 模型算出的向量比较。换成同维度的另一模型后，
// 新旧向量混在一起检索，召回悄悄变差。memory-vector 写入时记下提供者的
// modelId，检索时只留同模型的向量；本版之前的存量向量不带 modelId，
// 按记忆元数据里的存量标记（memory-vector / legacy-model）认定模型。
// ════════════════════════════════════════════════════════════

const BASE_TS = Date.UTC(2026, 0, 1, 12, 0, 0);
const FIXED_VEC = [0.1, 0.2, 0.3];
const MARKER = 'memory-vector|legacy-model';

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<string>;

function makeEmbedder(modelId: string | undefined): EmbeddingService {
  return {
    ...(modelId ? { modelId } : {}),
    async embed(): Promise<number[]> {
      return FIXED_VEC;
    },
  };
}

function hit(content: string, modelId?: string, offset = 0): VectorSearchResult {
  return {
    score: 0.9,
    metadata: { sessionId: 's-old', timestamp: BASE_TS + offset, content, ...(modelId ? { modelId } : {}) },
  };
}

/**
 * 只实现元数据读写与 clearAll 的记忆替身；clearAll 与真实后端一样连元数据一起删。
 * `readFailures` 次读取先抛错，`saveFails` 时写入一律抛错
 */
function makeMetaMemory(
  opts: { seed?: Record<string, Record<string, unknown>>; readFailures?: number; saveFails?: boolean } = {},
) {
  const meta = new Map(Object.entries(opts.seed ?? {}));
  const calls = { get: 0, save: 0 };
  let failuresLeft = opts.readFailures ?? 0;
  const service = {
    async getMetadata(namespace: string, key: string): Promise<Record<string, unknown> | undefined> {
      calls.get++;
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error('元数据读取失败');
      }
      return meta.get(`${namespace}|${key}`);
    },
    async saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void> {
      calls.save++;
      if (opts.saveFails) throw new Error('元数据写入失败');
      meta.set(`${namespace}|${key}`, data);
    },
    async clearAll(): Promise<void> {
      meta.clear();
    },
  } as unknown as MemoryService;
  return { service, meta, calls };
}

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(opts: { modelId?: string; hits?: VectorSearchResult[]; memory?: MemoryService }) {
  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(e => {
    if (e.level === 'warn') warns.push(e.message);
  });
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, contributions, logger, hooks });
  host.provide(embedding, makeEmbedder(opts.modelId));
  if (opts.memory) host.provide(memory, opts.memory);

  const hits = opts.hits ?? [];
  const added: Array<Record<string, unknown>> = [];
  const store: VectorStoreService = {
    async add(_vector: number[], metadata: Record<string, unknown>): Promise<void> {
      added.push(metadata);
    },
    async search(_q: number[], topK: number): Promise<VectorSearchResult[]> {
      return hits.slice(0, topK);
    },
    async size(): Promise<number> {
      return hits.length;
    },
    async clear(): Promise<void> {},
    async save(): Promise<void> {},
  };
  host.provide(vectorstore, store);

  const toolHandlers = new Map<string, ToolHandler>();
  host.provide(tools, {
    register: (tool: { definition: { function: { name: string } }; handler: ToolHandler }) => {
      toolHandlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);

  await app.plugin(memoryVector, {
    search: { topK: 5, timeWeight: 0, userPriorityBoost: 1, perItemMaxChars: 0, minScore: 0 },
    contextExpand: { window: 0, crossSession: true },
    indexing: { concurrency: 1, maxQueueSize: 10 },
    crossSessionMode: 'all',
    recallRoles: 'all',
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin('@aalis/plugin-memory-vector')?.state !== 'active')
    throw new Error('plugin-memory-vector 未激活');

  /** 被动注入的检索块正文 */
  async function injected(): Promise<string> {
    const messages: Message[] = [
      { role: 'system', content: '人设' },
      { role: 'user', content: '还记得我上次说的吗' },
    ];
    await assemblePromptContributions(host, { messages, sessionId: 's-cur' });
    const block = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-vector'));
    return String(block?.content ?? '');
  }

  /** memory_recall 返回的命中文本 */
  async function recalled(): Promise<string> {
    const out = JSON.parse(await toolHandlers.get('memory_recall')!({ query: '记忆' }, { sessionId: 's-cur' }));
    return (out.results ?? []).map((r: { text: string }) => r.text).join('\n');
  }

  return { app, host, added, warns, injected, recalled };
}

/** 照 /clear 的调度驱动 memory:clear：默认动作在全部中间件放行后执行，全局且含 context 时调 clearAll */
async function runClear(
  host: Awaited<ReturnType<typeof setup>>['host'],
  mem: MemoryService,
  scope: 'session' | 'all',
  types?: string[],
) {
  const data: HookContextMap['memory:clear'] = { scope, types, sessionId: 's-cur', results: [] };
  const completed = await host.hooks.run('memory:clear', data, async () => {
    if (scope === 'all' && (!types || types.includes('context'))) {
      await mem.clearAll!();
      data.results.push({ source: 'memory', success: true, message: '所有消息历史和归档已清空' });
    }
  });
  return { completed, results: data.results };
}

describe('plugin-memory-vector: embedding 模型标识', () => {
  it('索引：新写入的 user 与 assistant 向量都带提供者的 modelId；提供者未声明时不带该键', async () => {
    for (const modelId of ['test:A', undefined]) {
      const { host, added } = await setup({ modelId });
      const emitLoose = host.events.emit.bind(host.events) as (event: string, data: unknown) => Promise<void>;
      await emitLoose('inbound:message:archived', {
        sessionId: 's1',
        incoming: { content: '对方的话', sessionId: 's1', platform: 'onebot', userId: 'u1' },
        archivedMessage: { role: 'user', content: '对方的话', timestamp: BASE_TS },
      });
      await emitLoose('assistant:message:archived', {
        sessionId: 's1',
        message: { role: 'assistant', content: '我自己的回复', timestamp: BASE_TS + 1 },
      });
      for (let i = 0; i < 50 && added.length < 2; i++) await new Promise(r => setTimeout(r, 20));
      expect(added.map(m => m.role)).toEqual(['user', 'assistant']);
      if (modelId) {
        expect(added.map(m => m.modelId)).toEqual([modelId, modelId]);
      } else {
        expect(added.some(m => 'modelId' in m)).toBe(false);
      }
    }
  });

  it('首次运行：无存量标记时记下当前模型，存量向量在模型未变时照常召回', async () => {
    const mem = makeMetaMemory();
    const { injected, recalled, warns } = await setup({
      modelId: 'test:A',
      memory: mem.service,
      hits: [hit('存量记忆'), hit('新记忆', 'test:A', 1)],
    });

    const block = await injected();
    expect(block).toContain('存量记忆');
    expect(block).toContain('新记忆');
    expect(mem.meta.get(MARKER)).toEqual({ modelId: 'test:A' });

    const texts = await recalled();
    expect(texts).toContain('存量记忆');
    expect(texts).toContain('新记忆');
    expect(mem.calls.save, '标记只写一次，写入后缓存').toBe(1);
    expect(warns).toEqual([]);
  });

  it('换模型：存量向量与其它模型的向量都不再召回，同模型向量照常召回；告警恰好一次', async () => {
    const mem = makeMetaMemory({ seed: { [MARKER]: { modelId: 'test:A' } } });
    const { injected, recalled, warns } = await setup({
      modelId: 'test:B',
      memory: mem.service,
      hits: [
        hit('存量记忆'),
        hit('旧模型记忆', 'test:A', 1),
        hit('第三模型记忆', 'test:C', 2),
        hit('新模型记忆', 'test:B', 3),
      ],
    });

    for (const text of [await injected(), await recalled(), await injected()]) {
      expect(text).toContain('新模型记忆');
      expect(text).not.toContain('存量记忆');
      expect(text).not.toContain('旧模型记忆');
      expect(text).not.toContain('第三模型记忆');
    }
    expect(mem.meta.get(MARKER), '已有标记不被当前模型覆盖').toEqual({ modelId: 'test:A' });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('test:B');
    expect(warns[0]).toContain('test:A');
    expect(warns[0]).toContain('test:C');
    expect(warns[0]).toContain('清空向量库');
  });

  it('标记读取抛错：不写标记，存量向量照常召回；每次检索都重试读取，连续失败只告警一次', async () => {
    const mem = makeMetaMemory({ seed: { [MARKER]: { modelId: 'test:A' } }, readFailures: 2 });
    const { injected, warns } = await setup({
      modelId: 'test:B',
      memory: mem.service,
      hits: [hit('存量记忆'), hit('新模型记忆', 'test:B', 1)],
    });

    for (const text of [await injected(), await injected()]) {
      expect(text).toContain('存量记忆');
      expect(text).toContain('新模型记忆');
    }
    expect(mem.calls.get, '每次检索都重试读取').toBe(2);
    expect(mem.calls.save).toBe(0);
    expect(warns, '同一段连续失败只告警一次').toHaveLength(1);
    expect(warns[0]).toContain('模型标记');

    // 读取恢复后采用标记：存量向量出自 test:A，与当前 test:B 不可比较
    const third = await injected();
    expect(mem.calls.get).toBe(3);
    expect(third).toContain('新模型记忆');
    expect(third).not.toContain('存量记忆');
  });

  it('运行中途换提供者：两条检索路径都按新提供者的 modelId 过滤；换到的模型再告警一次', async () => {
    const mem = makeMetaMemory({ seed: { [MARKER]: { modelId: 'test:A' } } });
    const { host, injected, recalled, warns } = await setup({
      modelId: 'test:B',
      memory: mem.service,
      hits: [hit('存量记忆'), hit('乙模型记忆', 'test:B', 1), hit('丙模型记忆', 'test:C', 2)],
    });

    for (const text of [await injected(), await recalled()]) {
      expect(text).toContain('乙模型记忆');
      expect(text).not.toContain('丙模型记忆');
    }
    expect(warns).toHaveLength(1);

    // 更高优先级的提供者接手，之后算查询向量的是 test:C。
    // 同一上下文有意再登记一个提供者，显式 entryId 免去重复 provide 的告警
    host.provide(embedding, makeEmbedder('test:C'), { priority: 10, entryId: 'root/zz-embed-c' });
    for (const text of [await injected(), await recalled(), await injected()]) {
      expect(text).toContain('丙模型记忆');
      expect(text).not.toContain('乙模型记忆');
      expect(text).not.toContain('存量记忆');
    }
    expect(warns, '告警按当前模型去重：换到 test:C 再告警一次，之后不重复').toHaveLength(2);
    expect(warns[1]).toContain('test:C');
    expect(warns[1]).toContain('test:B');
  });

  it('memory 不在：存量向量照常召回（与改前相同）；memory 晚到后在调用点采用其中的标记', async () => {
    const { host, injected, warns } = await setup({
      modelId: 'test:B',
      hits: [hit('存量记忆'), hit('新模型记忆', 'test:B', 1)],
    });

    const before = await injected();
    expect(before).toContain('存量记忆');
    expect(before).toContain('新模型记忆');
    expect(warns).toEqual([]);

    const mem = makeMetaMemory({ seed: { [MARKER]: { modelId: 'test:A' } } });
    host.provide(memory, mem.service);
    const after = await injected();
    expect(after).toContain('新模型记忆');
    expect(after).not.toContain('存量记忆');
  });

  it('提供者未声明 modelId：不按模型过滤，也不读写存量标记', async () => {
    const mem = makeMetaMemory({ seed: { [MARKER]: { modelId: 'test:A' } } });
    const { injected, warns } = await setup({
      memory: mem.service,
      hits: [hit('存量记忆'), hit('甲模型记忆', 'test:A', 1), hit('乙模型记忆', 'test:B', 2)],
    });

    const block = await injected();
    expect(block).toContain('存量记忆');
    expect(block).toContain('甲模型记忆');
    expect(block).toContain('乙模型记忆');
    expect(mem.calls).toEqual({ get: 0, save: 0 });
    expect(warns).toEqual([]);
  });

  it('只全局清空消息历史：clearAll 删掉的存量标记原样写回，重启后存量向量仍按原模型排除', async () => {
    const mem = makeMetaMemory({ seed: { [MARKER]: { modelId: 'test:A' } } });
    const hits = [hit('存量记忆'), hit('新模型记忆', 'test:B', 1)];
    const first = await setup({ modelId: 'test:B', memory: mem.service, hits });

    const { completed, results } = await runClear(first.host, mem.service, 'all', ['context']);
    expect(completed).toBe(true);
    expect(results.map(r => r.source)).toEqual(['memory']);
    expect(mem.meta.get(MARKER), '标记在清空后写回').toEqual({ modelId: 'test:A' });
    expect(first.warns).toEqual([]);

    // 重启：新运行不带缓存，按记忆元数据里的标记认定存量向量
    await first.app.stop();
    const second = await setup({ modelId: 'test:B', memory: mem.service, hits });
    const block = await second.injected();
    expect(block).toContain('新模型记忆');
    expect(block).not.toContain('存量记忆');
    expect(mem.meta.get(MARKER)).toEqual({ modelId: 'test:A' });
  });

  it('连向量库一起清、只清会话、提供者未声明 modelId：清空前后都不读写存量标记', async () => {
    const cases: Array<{ modelId?: string; scope: 'session' | 'all'; types?: string[] }> = [
      { modelId: 'test:B', scope: 'all', types: ['context', 'vector'] },
      { modelId: 'test:B', scope: 'all' },
      { modelId: 'test:B', scope: 'session', types: ['context'] },
      { scope: 'all', types: ['context'] },
    ];
    for (const c of cases) {
      const mem = makeMetaMemory({ seed: { [MARKER]: { modelId: 'test:A' } } });
      const { host } = await setup({ modelId: c.modelId, memory: mem.service });
      await runClear(host, mem.service, c.scope, c.types);
      expect(mem.calls, JSON.stringify(c)).toEqual({ get: 0, save: 0 });
      if (c.scope === 'all') expect(mem.meta.has(MARKER), JSON.stringify(c)).toBe(false);
    }
  });

  it('标记写回失败：只记一条 warn，清空照常完成', async () => {
    const mem = makeMetaMemory({ seed: { [MARKER]: { modelId: 'test:A' } }, saveFails: true });
    const { host, warns } = await setup({ modelId: 'test:B', memory: mem.service });

    const { completed, results } = await runClear(host, mem.service, 'all', ['context']);
    expect(completed).toBe(true);
    expect(results).toEqual([{ source: 'memory', success: true, message: '所有消息历史和归档已清空' }]);
    expect(mem.calls.save).toBe(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('写回存量向量的模型标记失败');
  });
});
