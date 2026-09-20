import { describe, expect, it } from 'vitest';
import { agent as agentService, type PromptContributionView } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { App, contributions, definePlugin, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// plugin-agent 此前零 onDispose：activeControllers 是实例私有的，bounce 后新实例看不见旧实例的
// 在飞回合，而拆卸链不等任何回合——旧回合在已拆卸的激活上跑完并投递（人设/模型都是
// bounce 前的），用户在它结束前再发一条，两个实例并发答同一会话。
// 修法：拆卸即 abortAll，走已有的 AbortError 收尾（只发 stream done，不投递）。
// 观测点：只卸 agent 这一个插件，App 根激活活着收出站事件。
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
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
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
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
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
});
