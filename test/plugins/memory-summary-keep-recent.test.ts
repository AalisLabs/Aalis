import { describe, expect, it } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import { LLMCapabilities, llm } from '../../packages/api-llm/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, events, hooks, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';

// ════════════════════════════════════════════════════════════
// keepRecent=0 曾让"避免裁剪点落在 tool call 组中间"的循环索引越界
// （allHistory[allHistory.length - 0] → undefined.role → TypeError）：
// LLM 摘要已经花完，异常却被外层 catch 吞成一条 warn，历史一条不裁，
// 之后每轮都重摘全量历史。generateSummary 与 session:compress 两条同构。
// ════════════════════════════════════════════════════════════

function fakeLLM(): LLMModel {
  return {
    id: 'fake',
    providerId: 'fake',
    contextLength: 8192,
    capabilities: [LLMCapabilities.Chat],
    async chat() {
      return { content: 'SUMMARY-TEXT' };
    },
  };
}

async function setup(config: Record<string, unknown>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide, services, events, hooks });
  await app.plugin(memoryInMemory);
  host.provide(llm, fakeLLM());
  await app.plugin(memorySummary, config);
  await app.plugins.idle();
  // 激活闸：required 依赖（memory / llm）缺席时插件停在 pending 且不报错，
  // 下面的"没裁切/没摘要"断言会在「插件根本没跑」的情况下变成恒假而非恒真——
  // 但摘要落库那条会红得莫名其妙，故在此显式点名。
  if (app.plugins.getPlugin('@aalis/plugin-memory-summary')?.state !== 'active')
    throw new Error('plugin-memory-summary 未激活');
  const store = host.services.get(memory);
  if (!store) throw new Error('memory 服务未就绪');
  return { app, host, memory: store };
}

async function seed(store: MemoryService, sessionId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.saveMessage(sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条消息` });
  }
}

describe('plugin-memory-summary: keepRecent=0 仍裁切', () => {
  it('generateSummary 路径：摘要落库且历史真被裁切（不再抛 TypeError 空转）', async () => {
    const { app, host, memory } = await setup({ threshold: 10, keepRecent: 0 });
    await seed(memory, 's-k0', 30);

    await host.hooks.run(
      'agent:turn:after' as never,
      { message: { sessionId: 's-k0' }, reply: 'ok', outcome: 'replied', sessionId: 's-k0', metadata: {} } as never,
    );
    await new Promise<void>(r => setTimeout(r, 50));

    expect((await memory.getMetadata('summary', 's-k0'))?.summary, '摘要应落库').toBe('SUMMARY-TEXT');
    const after = await memory.getHistory('s-k0', 1000);
    expect(after.length, `keepRecent=0 也必须裁切，实际剩 ${after.length} 条`).toBeLessThanOrEqual(2);
    await app.stop();
  });

  it('session:compress 路径：同构代码同样不再空转', async () => {
    const { app, host, memory } = await setup({ threshold: 10, keepRecent: 0 });
    await seed(memory, 's-k1', 30);

    const statuses: string[] = [];
    host.events.on('session:compressing', info => {
      if (info.sessionId === 's-k1') statuses.push(info.status);
    });
    await host.events.emit('session:compress', { sessionId: 's-k1', reason: 'manual' });
    await new Promise<void>(r => setTimeout(r, 50));

    const after = await memory.getHistory('s-k1', 1000);
    expect(after.length, `keepRecent=0 也必须裁切，实际剩 ${after.length} 条`).toBeLessThanOrEqual(2);
    expect(statuses[statuses.length - 1], '成功路径应报 done').toBe('done');
    await app.stop();
  });
});
