import { describe, expect, it } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { setupSummary } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// keepRecent=0 曾让"避免裁剪点落在 tool call 组中间"的循环索引越界
// （allHistory[allHistory.length - 0] → undefined.role → TypeError）：
// LLM 摘要已经花完，异常却被外层 catch 吞成一条 warn，历史一条不裁，
// 之后每轮都重摘全量历史。generateSummary 与 session:compress 两条同构。
// ════════════════════════════════════════════════════════════

async function seed(store: MemoryService, sessionId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.saveMessage(sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条消息` });
  }
}

describe('plugin-memory-summary: keepRecent=0 仍裁切', () => {
  it('generateSummary 路径：摘要落库且历史真被裁切（不再抛 TypeError 空转）', async () => {
    const { app, host, memory } = await setupSummary({ threshold: 10, keepRecent: 0 });
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
    const { app, host, memory } = await setupSummary({ threshold: 10, keepRecent: 0 });
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
