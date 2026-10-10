import { afterEach, describe, expect, it, vi } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import { LLMCapabilities, llm } from '../../packages/api-llm/src/index.js';
import { compression, type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { endTurn } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 一次摘要只认开头取到的 memory 实例。
//
// 读历史 → 调 LLM（数十秒到 120 秒）→ 核对 → 写摘要 → 归档（失败则回滚摘要），中间 memory 胜者
// 可能换人，本插件不重启。摘要若每步现取胜者，就会从 A 读历史、在 A 上归档，摘要却写进 B；
// 归档失败时的回滚也落到 B，把 A 的旧摘要盖在 B 上。
// ════════════════════════════════════════════════════════════

const SESSION = 's-1';

/** 挂起的 LLM：chat 被调用时通知测试，直到测试放行才返回摘要 */
function gatedLLM() {
  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  let called!: () => void;
  const calledOnce = new Promise<void>(r => {
    called = r;
  });
  const model: LLMModel = {
    id: 'gated',
    providerId: 'gated',
    contextLength: 8192,
    capabilities: [LLMCapabilities.Chat],
    async chat() {
      called();
      await gate;
      return { content: 'SUMMARY-FROM-A' };
    },
  };
  return { model, release, calledOnce };
}

class StubMemory {
  readonly metadata = new Map<string, Record<string, unknown>>();
  archiveCalls = 0;
  constructor(
    readonly history: Message[] = [],
    private readonly archiveError?: Error,
  ) {}

  async saveMessage(_sessionId: string, message: Message): Promise<void> {
    this.history.push(message);
  }
  async getHistory(): Promise<Message[]> {
    return [...this.history];
  }
  async clearSession(): Promise<void> {}
  async archiveOldest(_sessionId: string, count: number): Promise<number> {
    this.archiveCalls++;
    if (this.archiveError) throw this.archiveError;
    return this.history.splice(0, count).length;
  }
  async saveMetadata(ns: string, key: string, data: Record<string, unknown>): Promise<void> {
    this.metadata.set(`${ns}/${key}`, data);
  }
  async getMetadata(ns: string, key: string): Promise<Record<string, unknown> | undefined> {
    return this.metadata.get(`${ns}/${key}`);
  }
  async deleteMetadata(ns: string, key: string): Promise<void> {
    this.metadata.delete(`${ns}/${key}`);
  }
  async listMetadata(): Promise<never[]> {
    return [];
  }
  async commitMetadata(): Promise<void> {}

  summary(): unknown {
    return this.metadata.get(`summary/${SESSION}`)?.summary;
  }
}

function seedHistory(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `第 ${i} 条消息`,
  }));
}

const apps: App[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

async function setup(first: StubMemory, model: LLMModel) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, compression });
  host.provide.use(memory, first as unknown as MemoryService);
  host.provide.use(llm, model);
  await app.plugin(memorySummary);
  await app.plugins.idle();
  if (app.plugins.getPlugin(memorySummary.name)?.state !== 'active') throw new Error('plugin-memory-summary 未激活');
  return { app, host };
}
type Booted = Awaited<ReturnType<typeof setup>>;

/** LLM 挂起期间让更高优先级的 B 上线成为胜者，再放行 */
async function switchWinnerMidway({ app, host }: Booted, gated: ReturnType<typeof gatedLLM>, second: StubMemory) {
  await gated.calledOnce;
  host.provide.use(memory, second as unknown as MemoryService, { priority: 10, entryId: 'memory-b' });
  await app.plugins.idle();
  gated.release();
}

/** 等这次操作走完：归档之后只剩回滚这几步微任务，一拍宏任务足够落定 */
async function settle(first: StubMemory, pending: Promise<unknown>): Promise<void> {
  await pending;
  await vi.waitFor(() => expect(first.archiveCalls).toBe(1));
  await new Promise<void>(r => setTimeout(r, 20));
}

/** 两个入口：回合结束时用量到线的后台压缩（不阻塞钩子）与手动压缩（归档失败时以失败落定，这里只看写在哪） */
const paths: Array<[string, (host: Booted['host']) => Promise<unknown>]> = [
  ['后台压缩', host => endTurn(host, SESSION, { used: 900, compressible: 500 })],
  ['手动压缩', host => host.compression.use.compress(SESSION, { reason: 'manual' }).catch(() => {})],
];

describe.each(paths)('plugin-memory-summary %s：一次操作只认开头取到的 memory 实例', (_name, trigger) => {
  it('LLM 挂起期间换胜者：摘要写在读历史、归档的同一个 A 上，B 无摘要', async () => {
    const gated = gatedLLM();
    const first = new StubMemory(seedHistory(40));
    const second = new StubMemory();
    const booted = await setup(first, gated.model);

    const pending = trigger(booted.host);
    await switchWinnerMidway(booted, gated, second);
    await settle(first, pending);

    expect(first.history, 'A 上的历史应全部归档').toHaveLength(0);
    expect(first.summary(), '摘要应写在 A').toBe('SUMMARY-FROM-A');
    expect(second.summary(), 'B 不得出现摘要').toBeUndefined();
    expect(second.archiveCalls).toBe(0);
  });

  it('归档失败：摘要回滚在 A 上，B 原有摘要不被覆盖', async () => {
    const gated = gatedLLM();
    const first = new StubMemory(seedHistory(40), new Error('SQLITE_BUSY'));
    first.metadata.set(`summary/${SESSION}`, { summary: 'A-OLD' });
    const second = new StubMemory();
    second.metadata.set(`summary/${SESSION}`, { summary: 'B-OLD' });
    const booted = await setup(first, gated.model);

    const pending = trigger(booted.host);
    await switchWinnerMidway(booted, gated, second);
    await settle(first, pending);

    expect(first.summary(), 'A 的摘要应回滚到落库前').toBe('A-OLD');
    expect(second.summary(), 'B 原有摘要不得被改写').toBe('B-OLD');
  });
});
