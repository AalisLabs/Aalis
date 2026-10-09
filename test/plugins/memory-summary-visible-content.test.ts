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
    const llm = fakeSummaryLLM();
    const { app, memory, compression } = await setupSummary({}, llm.model);
    const sessionId = 's-visible';
    await memory.saveMessage(sessionId, { role: 'user', content: '北京天气怎么样' });
    await memory.saveMessage(sessionId, {
      role: 'assistant',
      content: JSON.stringify({ reply: '北京今天晴', mood: '状态字段-开心' }),
      metadata: { [WellKnownMetadataKeys.VisibleContent]: '北京今天晴' },
    });
    await memory.saveMessage(sessionId, { role: 'assistant', content: '没有信封的普通回复' });

    await compression.compress(sessionId, { reason: 'manual' });

    expect(llm.text(), '摘要请求应已发出').toContain('用户: 北京天气怎么样');
    expect(llm.text()).toContain('助手: 北京今天晴');
    expect(llm.text(), '信封里的状态字段不得进摘要输入').not.toContain('状态字段-开心');
    expect(llm.text()).toContain('助手: 没有信封的普通回复');
    await app.stop();
  });

  it('带 toolCalls 的 assistant 行：前言同样取可见正文', async () => {
    const llm = fakeSummaryLLM();
    const { app, memory, compression } = await setupSummary({}, llm.model);
    const sessionId = 's-visible-tool';
    await memory.saveMessage(sessionId, { role: 'user', content: '北京天气怎么样' });
    await memory.saveMessage(sessionId, {
      role: 'assistant',
      content: JSON.stringify({ reply: '先查一下', mood: '状态字段-专注' }),
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
      metadata: { [WellKnownMetadataKeys.VisibleContent]: '先查一下' },
    });
    await memory.saveMessage(sessionId, { role: 'tool', toolCallId: 'c1', content: '晴' });

    await compression.compress(sessionId, { reason: 'manual' });

    expect(llm.text()).toContain('助手: 先查一下 调用 get_weather(');
    expect(llm.text(), '信封里的状态字段不得进摘要输入').not.toContain('状态字段-专注');
    await app.stop();
  });
});
