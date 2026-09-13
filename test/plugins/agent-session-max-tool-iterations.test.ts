import { describe, expect, it } from 'vitest';
import type { AgentService } from '../../packages/api-agent/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import type { SessionManagerService } from '../../packages/api-session-manager/src/index.js';
import { useToolService } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as agentModule from '../../packages/plugin-agent/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as messageArchiveModule from '../../packages/plugin-message-archive/src/index.js';
import * as sessionManagerModule from '../../packages/plugin-session-manager/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 会话级 maxToolIterations：契约与 WebUI 会话页都有这个字段，agent 却从不读——死配置。
// 规则：正整数生效；非正整数视为未设置，回落全局配置。
// 模型每轮都要求调工具（响应耗尽后重复最后一条），工具真实执行次数即循环轮数。
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

async function boot(): Promise<{ app: App; executed: () => number; reset: () => void }> {
  const app = new App({ config: { name: 'E2E', logLevel: 'error', plugins: {} } });
  const toolCall: ChatResponse = {
    content: null,
    toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }],
  };
  await app.ctx.useModule(createMockLLMPlugin({ responses: [toolCall] }));
  await app.ctx.useModule(toolsModule as never, {});
  await app.ctx.useModule(memoryInMemoryModule as never);
  await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
  await app.ctx.useModule(sessionManagerModule as never, {});
  await app.ctx.useModule(agentModule as never, AGENT_CONFIG);
  let n = 0;
  useToolService(app.ctx).register({
    definition: {
      type: 'function',
      function: { name: 'probe', description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => {
      n++;
      return { content: '{"ok":true}' };
    },
  });
  return {
    app,
    executed: () => n,
    reset: () => {
      n = 0;
    },
  };
}

const ask = (app: App, sessionId: string) =>
  app.ctx.getService<AgentService>('agent')!.handleMessage({
    content: '调工具',
    sessionId,
    platform: 'test',
    userId: 'u1',
    sessionType: 'private',
  });

describe('会话级 maxToolIterations', () => {
  it('会话设 2 → 循环两轮即停；未设置走全局 5；0 视为未设置', async () => {
    const { app, executed, reset } = await boot();
    const sm = app.ctx.getService<SessionManagerService>('session-manager')!;
    try {
      await sm.ensureSession('test:iter-two', { config: { maxToolIterations: 2 } });
      await ask(app, 'test:iter-two');
      expect(executed(), '会话级上限应生效').toBe(2);

      reset();
      await ask(app, 'test:iter-global');
      expect(executed(), '未设置的会话走全局上限').toBe(5);

      reset();
      await sm.ensureSession('test:iter-zero', { config: { maxToolIterations: 0 } });
      await ask(app, 'test:iter-zero');
      expect(executed(), '非正整数视为未设置').toBe(5);
    } finally {
      await app.stop();
    }
  });
});
