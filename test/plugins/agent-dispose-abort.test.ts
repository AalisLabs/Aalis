import { describe, expect, it } from 'vitest';
import type { AgentService, PromptContributionView } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
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
    off.dispose(); // 只拆 agent 这一个 fork

    await turn;
    expect(seen, '拆卸不中止在飞回合，它就会在死 ctx 上跑完并把回复投出去').toEqual(['stream:done']);

    await app.stop();
  });

  it('手动 abort 会中止正在构建的 prompt 贡献，且不会开始 LLM 或投递消息', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const recorder: ChatModelRequest[] = [];
    await app.ctx.useModule(createMockLLMPlugin({ responses: [{ content: '不应调用' }], recorder }));
    await app.ctx.useModule(memoryInMemoryModule as never);
    await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
    await app.ctx.useModule(agentModule as never, AGENT_CONFIG);

    let enteredResolve!: () => void;
    const entered = new Promise<void>(resolve => {
      enteredResolve = resolve;
    });
    let contributionAborted = false;
    let hangContribution = true;
    app.ctx.fork('prompt-cancel-probe').contribute(
      'agent:prompt' as never,
      {
        id: 'hang-until-abort',
        anchor: 'turn-context',
        build: (view: PromptContributionView) => {
          if (!hangContribution) return 'RECOVERED-CONTEXT';
          return new Promise<string>((_resolve, reject) => {
            enteredResolve();
            view.signal?.addEventListener(
              'abort',
              () => {
                contributionAborted = true;
                reject(view.signal?.reason);
              },
              { once: true },
            );
          });
        },
      } as never,
    );

    const outbound: string[] = [];
    app.ctx.on('outbound:stream', (c: { done?: boolean }) => {
      outbound.push(c.done ? 'stream:done' : 'stream:delta');
    });
    app.ctx.on('outbound:message', () => {
      outbound.push('message');
    });

    const sessionId = 'test:prompt-abort';
    const agent = app.ctx.getService<AgentService>('agent')!;
    const turn = agent.handleMessage({
      content: '你好',
      sessionId,
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    await entered;
    expect(agent.abort).toBeDefined();
    agent.abort!(sessionId);
    await turn;

    expect(contributionAborted).toBe(true);
    expect(recorder, 'prompt build 被取消后不得开始 LLM 请求').toHaveLength(0);
    expect(outbound, '中止路径只能关闭流，不得投递回复').toEqual(['stream:done']);

    // aborted 收尾必须清掉 active controller；同一 session 的下一轮不可继承
    // 旧 signal，也须重新执行此前未物化的贡献。
    hangContribution = false;
    await agent.handleMessage({
      content: '下一条正常消息',
      sessionId,
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    expect(recorder, '下一回合应正常到达 LLM').toHaveLength(1);
    expect(
      outbound.filter(x => x === 'message'),
      '只能投递恢复后的新回合回复',
    ).toEqual(['message']);
    expect(outbound.filter(x => x === 'stream:done')).toHaveLength(2);

    await app.stop();
  });
});
