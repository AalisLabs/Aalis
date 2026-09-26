import { describe, expect, it } from 'vitest';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// memory_recall 把回合的中止信号传给 embedding。用户停止或 latest-wins 腰斩时模型恰好在调它，
// 中止不是检索故障：不记「memory_recall 失败」的 warn（被动注入路径同样静默），其它失败照旧告警。

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<string>;

async function setup() {
  const warns: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error: () => {},
    child: () => logger,
  } as unknown as Logger;
  const app = new App({ name: 'T', logger });
  await registerHubs(app);
  const host = app.bind({ provide });
  host.provide(embedding, {
    async embed(_text: string, opts?: { signal?: AbortSignal }): Promise<number[]> {
      opts?.signal?.throwIfAborted();
      throw new Error('embedding 服务故障');
    },
  });
  host.provide(vectorstore, {
    async add(): Promise<void> {},
    async search() {
      return [];
    },
    async size(): Promise<number> {
      return 1;
    },
    async clear(): Promise<void> {},
    async save(): Promise<void> {},
  });
  const handlers = new Map<string, ToolHandler>();
  host.provide(tools, {
    register: (tool: { definition: { function: { name: string } }; handler: ToolHandler }) => {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugins.register(memoryVector, {
    search: { topK: 5, timeWeight: 0, userPriorityBoost: 1, perItemMaxChars: 0, minScore: 0 },
    contextExpand: { window: 0, crossSession: true },
    indexing: { concurrency: 1, maxQueueSize: 10 },
  });
  await app.plugins.idle();
  const recall = handlers.get('memory_recall');
  if (!recall) throw new Error('memory_recall 未注册');
  const recallWarns = () => warns.filter(w => w.includes('memory_recall 失败'));
  return { app, recall, recallWarns };
}

describe('plugin-memory-vector: memory_recall 遇回合中止', () => {
  it('中止：返回「回合已中止」，不记检索失败的 warn', async () => {
    const { app, recall, recallWarns } = await setup();
    const abort = new AbortController();
    abort.abort();
    const out = JSON.parse(await recall({ query: '上次' }, { sessionId: 'webui:s1', signal: abort.signal }));
    expect(out).toEqual({ error: '回合已中止' });
    expect(recallWarns()).toEqual([]);
    await app.stop();
  });

  it('未中止的失败照旧告警并如实返回原因', async () => {
    const { app, recall, recallWarns } = await setup();
    const out = JSON.parse(
      await recall({ query: '上次' }, { sessionId: 'webui:s1', signal: new AbortController().signal }),
    );
    expect(out).toEqual({ error: '检索失败: embedding 服务故障' });
    expect(recallWarns()).toHaveLength(1);
    await app.stop();
  });
});
