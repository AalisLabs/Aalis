import { describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type EmbeddingService, embedding } from '../../packages/api-embedding/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import {
  type VectorSearchResult,
  type VectorStoreService,
  vectorstore,
} from '../../packages/api-vectorstore/src/index.js';
import { App, logger, provide } from '../../packages/core/src/index.js';
import {
  assemblePromptContributions,
  type PromptAssemblyCaps,
} from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// memory 是 memory-vector 的 optional 依赖，provider 重载不级联 bounce 本插件。
// apply 时缓存裸引用 + 快照 hasRangeQuery 会让扩窗：
//   1. provider 晚于本插件注册时永久判为「不支持范围查询」；
//   2. provider bounce 后仍读已失效的旧实例。
// 这里把两种形态都钉成常驻用例（复核者的探针）。
// ════════════════════════════════════════════════════════════

const BASE_TS = Date.UTC(2026, 0, 1, 12, 0, 0);
const FIXED_VEC = [0.1, 0.2, 0.3];

function makeEmbedder(): EmbeddingService {
  return {
    async embed(): Promise<number[]> {
      return FIXED_VEC;
    },
  };
}

function makeStore(hits: VectorSearchResult[]): VectorStoreService {
  return {
    async add(): Promise<void> {},
    async search(_q: number[], topK: number): Promise<VectorSearchResult[]> {
      return hits.slice(0, topK);
    },
    async size(): Promise<number> {
      return hits.length;
    },
    async clear(): Promise<void> {},
    async save(): Promise<void> {},
  };
}

/** 只实现扩窗要用的 getMessagesBySessionRange 的假 memory */
function makeRangeMemory(messages: Message[]): MemoryService {
  return {
    async getMessagesBySessionRange(_sid: string, from: number, to: number): Promise<Message[]> {
      return messages.filter(m => (m.timestamp ?? 0) >= from && (m.timestamp ?? 0) <= to);
    },
  } as unknown as MemoryService;
}

async function setup(opts: { memory?: MemoryService } = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  // 宿主侧的根绑定：既用来摆桩服务，也是下面组装 agent:prompt 贡献要的那两样能力
  const host = app.bind({ provide, contributions, logger });
  host.provide(embedding, makeEmbedder());
  const memoryHandle = opts.memory ? host.provide(memory, opts.memory) : undefined;
  host.provide(
    vectorstore,
    makeStore([{ score: 0.9, metadata: { sessionId: 's-old', timestamp: BASE_TS, content: '命中本身' } }]),
  );
  host.provide(tools, { register: () => () => {}, registerGroup: () => () => {} } as never);
  await app.plugin(memoryVector, {
    search: { topK: 5, timeWeight: 0, userPriorityBoost: 1, perItemMaxChars: 0, minScore: 0 },
    contextExpand: { window: 2, crossSession: true },
    indexing: { concurrency: 1, maxQueueSize: 10 },
    crossSessionMode: 'all',
    recallRoles: 'all',
  });
  await app.plugins.idle();
  return { app, host, memoryHandle };
}

function baseMessages(): Message[] {
  return [
    { role: 'system', content: '人设' },
    { role: 'user', content: '还记得我上次说的吗' },
  ];
}

async function injectedText(caps: PromptAssemblyCaps): Promise<string> {
  const messages = baseMessages();
  await assemblePromptContributions(caps, { messages, sessionId: 's-cur' });
  const block = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-vector'));
  return String(block?.content ?? '');
}

describe('plugin-memory-vector: memory 惰查', () => {
  it('memory provider 晚于本插件注册：扩窗立即可用（能力在调用点现算）', async () => {
    const { app, host } = await setup();
    host.provide(
      memory,
      makeRangeMemory([
        { role: 'user', content: '命中本身', timestamp: BASE_TS },
        { role: 'user', content: '后注册的邻居', timestamp: BASE_TS + 1000 },
      ]),
    );

    expect(await injectedText(host)).toContain('后注册的邻居');
    await app.stop();
  });

  it('memory provider 换实例（bounce）后：扩窗读新实例，不落在已失效的旧引用上', async () => {
    // 旧 provider 在 apply 时就在场（apply 期快照会正好命中它）
    const { app, host, memoryHandle } = await setup({
      memory: makeRangeMemory([
        { role: 'user', content: '命中本身', timestamp: BASE_TS },
        { role: 'user', content: '旧实例的邻居', timestamp: BASE_TS + 1000 },
      ]),
    });
    expect(await injectedText(host)).toContain('旧实例的邻居');

    // bounce：撤掉旧 provider，换上新实例
    memoryHandle?.();
    await new Promise(r => setTimeout(r, 0));
    host.provide(
      memory,
      makeRangeMemory([
        { role: 'user', content: '命中本身', timestamp: BASE_TS },
        { role: 'user', content: '新实例的邻居', timestamp: BASE_TS + 1000 },
      ]),
    );
    await new Promise(r => setTimeout(r, 0));

    const text = await injectedText(host);
    expect(text).toContain('新实例的邻居');
    expect(text).not.toContain('旧实例的邻居');
    await app.stop();
  });
});
