import { describe, expect, it } from 'vitest';
import type { AgentService } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { useToolService } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as agentModule from '../../packages/plugin-agent/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as messageArchiveModule from '../../packages/plugin-message-archive/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';
import type { OutgoingMessage, StreamChunkMessage } from '../../packages/schema-message/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// agent 两条错误路径的出口纪律：
//   1. 普通异常（非 AbortError）同样要发 outbound:stream done——否则 CLI 流式块不收尾、
//      WebUI 的工具进度不复位，下一轮 delta 会抹掉 [错误] 行；且 done 必须排在 [错误] 消息之前，
//      与正常收尾同序；
//   2. 工具参数不是合法 JSON 时跳过执行（旧行为空参真跑），把错误当 tool 结果回给模型，
//      并带对 tool_call_id（否则下一轮 tool_calls 与 tool 消息不配对，provider 直接 400）。
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

describe('agent 错误路径：流结束标记与坏工具参数', () => {
  it('普通异常分支先发 outbound:stream done 再发 [错误] 消息', async () => {
    const app = new App({ config: { name: 'E2E', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(createMockLLMPlugin({ throwOnce: new Error('模型炸了') }));
    await app.ctx.useModule(memoryInMemoryModule as never);
    await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
    await app.ctx.useModule(agentModule as never, AGENT_CONFIG);

    const timeline: string[] = [];
    app.ctx.on('outbound:stream', (chunk: StreamChunkMessage) => {
      if (chunk.done) timeline.push('done');
    });
    app.ctx.on('outbound:message', (msg: OutgoingMessage) => {
      timeline.push(`message:${msg.content}`);
    });

    await app.ctx.getService<AgentService>('agent')!.handleMessage({
      content: '你好',
      sessionId: 'test:error-done',
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    await app.stop();

    expect(timeline).toEqual(['done', 'message:[错误] 模型炸了']);
  });

  it('坏 JSON 参数：跳过执行，tool 结果带原 tool_call_id 并把错误交给模型下一轮', async () => {
    const app = new App({ config: { name: 'E2E', logLevel: 'error', plugins: {} } });
    const recorder: ChatModelRequest[] = [];
    const badCall: ChatResponse = {
      content: null,
      toolCalls: [{ id: 'call-bad', type: 'function', function: { name: 'probe', arguments: '{"a": ' } }],
    };
    await app.ctx.useModule(createMockLLMPlugin({ responses: [badCall, { content: '已收到' }], recorder }));
    await app.ctx.useModule(toolsModule as never, {});
    await app.ctx.useModule(memoryInMemoryModule as never);
    await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
    await app.ctx.useModule(agentModule as never, AGENT_CONFIG);

    let executed = 0;
    useToolService(app.ctx).register({
      definition: {
        type: 'function',
        function: { name: 'probe', description: '探针', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => {
        executed++;
        return { content: '{"ok":true}' };
      },
    });

    const sessionId = 'test:bad-tool-args';
    await app.ctx.getService<AgentService>('agent')!.handleMessage({
      content: '调工具',
      sessionId,
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    const history = await app.ctx.getService<MemoryService>('memory')!.getHistory(sessionId, 50);
    await app.stop();

    expect(executed, '参数不合法时工具不应真的执行').toBe(0);

    // 模型下一轮请求里：assistant 的 tool_calls 与 tool 结果必须配对，且结果讲清错在哪
    expect(recorder.length).toBeGreaterThanOrEqual(2);
    const nextRequest = recorder[1];
    const assistant = nextRequest.messages.find(m => m.role === 'assistant' && m.toolCalls);
    expect(assistant?.toolCalls?.[0].id).toBe('call-bad');
    const toolMsg = nextRequest.messages.find(m => m.role === 'tool');
    expect(toolMsg?.toolCallId).toBe('call-bad');
    expect(toolMsg?.content).toContain('工具参数不是合法 JSON');
    expect(toolMsg?.content).toContain('请重新生成 arguments');

    // 与「工具执行失败」走同一条落库路径
    const savedTool = history.find(m => m.role === 'tool');
    expect(savedTool?.toolCallId).toBe('call-bad');
    expect(savedTool?.content).toContain('工具参数不是合法 JSON');
  });

  it('arguments 为空串的无参工具照常执行（空串不是坏 JSON）', async () => {
    const app = new App({ config: { name: 'E2E', logLevel: 'error', plugins: {} } });
    const emptyCall: ChatResponse = {
      content: null,
      toolCalls: [{ id: 'call-empty', type: 'function', function: { name: 'probe', arguments: '' } }],
    };
    await app.ctx.useModule(createMockLLMPlugin({ responses: [emptyCall, { content: '已收到' }] }));
    await app.ctx.useModule(toolsModule as never, {});
    await app.ctx.useModule(memoryInMemoryModule as never);
    await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
    await app.ctx.useModule(agentModule as never, AGENT_CONFIG);

    let executed = 0;
    useToolService(app.ctx).register({
      definition: {
        type: 'function',
        function: { name: 'probe', description: '探针', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => {
        executed++;
        return { content: '{"ok":true}' };
      },
    });

    await app.ctx.getService<AgentService>('agent')!.handleMessage({
      content: '调工具',
      sessionId: 'test:empty-tool-args',
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    await app.stop();

    expect(executed, '空串 arguments 是无参工具的合法产物，必须执行').toBe(1);
  });

  it('工具调用上下文带回合中止信号：agent.abort 后工具看到 signal.aborted', async () => {
    const app = new App({ config: { name: 'E2E', logLevel: 'error', plugins: {} } });
    const call: ChatResponse = {
      content: null,
      toolCalls: [{ id: 'call-sig', type: 'function', function: { name: 'probe', arguments: '{}' } }],
    };
    await app.ctx.useModule(createMockLLMPlugin({ responses: [call, { content: '已收到' }] }));
    await app.ctx.useModule(toolsModule as never, {});
    await app.ctx.useModule(memoryInMemoryModule as never);
    await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
    await app.ctx.useModule(agentModule as never, AGENT_CONFIG);

    let seen: AbortSignal | undefined;
    let abortedInsideTool = false;
    useToolService(app.ctx).register({
      definition: {
        type: 'function',
        function: { name: 'probe', description: '探针', parameters: { type: 'object', properties: {} } },
      },
      handler: async (_args, callCtx) => {
        seen = callCtx.signal;
        await new Promise(r => setTimeout(r, 60));
        abortedInsideTool = callCtx.signal?.aborted === true;
        return { content: '{"ok":true}' };
      },
    });

    const sessionId = 'test:tool-signal';
    const agent = app.ctx.getService<AgentService>('agent')!;
    const turn = agent.handleMessage({
      content: '调工具',
      sessionId,
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    await new Promise(r => setTimeout(r, 20));
    agent.abort?.(sessionId);
    await turn;
    await app.stop();

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(abortedInsideTool, '回合中止后工具持有的信号应已中止').toBe(true);
  });
});
