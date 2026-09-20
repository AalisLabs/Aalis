import { describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type BoundOf, type PluginModule } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
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

/**
 * 装一个插件并确认它真的激活了。激活闸会把缺 required 依赖的插件静静留在 pending 且不报错，
 * 不核一下的话「插件根本没跑」会伪装成用例通过。
 */
async function use(app: App, module: PluginModule, config?: Record<string, unknown>): Promise<void> {
  await app.plugin(module, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(module.name)?.state;
  if (state !== 'active') throw new Error(`插件 ${module.name} 未激活（state=${state}）`);
}

const uses = { agent, sessionManager, tools };
type Host = BoundOf<typeof uses>;

async function boot(): Promise<{ app: App; host: Host; executed: () => number; reset: () => void }> {
  const app = new App({ config: { name: 'E2E', logLevel: 'error', plugins: {} } });
  const toolCall: ChatResponse = {
    content: null,
    toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }],
  };
  await use(app, createMockLLMPlugin({ responses: [toolCall] }));
  await use(app, toolsPlugin, {});
  await use(app, memoryInMemoryPlugin);
  await use(app, messageArchivePlugin, { debugLogs: false });
  await use(app, sessionManagerPlugin, {});
  await use(app, agentPlugin, AGENT_CONFIG);
  const host = app.bind(uses);
  let n = 0;
  host.tools.register({
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
    host,
    executed: () => n,
    reset: () => {
      n = 0;
    },
  };
}

const ask = (host: Host, sessionId: string) =>
  host.agent.require().handleMessage({
    content: '调工具',
    sessionId,
    platform: 'test',
    userId: 'u1',
    sessionType: 'private',
  });

describe('会话级 maxToolIterations', () => {
  it('会话设 2 → 循环两轮即停；未设置走全局 5；0 视为未设置', async () => {
    const { app, host, executed, reset } = await boot();
    const sm = host.sessionManager.require();
    try {
      await sm.ensureSession('test:iter-two', { config: { maxToolIterations: 2 } });
      await ask(host, 'test:iter-two');
      expect(executed(), '会话级上限应生效').toBe(2);

      reset();
      await ask(host, 'test:iter-global');
      expect(executed(), '未设置的会话走全局上限').toBe(5);

      reset();
      await sm.ensureSession('test:iter-zero', { config: { maxToolIterations: 0 } });
      await ask(host, 'test:iter-zero');
      expect(executed(), '非正整数视为未设置').toBe(5);
    } finally {
      await app.stop();
    }
  });
});
