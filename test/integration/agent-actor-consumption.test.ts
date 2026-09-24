import { describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// actor 消费端（agent → ToolCallContext）——2026-08-24 审计补盲。
//
// 此前全部 actor 测试都钉「生产端写没写」，消费端零覆盖：变异实测把
// plugin-agent 折 actor 进 toolCtx 的逻辑整个删掉，1570 用例零转红。
// 本测试经真实 agent 工具循环端到端断言三件事：
//   1. incoming.actor 原样到达工具 handler 的 callCtx.actor（授权身份可达守卫）；
//   2. callCtx.platform / userId 保持**会话/物理**语义，不被 actor 覆盖
//      ——跨平台委派曾因覆盖把定时任务归属/平台档继承/记忆平台域/confirm 选路
//      全部路由到发起者平台；
//   3. 无 actor 时 callCtx.actor 缺省（匿名不发明身份）。
// ════════════════════════════════════════════════════════════

async function runTurn(incoming: IncomingMessage): Promise<ToolCallContext | undefined> {
  const app = new App({ name: 'E2E', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ tools, agent: agentService });
  const toolCallResponse: ChatResponse = {
    content: null,
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'probe_ctx', arguments: '{}' } }],
  };
  await app.plugin(createMockLLMPlugin({ responses: [toolCallResponse, { content: 'done' }] }));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, {
    systemPrompt: 'test',
    historyLimit: 50,
    memoryTokenBudget: 1024,
    maxToolIterations: 5,
    toolResultMaxRatio: 0.15,
    trimThresholdRatio: 1.0,
    preferredModel: '',
  });
  await app.plugins.idle();

  let captured: ToolCallContext | undefined;
  host.tools.register({
    definition: {
      type: 'function',
      function: { name: 'probe_ctx', description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async (_args, callCtx) => {
      captured = callCtx;
      return 'ok';
    },
  });

  await host.agent.require().handleMessage(incoming);
  await app.stop();
  return captured;
}

describe('actor 消费端：agent 把 incoming.actor 折进 ToolCallContext', () => {
  it('带 actor 的委派消息：actor 到达工具 callCtx，platform/userId 保持会话语义', async () => {
    const callCtx = await runTurn({
      content: '执行任务',
      sessionId: 'onebot:1:group:2',
      platform: 'onebot',
      source: 'proactive:from:src',
      triggerType: 'proactive',
      actor: { platform: 'webui', userId: 'console' },
    });
    expect(callCtx, '工具未被调用——mock LLM 的 toolCalls 回合没走通').toBeDefined();
    expect(callCtx?.actor).toEqual({ platform: 'webui', userId: 'console' });
    expect(callCtx?.platform, 'platform 必须保持会话平台，不被 actor 覆盖').toBe('onebot');
    expect(callCtx?.userId, 'userId 保持物理来源（委派消息无发言者）').toBeUndefined();
  });

  it('无 actor 的普通消息：callCtx.actor 缺省，身份即物理来源', async () => {
    const callCtx = await runTurn({
      content: 'hi',
      sessionId: 's1',
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    expect(callCtx).toBeDefined();
    expect(callCtx?.actor).toBeUndefined();
    expect(callCtx?.platform).toBe('test');
    expect(callCtx?.userId).toBe('u1');
  });
});
