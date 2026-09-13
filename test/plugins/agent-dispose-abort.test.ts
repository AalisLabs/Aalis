import { describe, expect, it } from 'vitest';
import type { AgentService } from '../../packages/api-agent/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as agentModule from '../../packages/plugin-agent/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as messageArchiveModule from '../../packages/plugin-message-archive/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// plugin-agent 此前零 onDispose：activeControllers 是实例私有的，bounce 后新实例看不见旧实例的
// 在飞回合，而拆卸链不等任何回合——旧回合在已 dispose 的 ctx 上跑完并投递（人设/模型都是
// bounce 前的），用户在它结束前再发一条，两个实例并发答同一会话。
// 修法：拆卸即 abortAll，走已有的 AbortError 收尾（只发 stream done，不投递）。
// 观测点：只拆 agent 这一个 fork（useModule 的 disposer），根 ctx 活着收出站事件。
// ════════════════════════════════════════════════════════════

const AGENT_CONFIG = {
  systemPrompt: 'test',
  historyLimit: 50,
  memoryTokenBudget: 1024,
  maxToolIterations: 5,
  toolResultMaxRatio: 0.15,
  trimThresholdRatio: 1.0,
  preferredModel: '',
};

describe('plugin-agent 拆卸时中止在飞回合', () => {
  it('拆卸后在飞回合以 aborted 收尾，而不是在死 ctx 上跑完投递', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    // 每个 chunk 前等 300ms：给拆卸留出「回合在飞」的窗口
    await app.ctx.useModule(createMockLLMPlugin({ latencyMs: 300, responses: [{ content: '回复内容' }] }));
    await app.ctx.useModule(memoryInMemoryModule as never);
    await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
    const off = await app.ctx.useModule(agentModule as never, AGENT_CONFIG);

    // agent:turn:after 是 hook（runHook）而非事件，根 ctx 用 on 收不到；鉴别信号取根 ctx 能看到的
    // 出站序列：中止路径只发 stream done，未中止则 delta → done → message（回复照常投递）。
    const seen: string[] = [];
    app.ctx.on('outbound:stream', (c: { done?: boolean; contentDelta?: string }) => {
      seen.push(c.done ? 'stream:done' : `stream:delta(${c.contentDelta})`);
    });
    app.ctx.on('outbound:message', (m: { content: string }) => {
      seen.push(`message(${m.content})`);
    });

    const turn = app.ctx.getService<AgentService>('agent')!.handleMessage({
      content: '你好',
      sessionId: 'test:dispose-abort',
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    await new Promise(r => setTimeout(r, 50)); // 让流进入在飞
    off(); // 只拆 agent 这一个 fork

    await turn;
    expect(seen, '拆卸不中止在飞回合，它就会在死 ctx 上跑完并把回复投出去').toEqual(['stream:done']);

    await app.stop();
  });
});
