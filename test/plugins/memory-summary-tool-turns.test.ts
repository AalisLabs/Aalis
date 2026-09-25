import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { fakeSummaryLLM, setupSummary } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 摘要输入里的工具回合必须留痕：
//   - role='tool' 曾被整条丢掉（做了什么、查到什么全不可见）；
//   - 带 toolCalls 的 assistant 渲染成「助手: (空)」，等于告诉模型这一轮什么也没发生。
// 现在渲染成「调用 <工具名>(精简参数)」与「工具结果(名): …」，每条硬截断、名字优先；
// tool 结果的工具名按 toolCallId 从 assistant.toolCalls 反查（消息自带 name 只作回落）。
// generateSummary 与 session:compress 两条路径同款。
// ════════════════════════════════════════════════════════════

const LONG_RESULT = `晴${'气温二十六度'.repeat(60)}`; // 远超每条上限

const lastInput = { text: '' };
beforeEach(() => {
  lastInput.text = '';
});

/** 一个真实形状的工具回合：user 提问 → assistant(toolCalls, content 空) → tool 结果 → assistant 回答 */
async function seedToolTurn(store: MemoryService, sessionId: string, filler: number): Promise<void> {
  await store.saveMessage(sessionId, { role: 'user', content: '北京天气怎么样' });
  await store.saveMessage(sessionId, {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
  });
  // 自带 name 刻意写错：tool 消息的 name 是可选字段、由上游适配器回填，可能陈旧；
  // 工具名以同回合 assistant.toolCalls 按 toolCallId 反查为准，m.name 只作回落
  await store.saveMessage(sessionId, { role: 'tool', toolCallId: 'c1', name: 'stale_name', content: LONG_RESULT });
  await store.saveMessage(sessionId, { role: 'assistant', content: '北京今天晴' });
  for (let i = 0; i < filler; i++) {
    await store.saveMessage(sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: `填充 ${i}` });
  }
}

function assertToolTurnRendered(text: string): void {
  expect(text, '工具调用应以「调用 <工具名>(参数)」出现').toContain('调用 get_weather({"city":"北京"})');
  expect(text, 'tool 结果应放行').toContain('工具结果(get_weather): 晴');
  expect(text, '工具名以 toolCallId 映射为准，消息自带的陈旧 name 不得压过').not.toContain('stale_name');
  expect(text, '不得再出现「助手: (空)」').not.toContain('助手: (空)');
  // 每条硬截断：结果被截到上限并以省略号收尾，不把整条原文灌进摘要输入
  const line = text.split('\n').find(l => l.startsWith('工具结果(get_weather)')) ?? '';
  expect(line.length, `工具结果行应被硬截断，实际 ${line.length} 字`).toBeLessThan(240);
  expect(line.endsWith('…'), '超长结果应以省略号收尾').toBe(true);
}

describe('plugin-memory-summary: 工具回合进摘要输入', () => {
  it('generateSummary 路径：渲染工具调用与工具结果（每条硬截断）', async () => {
    const { app, host, memory } = await setupSummary({ threshold: 10, keepRecent: 4 }, fakeSummaryLLM(lastInput));
    await seedToolTurn(memory, 's-t0', 20);

    await host.hooks.run(
      'agent:turn:after' as never,
      { message: { sessionId: 's-t0' }, reply: 'ok', outcome: 'replied', sessionId: 's-t0', metadata: {} } as never,
    );
    await new Promise<void>(r => setTimeout(r, 50));

    assertToolTurnRendered(lastInput.text);
    await app.stop();
  });

  it('session:compress 路径：同款渲染', async () => {
    const { app, host, memory } = await setupSummary({ threshold: 10, keepRecent: 4 }, fakeSummaryLLM(lastInput));
    await seedToolTurn(memory, 's-t1', 20);

    await host.events.emit('session:compress', { sessionId: 's-t1', reason: 'manual' });
    await new Promise<void>(r => setTimeout(r, 50));

    assertToolTurnRendered(lastInput.text);
    await app.stop();
  });
});
