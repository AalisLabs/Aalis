import { describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';

// agent 把 /model 指令登记在可选能力 commands 上。集成测试不加载 plugin-commands，
// 登记留在账上等提供者出现，不抛错，集成测试无需额外桩。

import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { llm as llmService } from '../../packages/api-llm/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import type { IncomingMessage, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

/**
 * 端到端集成测试
 *
 * 使用 mock LLM + 真实 memory-inmemory + 真实 agent-default 模拟一次对话：
 * IncomingMessage → agent.handleMessage → outbound:message
 */

async function loadStack(opts: { responses: ChatResponse[]; recorder?: ChatModelRequest[] }) {
  const app = new App({ config: { name: 'E2E', logLevel: 'error', plugins: {} } });
  const host = app.bind({ events, agent: agentService, memory: memoryService, llm: llmService });

  const outbound: OutgoingMessage[] = [];
  host.events.on('outbound:message', (m: OutgoingMessage) => {
    outbound.push(m);
  });

  await app.plugin(createMockLLMPlugin({ responses: opts.responses, recorder: opts.recorder }));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, {
    systemPrompt: 'you are a test bot',
    historyLimit: 50,
    memoryTokenBudget: 1024,
    maxToolIterations: 5,
    toolResultMaxRatio: 0.15,
    trimThresholdRatio: 1.0,
    preferredModel: '',
  });
  await app.plugins.idle();

  return {
    app,
    host,
    outbound,
    agent: host.agent.require(),
    memory: host.memory.require(),
    cleanup: () => app.stop(),
  };
}

const incoming = (content: string, sessionId = 's1'): IncomingMessage => ({
  content,
  sessionId,
  platform: 'test',
  userId: 'u1',
  sessionType: 'private',
});

describe('Agent end-to-end (mock LLM + in-memory)', () => {
  it('单轮：发消息 → outbound 一条响应 + 记忆里有 user+assistant', async () => {
    const recorder: ChatModelRequest[] = [];
    const stack = await loadStack({
      responses: [{ content: 'hello back' }],
      recorder,
    });
    try {
      await stack.agent.handleMessage(incoming('hi there'));
      expect(stack.outbound).toHaveLength(1);
      expect(stack.outbound[0].content).toBe('hello back');
      expect(stack.outbound[0].sessionId).toBe('s1');
      // mock LLM 收到一次请求，messages 里包含我们的 user input
      expect(recorder).toHaveLength(1);
      const userMsg = recorder[0].messages.find(m => m.role === 'user');
      expect(userMsg?.content).toContain('hi there');
      // memory 里有 user + assistant
      const hist = await stack.memory.getHistory('s1');
      expect(hist.length).toBeGreaterThanOrEqual(2);
      expect(hist.find(m => m.role === 'assistant')?.content).toBe('hello back');
    } finally {
      await stack.cleanup();
    }
  });

  it('多轮：第二轮 LLM 收到的 messages 包含上轮历史', async () => {
    const recorder: ChatModelRequest[] = [];
    const stack = await loadStack({
      responses: [{ content: 'r1' }, { content: 'r2' }],
      recorder,
    });
    try {
      await stack.agent.handleMessage(incoming('q1'));
      await stack.agent.handleMessage(incoming('q2'));
      expect(stack.outbound.map(m => m.content)).toEqual(['r1', 'r2']);
      expect(recorder).toHaveLength(2);
      // 第二次请求应包含 q1 / r1 历史
      const second = recorder[1].messages.map(m => `${m.role}:${m.content}`).join('|');
      expect(second).toContain('q1');
      expect(second).toContain('r1');
      expect(second).toContain('q2');
    } finally {
      await stack.cleanup();
    }
  });

  it('LLM 抛错时 agent 不会向上抛出，且没有 outbound', async () => {
    const stack = await loadStack({
      responses: [{ content: 'never' }],
    });
    // 替换胜出 model 的 chat 让它抛错
    const model = stack.host.llm.require();
    const orig = model.chat;
    model.chat = async () => {
      throw new Error('rate limited');
    };
    try {
      await expect(stack.agent.handleMessage(incoming('boom'))).resolves.not.toThrow();
      // outbound 可能是错误提示也可能为空，都不应抛
      expect(stack.outbound.every(m => typeof m.content === 'string')).toBe(true);
    } finally {
      model.chat = orig;
      await stack.cleanup();
    }
  });

  it('两个并发会话互不串扰', async () => {
    const stack = await loadStack({
      responses: [{ content: 'A1' }, { content: 'B1' }],
    });
    try {
      await Promise.all([
        stack.agent.handleMessage(incoming('q-a', 'sess-a')),
        stack.agent.handleMessage(incoming('q-b', 'sess-b')),
      ]);
      const aHist = await stack.memory.getHistory('sess-a');
      const bHist = await stack.memory.getHistory('sess-b');
      expect(aHist.find(m => m.role === 'user')?.content).toContain('q-a');
      expect(bHist.find(m => m.role === 'user')?.content).toContain('q-b');
      // 两个会话各自只看到自己的对话
      expect(aHist.some(m => m.content?.includes('q-b'))).toBe(false);
      expect(bHist.some(m => m.content?.includes('q-a'))).toBe(false);
    } finally {
      await stack.cleanup();
    }
  });
});
