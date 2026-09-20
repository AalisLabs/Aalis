import { describe, expect, it } from 'vitest';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type VectorSearchResult, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';

// ════════════════════════════════════════════════════════════
// memory_recall 的 scope 只能收紧、不能放宽（工具描述里的承诺）。
// crossSessionMode='user' 是「全库可见 + 同用户加权」的加权策略，曾与 scope
// 共用一张 rank 表并排在 platform 之前 → 显式请求 platform 被静默放宽回 all。
// ════════════════════════════════════════════════════════════

const BASE_TS = Date.UTC(2026, 0, 1, 12, 0, 0);

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<string>;

function hits(): VectorSearchResult[] {
  return [
    {
      score: 0.95,
      metadata: { sessionId: 'onebot:g1', platform: 'onebot', timestamp: BASE_TS, content: '同平台记忆' },
    },
    {
      score: 0.9,
      metadata: { sessionId: 'discord:g9', platform: 'discord', timestamp: BASE_TS + 1, content: '外平台记忆' },
    },
  ];
}

async function setup(crossSessionMode: string) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  const host = app.bind({ provide });
  host.provide(embedding, {
    async embed(): Promise<number[]> {
      return [0.1, 0.2, 0.3];
    },
  });
  const all = hits();
  host.provide(vectorstore, {
    async add(): Promise<void> {},
    async search(_q: number[], topK: number): Promise<VectorSearchResult[]> {
      return all.slice(0, topK);
    },
    async size(): Promise<number> {
      return all.length;
    },
    async clear(): Promise<void> {},
    async save(): Promise<void> {},
  });
  const toolHandlers = new Map<string, ToolHandler>();
  host.provide(tools, {
    register: (tool: { definition: { function: { name: string } }; handler: ToolHandler }) => {
      toolHandlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugins.register(memoryVector, {
    search: { topK: 5, timeWeight: 0, userPriorityBoost: 1, perItemMaxChars: 0, minScore: 0 },
    contextExpand: { window: 0, crossSession: true },
    indexing: { concurrency: 1, maxQueueSize: 10 },
    crossSessionMode,
    recallRoles: 'all',
  });
  await app.plugins.idle();
  return { app, recall: toolHandlers.get('memory_recall')! };
}

async function recallTexts(recall: ToolHandler, scope?: string) {
  const out = JSON.parse(await recall({ query: '记忆', ...(scope ? { scope } : {}) }, { sessionId: 'onebot:g1' }));
  return (out.results ?? []).map((r: { text: string }) => r.text).join('\n');
}

describe('plugin-memory-vector: memory_recall scope 收紧', () => {
  it("crossSessionMode='user' + 请求 scope='platform'：外平台命中被剔除（收紧不被忽略）", async () => {
    const { app, recall } = await setup('user');
    const texts = await recallTexts(recall, 'platform');
    expect(texts).toContain('同平台记忆');
    expect(texts).not.toContain('外平台记忆');
    await app.stop();
  });

  it("crossSessionMode='user' 不传 scope：保持全库可见（user 的可见范围等同 all）", async () => {
    const { app, recall } = await setup('user');
    const texts = await recallTexts(recall);
    expect(texts).toContain('同平台记忆');
    expect(texts).toContain('外平台记忆');
    await app.stop();
  });

  it("crossSessionMode='platform' + 请求 scope='all'：不得放宽，外平台仍被剔除", async () => {
    const { app, recall } = await setup('platform');
    const texts = await recallTexts(recall, 'all');
    expect(texts).toContain('同平台记忆');
    expect(texts).not.toContain('外平台记忆');
    await app.stop();
  });
});
