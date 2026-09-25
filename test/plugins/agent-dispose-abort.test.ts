import { describe, expect, it } from 'vitest';
import { agent as agentService, type PromptContributionView } from '../../packages/api-agent/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, definePlugin, events, lifecycle, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 拆卸（bounce / unload / stop）必须中止在飞回合，走已有 AbortError 收尾
// （outbound:stream done + turn:after outcome=aborted，不把半截回复当完成投递）。
// 关停收尾放 onDrain：此刻监听与 memory 仍在，且 drain 会等回合 Promise 落定；
// onDispose 再 abortAll 作兜底。只卸 agent 时，根激活还活着，用来收出站事件。
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
  it('拆卸后在飞回合以 aborted 收尾，而不是在已拆卸的激活上跑完投递', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    // 每个 chunk 前等 300ms：给拆卸留出「回合在飞」的窗口
    await app.plugin(createMockLLMPlugin({ latencyMs: 300, responses: [{ content: '回复内容' }] }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(agentPlugin, AGENT_CONFIG);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(agentPlugin.name)?.state, 'agent 未激活则整条断言恒真').toBe('active');

    // agent:turn:after 是钩子而非事件，根激活用 on 收不到；鉴别信号取根激活能看到的
    // 出站序列：中止路径只发 stream done，未中止则 delta → done → message（回复照常投递）。
    const host = app.bind({ events, agent: agentService });
    const seen: string[] = [];
    host.events.on('outbound:stream', c => {
      seen.push(c.done ? 'stream:done' : `stream:delta(${c.contentDelta})`);
    });
    host.events.on('outbound:message', m => {
      seen.push(`message(${m.content})`);
    });

    const turn = host.agent.require().handleMessage({
      content: '你好',
      sessionId: 'test:dispose-abort',
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    await new Promise(r => setTimeout(r, 50)); // 让流进入在飞
    const unloading = app.plugins.unload(agentPlugin.name); // 只卸 agent 这一个插件

    await turn;
    expect(seen, '拆卸不中止在飞回合，它就会在已拆卸的激活上跑完并把回复投出去').toEqual(['stream:done']);
    await unloading;

    await app.stop();
  });

  it('手动 abort 会中止正在构建的 prompt 贡献，且不会开始 LLM 或投递消息', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const recorder: ChatModelRequest[] = [];

    let enteredResolve!: () => void;
    const entered = new Promise<void>(resolve => {
      enteredResolve = resolve;
    });
    let contributionAborted = false;
    let hangContribution = true;

    // 换个身份交贡献：最小探针插件经 app.plugin 装载，贡献自动归属它这次激活
    const probePlugin = definePlugin({
      name: 'zz-prompt-cancel-probe',
      uses: { contributions },
      apply({ contributions }) {
        contributions.contribute('agent:prompt', {
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
        });
      },
    });

    await app.plugin(createMockLLMPlugin({ responses: [{ content: '不应调用' }], recorder }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(agentPlugin, AGENT_CONFIG);
    await app.plugin(probePlugin);
    await app.plugins.idle();
    for (const id of [agentPlugin.name, probePlugin.name]) {
      expect(app.plugins.getPlugin(id)?.state, id).toBe('active');
    }

    const host = app.bind({ events, agent: agentService });
    const outbound: string[] = [];
    host.events.on('outbound:stream', c => {
      outbound.push(c.done ? 'stream:done' : 'stream:delta');
    });
    host.events.on('outbound:message', () => {
      outbound.push('message');
    });

    const sessionId = 'test:prompt-abort';
    const agent = host.agent.require();
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

  it('app.stop() 等到在飞回合 aborted 收尾，且收尾时 memory 仍可用', async () => {
    const order: string[] = [];
    let memoryProviderOpen = true;
    let memoryOpenAtAbort = false;
    let turnDone = false;

    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(createMockLLMPlugin({ latencyMs: 200, responses: [{ content: 'should-not-land' }] }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugins.idle();
    // 覆盖胜者以便观测「memory 提供者」自己的 onDispose；存储仍交给 inmemory。
    const inner = app.bind({ memory }).memory.require();
    await app.plugin(
      definePlugin({
        name: 'zz-memory-dispose-tap',
        uses: { provide, lifecycle },
        provides: [memory],
        apply({ provide, lifecycle }) {
          provide(memory, inner, { priority: 1000 });
          lifecycle.onDispose(() => {
            memoryProviderOpen = false;
            order.push('memory:onDispose');
          });
        },
      }),
    );
    await app.plugin(agentPlugin, AGENT_CONFIG);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(agentPlugin.name)?.state, 'agent 未激活则整条断言恒真').toBe('active');
    expect(app.plugins.getPlugin('zz-memory-dispose-tap')?.state).toBe('active');

    const host = app.bind({ events, hooks, agent: agentService, memory });
    host.hooks.middleware('agent:turn:after', async (data, next) => {
      await next();
      if (data.outcome !== 'aborted') return;
      memoryOpenAtAbort = memoryProviderOpen;
      try {
        await host.memory.require().getHistory(data.sessionId, 50);
      } catch {
        memoryOpenAtAbort = false;
      }
      order.push('turn:aborted');
    });

    const sessionId = 'test:stop-abort';
    const turn = host.agent
      .require()
      .handleMessage({
        content: 'in-flight',
        sessionId,
        platform: 'test',
        userId: 'u1',
        sessionType: 'private',
      })
      .then(() => {
        turnDone = true;
      });

    await new Promise(r => setTimeout(r, 40));
    await app.stop();
    expect(turnDone, 'stop() 应等到回合 AbortError 收尾，而不是只 abort 信号').toBe(true);
    await turn;

    expect(memoryOpenAtAbort, 'aborted 收尾必须发生在 memory 提供者仍可用时').toBe(true);
    expect(order, 'memory 提供者的 onDispose 必须晚于回合 aborted 收尾').toEqual(['turn:aborted', 'memory:onDispose']);
    const hist = await inner.getHistory(sessionId, 50);
    expect(
      hist.some(m => m.role === 'assistant' && String(m.content).includes('should-not-land')),
      '中止路径不得把未完成的助手回复当完成写入',
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// 提交点：流已结束、尚未落库 / 外发时被中止的回合（手动停止、latest-wins）
// 同样走 AbortError 收尾——只发 stream done、不落库、不外发、outcome=aborted。
// 用 agent:reply:before 上的闸把回合卡在这段窗口里。
// ════════════════════════════════════════════════════════════

describe('plugin-agent 提交点前被中止的回合不落库、不外发', () => {
  async function bootWithReplyGate(responses: { content: string }[]) {
    let enteredResolve!: () => void;
    const entered = new Promise<void>(resolve => {
      enteredResolve = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    let gated = 0;
    const outcomes: string[] = [];
    const gatePlugin = definePlugin({
      name: 'zz-reply-gate-probe',
      uses: { hooks },
      apply({ hooks }) {
        // 只卡第一次进入（第一个回合）；之后的回合直接放行
        hooks.middleware('agent:reply:before', async (_data, next) => {
          if (gated++ === 0) {
            enteredResolve();
            await gate;
          }
          await next();
        });
        hooks.middleware('agent:turn:after', async (data, next) => {
          outcomes.push(data.outcome);
          await next();
        });
      },
    });

    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(createMockLLMPlugin({ responses }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(agentPlugin, AGENT_CONFIG);
    await app.plugin(gatePlugin);
    await app.plugins.idle();
    for (const id of [agentPlugin.name, gatePlugin.name]) {
      expect(app.plugins.getPlugin(id)?.state, `${id} 未激活则断言恒真`).toBe('active');
    }

    const host = app.bind({ events, agent: agentService, memory });
    const seen: string[] = [];
    host.events.on('outbound:stream', c => {
      if (c.done) seen.push('stream:done');
    });
    host.events.on('outbound:message', m => {
      seen.push(`message(${m.content})`);
    });
    const assistantHistory = async (sessionId: string) =>
      (await host.memory.require().getHistory(sessionId, 50)).filter(m => m.role === 'assistant').map(m => m.content);
    return { app, host, entered, release: () => releaseGate(), outcomes, seen, assistantHistory };
  }

  it('手动停止落在流结束之后：只发 stream done，历史无回复，outcome=aborted', async () => {
    const { app, host, entered, release, outcomes, seen, assistantHistory } = await bootWithReplyGate([
      { content: '被掐掉的回复' },
    ]);
    const sessionId = 'test:post-stream-abort';
    const agent = host.agent.require();
    const turn = agent.handleMessage({
      content: '你好',
      sessionId,
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    await entered; // 流已消费完，卡在 reply:before
    agent.abort!(sessionId);
    release();
    await turn;

    expect(seen).toEqual(['stream:done']);
    expect(await assistantHistory(sessionId)).toEqual([]);
    expect(outcomes).toEqual(['aborted']);
    await app.stop();
  });

  it('latest-wins：旧回合在收尾段被新消息掐掉，只投递并落库新回合的回复', async () => {
    const { app, host, entered, release, seen, assistantHistory } = await bootWithReplyGate([
      { content: '回复A' },
      { content: '回复B' },
    ]);
    const sessionId = 'test:latest-wins-post-stream';
    const agent = host.agent.require();
    const msg = (content: string) => ({
      content,
      sessionId,
      platform: 'test',
      userId: 'u1',
      sessionType: 'private' as const,
    });
    const turnA = agent.handleMessage(msg('A'));
    await entered; // A 的流已结束
    const turnB = agent.handleMessage(msg('B'));
    release();
    await Promise.all([turnA, turnB]);

    expect(seen.filter(s => s.startsWith('message('))).toEqual(['message(回复B)']);
    expect(await assistantHistory(sessionId)).toEqual(['回复B']);
    await app.stop();
  });
});
