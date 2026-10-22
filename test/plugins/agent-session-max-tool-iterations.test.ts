import { describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { isSessionSettingsError, sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type BoundOf, type PluginDefinition } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { recordingLogger } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// agent 的按会话字段。
// - maxToolIterations：一轮里工具调用循环的最大次数，正整数，没设即不限；会话设了按会话的。模型先连着要求调 calls 次工具、
//   再给出回复，工具真实执行次数即循环轮数。
// - llm：字段类型 llm-ref 不经 schema-config 校验，形状由字段展开的 MODEL_REF_TEXT 核：服务与模型都是非空字符串。
// ════════════════════════════════════════════════════════════

/**
 * 装一个插件并确认它真的激活了。激活闸会把缺 required 依赖的插件静静留在 pending 且不报错，
 * 不核一下的话「插件根本没跑」会伪装成用例通过。
 */
async function use(app: App, module: PluginDefinition, config?: Record<string, unknown>): Promise<void> {
  await app.plugin(module, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(module.name)?.state;
  if (state !== 'active') throw new Error(`插件 ${module.name} 未激活（state=${state}）`);
}

const uses = { agent, sessionManager, sessionSettings, tools };
type Host = BoundOf<typeof uses>;

/** 模型每次回合都先连着要求调 calls 次工具，再给出回复；warns 收集告警 */
async function boot(calls = 1): Promise<{
  app: App;
  host: Host;
  executed: () => number;
  reset: () => void;
  warns: string[];
}> {
  const warns: string[] = [];
  const app = new App({ name: 'E2E', logger: recordingLogger(warns) });
  await registerHubs(app);
  const toolCall: ChatResponse = {
    content: null,
    toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }],
  };
  // 按这一轮里已有几条工具结果给响应：不受标题生成等别的调用打乱
  const responses = (request: { messages: Array<{ role: string }> }): ChatResponse => {
    const results = request.messages.filter(m => m.role === 'tool').length;
    return results < calls ? toolCall : { content: '<回复>' };
  };
  await use(app, createMockLLMPlugin({ responses }));
  await use(app, toolsPlugin, {});
  await use(app, memoryInMemoryPlugin);
  await use(app, messageArchivePlugin, { debugLogs: false });
  await use(app, sessionManagerPlugin, {});
  await use(app, sessionSettingsPlugin, {});
  await use(app, agentPlugin, { systemPrompt: 'test', memoryTokenBudget: 1024 });
  const host = app.bind(uses);
  let n = 0;
  host.tools.use.register({
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
    warns,
  };
}

const ask = (host: Host, sessionId: string) =>
  host.agent.use.handleMessage({
    content: '调工具',
    sessionId,
    platform: 'test',
    userId: 'u1',
    sessionType: 'private',
  });

/** 写这个会话本会话层的一项（会话先建档） */
async function set(host: Host, sessionId: string, key: string, value: unknown) {
  await host.sessionManager.use.ensureSession(sessionId);
  await host.sessionSettings.use.update({ sessionId }, { plugin: agentPlugin.name, key, value });
}

const rejected = async (write: Promise<unknown>) => {
  const err = await write.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isSessionSettingsError(err), String(err)).toBe(true);
};

describe('会话级 maxToolIterations', () => {
  it('没设即不限：一轮跑过 31 次工具调用照常走完，不记「工具调用达到上限」', async () => {
    const { app, host, executed, warns } = await boot(31);
    try {
      await ask(host, 'test:iter-default');
      expect(executed()).toBe(31);
      expect(warns.filter(w => w.includes('工具调用达到上限'))).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('会话设 3 → 第 3 次之后收尾、记一条达到上限；非正整数写不进去', async () => {
    const { app, host, executed, warns } = await boot(31);
    try {
      await set(host, 'test:iter-three', 'maxToolIterations', 3);
      await ask(host, 'test:iter-three');
      expect(executed(), '会话级上限应生效').toBe(3);
      expect(warns.filter(w => w.includes('工具调用达到上限 (3)'))).toHaveLength(1);

      for (const value of [0, 1.5]) await rejected(set(host, 'test:iter-zero', 'maxToolIterations', value));
    } finally {
      await app.stop();
    }
  });
});

describe('会话级模型', () => {
  it('只收服务与模型都是非空字符串的 { provider, model }，别的写不进去', async () => {
    const { app, host } = await boot();
    try {
      const model = { provider: '<服务>', model: '<模型>' };
      await set(host, 'test:model', 'llm', model);
      for (const llm of ['x', { provider: 1, model: {} }, { provider: '<服务>' }, { provider: '', model: '<模型>' }]) {
        await rejected(set(host, 'test:model', 'llm', llm));
      }
      const row = host.sessionSettings.use.rows({ sessionId: 'test:model' }).find(r => r.key === 'llm');
      expect(row).toMatchObject({ value: model, source: 'session' });
    } finally {
      await app.stop();
    }
  });
});
