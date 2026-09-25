import { describe, expect, it } from 'vitest';
import { WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';
import { fakeSummaryLLM, setupSummary } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 摘要输入里的 assistant 行取可见正文：回复经结构化输出时 content 存整串 JSON 信封，
// agent 把解码后的回复写进 metadata 的 VisibleContent 键。摘要曾直接读 content，
// 信封里的键骨架与状态字段进了摘要输入，而不是用户实际看到的那句话。
// ════════════════════════════════════════════════════════════

describe('plugin-memory-summary: assistant 行取可见正文', () => {
  it('带 VisibleContent 的回复渲染解码后的正文，不带的照旧用 content', async () => {
    const lastInput = { text: '' };
    const { app, host, memory } = await setupSummary({ threshold: 10, keepRecent: 4 }, fakeSummaryLLM(lastInput));
    const sessionId = 's-visible';
    await memory.saveMessage(sessionId, { role: 'user', content: '北京天气怎么样' });
    await memory.saveMessage(sessionId, {
      role: 'assistant',
      content: JSON.stringify({ reply: '北京今天晴', mood: '状态字段-开心' }),
      metadata: { [WellKnownMetadataKeys.VisibleContent]: '北京今天晴' },
    });
    await memory.saveMessage(sessionId, { role: 'assistant', content: '没有信封的普通回复' });
    for (let i = 0; i < 20; i++) {
      await memory.saveMessage(sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: `填充 ${i}` });
    }

    await host.hooks.run(
      'agent:turn:after' as never,
      { message: { sessionId }, reply: 'ok', outcome: 'replied', sessionId, metadata: {} } as never,
    );
    await new Promise<void>(r => setTimeout(r, 50));

    expect(lastInput.text, '摘要请求应已发出').toContain('用户: 北京天气怎么样');
    expect(lastInput.text).toContain('助手: 北京今天晴');
    expect(lastInput.text, '信封里的状态字段不得进摘要输入').not.toContain('状态字段-开心');
    expect(lastInput.text).toContain('助手: 没有信封的普通回复');
    await app.stop();
  });
});
