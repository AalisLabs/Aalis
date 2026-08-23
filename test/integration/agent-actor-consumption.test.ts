import { describe, expect, it } from 'vitest';
import type { AgentService } from '../../packages/api-agent/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import type { ToolCallContext } from '../../packages/api-tools/src/index.js';
import { useToolService } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as agentDefaultModule from '../../packages/plugin-agent/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as messageArchiveModule from '../../packages/plugin-message-archive/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
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
  const app = new App({ config: { name: 'E2E', logLevel: 'error', plugins: {} } });
  const toolCallResponse: ChatResponse = {
    content: null,
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'probe_ctx', arguments: '{}' } }],
  };
  const offLLM = await app.ctx.useModule(createMockLLMPlugin({ responses: [toolCallResponse, { content: 'done' }] }));
  const offTools = await app.ctx.useModule(toolsModule as never, {});
  const offMem = await app.ctx.useModule(memoryInMemoryModule as never);
  const offArchive = await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
  const offAgent = await app.ctx.useModule(agentDefaultModule as never, {
    systemPrompt: 'test',
    historyLimit: 50,
    memoryTokenBudget: 1024,
    maxToolIterations: 5,
    toolResultMaxRatio: 0.15,
    trimThresholdRatio: 1.0,
    preferredModel: '',
  });

  let captured: ToolCallContext | undefined;
  useToolService(app.ctx).register({
    definition: {
      type: 'function',
      function: { name: 'probe_ctx', description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async (_args, callCtx) => {
      captured = callCtx;
      return 'ok';
    },
  });

  await app.ctx.getService<AgentService>('agent')!.handleMessage(incoming);
  offAgent();
  offArchive();
  offMem();
  offTools();
  offLLM();
  return captured;
}

describe('actor 消费端：agent 把 incoming.actor 折进 ToolCallContext', () => {
  it('带 actor 的委派消息：actor 到达工具 callCtx，platform/userId 保持会话语义', async () => {
    const ctx = await runTurn({
      content: '执行任务',
      sessionId: 'onebot:1:group:2',
      platform: 'onebot',
      source: 'proactive:from:src',
      triggerType: 'proactive',
      actor: { platform: 'webui', userId: 'console' },
    });
    expect(ctx, '工具未被调用——mock LLM 的 toolCalls 回合没走通').toBeDefined();
    expect(ctx?.actor).toEqual({ platform: 'webui', userId: 'console' });
    expect(ctx?.platform, 'platform 必须保持会话平台，不被 actor 覆盖').toBe('onebot');
    expect(ctx?.userId, 'userId 保持物理来源（委派消息无发言者）').toBeUndefined();
  });

  it('无 actor 的普通消息：callCtx.actor 缺省，身份即物理来源', async () => {
    const ctx = await runTurn({
      content: 'hi',
      sessionId: 's1',
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    expect(ctx).toBeDefined();
    expect(ctx?.actor).toBeUndefined();
    expect(ctx?.platform).toBe('test');
    expect(ctx?.userId).toBe('u1');
  });
});
