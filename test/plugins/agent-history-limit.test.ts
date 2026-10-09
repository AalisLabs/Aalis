import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService, type TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { isSessionConfigError, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 条数线 historyLimit 是 agent 登记的会话设置项：一轮最多读进这么多条会话历史，也是摘要插件按条数压缩的线；
// 0 或哪一层都没设时读全部活跃历史。真实回合与 token:request 的快照都按会话取。
// 用量事件的 historyMessages 是这一轮读进的条数（含当前这条消息）加本回合追加的工具调用与结果，快照只有读进的条数。
// ════════════════════════════════════════════════════════════

const PROBE = 'zz_history_probe';
const callProbe: ChatResponse = {
  content: null,
  toolCalls: [{ id: 'call-1', type: 'function', function: { name: PROBE, arguments: '{}' } }],
};
/** 旧消息的正文是「zz-old 序号」 */
const OLD = /zz-old \d+/;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(responses: ChatResponse[] = [{ content: '好' }]) {
  const { app } = hostedApp();
  apps.push(app);
  await registerHubs(app);
  const recorder: ChatModelRequest[] = [];
  await app.plugin(createMockLLMPlugin({ contextLength: 1_000_000, responses, recorder }));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  for (const name of [toolsPlugin.name, sessionManagerPlugin.name, agentPlugin.name]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }
  const host = app.bind({ agent: agentService, tools, events, memory, sessionManager });
  host.tools.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ok',
  });
  const usages: TokenUsageEvent[] = [];
  host.events.on('token:usage', event => void usages.push(event));
  const ask = (sessionId: string, platform = 'webui') =>
    host.agent.require().handleMessage({ content: '在吗', sessionId, platform, userId: 'u1' });
  /** 存 n 条旧消息，时间早于这一轮 */
  const seed = async (sessionId: string, n: number) => {
    const store = host.memory.require();
    for (let i = 0; i < n; i++) {
      await store.saveMessage(sessionId, {
        role: i % 2 ? 'assistant' : 'user',
        content: `zz-old ${i}`,
        timestamp: 1000 + i,
      });
    }
  };
  /** 一次模型请求里的旧消息（用户消息带着时间标注，只取标记） */
  const oldIn = (request: ChatModelRequest | undefined) =>
    (request?.messages ?? []).flatMap(m => String(m.content ?? '').match(OLD) ?? []);
  return { host, sm: host.sessionManager.require(), recorder, usages, ask, seed, oldIn };
}

describe('会话设置项 historyLimit', () => {
  it('登记为高级设置项：不小于 0 的整数，默认 0，只经继承链实时解析', async () => {
    const { sm } = await boot();
    expect(sm.listSettings().find(s => s.key === 'historyLimit')).toMatchObject({
      plugin: agentPlugin.name,
      field: { type: 'number', integer: true, min: 0, default: 0 },
      prominence: 'advanced',
      liveOnly: true,
    });
  });

  it('写 0 与 300 写得进，写 -1 与 1.5 被拒', async () => {
    const { sm } = await boot();
    const owner = await sm.createSession({ name: '本机会话' });
    for (const value of [0, 300]) {
      await sm.updateLayer({ scope: 'defaults' }, { historyLimit: value });
      await sm.updateSession(owner.id, { config: { historyLimit: value } });
    }
    for (const value of [-1, 1.5]) {
      for (const write of [
        sm.updateLayer({ scope: 'defaults' }, { historyLimit: value }),
        sm.updateSession(owner.id, { config: { historyLimit: value } }),
      ]) {
        await expect(write, String(value)).rejects.toSatisfy(isSessionConfigError);
      }
    }
  });
});

describe('按会话的条数线读历史', () => {
  it('设为 N：一轮最多读进 N 条（含当前这条），historyMessages 再加本回合追加的工具调用与结果', async () => {
    const { sm, recorder, usages, ask, seed, oldIn } = await boot([callProbe, { content: '查好了' }]);
    await seed('zz-ctx-five', 30);
    await sm.ensureSession('zz-ctx-five', { config: { historyLimit: 5 } });
    await ask('zz-ctx-five');

    expect(oldIn(recorder[0])).toEqual([26, 27, 28, 29].map(i => `zz-old ${i}`));
    expect(usages.map(u => u.historyMessages)).toEqual([5, 7]);
  });

  it('全局默认、平台档与会话自己的设置按层生效；没有出生平台的会话按入口平台选平台档', async () => {
    const { sm, usages, ask, seed } = await boot();
    const owner = await sm.createSession({ name: '本机会话' });
    await seed(owner.id, 30);
    const readOn = async (platform: string) => {
      await ask(owner.id, platform);
      return usages.at(-1)?.historyMessages;
    };

    await sm.updateLayer({ scope: 'defaults' }, { historyLimit: 20 });
    expect(await readOn('webui')).toBe(20);

    await sm.updateLayer({ scope: 'platform', platform: 'webui' }, { historyLimit: 10 });
    expect([await readOn('webui'), await readOn('cli')]).toEqual([10, 20]);

    await sm.updateSession(owner.id, { config: { historyLimit: 5 } });
    expect(await readOn('webui')).toBe(5);
  });

  it('没设或设为 0 时读全部活跃历史：600 条全进上下文，快照同样', async () => {
    const { host, sm, recorder, usages, ask, seed, oldIn } = await boot();
    await seed('zz-ctx-all', 600);

    await host.events.emit('token:request', { sessionId: 'zz-ctx-all' });
    expect(usages.at(-1)?.historyMessages).toBe(600);

    await ask('zz-ctx-all');
    expect(oldIn(recorder.at(-1))).toHaveLength(600);
    expect(usages.at(-1)?.historyMessages).toBe(601);

    await sm.ensureSession('zz-ctx-all', { config: { historyLimit: 0 } });
    await ask('zz-ctx-all');
    expect(oldIn(recorder.at(-1))).toHaveLength(600);
  });

  it('快照按会话的条数线读历史，不带 turnId', async () => {
    const { host, sm, usages, seed } = await boot();
    await seed('zz-ctx-snapshot', 30);
    await sm.ensureSession('zz-ctx-snapshot', { config: { historyLimit: 5 } });
    await host.events.emit('token:request', { sessionId: 'zz-ctx-snapshot' });

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ historyMessages: 5 });
    expect(usages[0].turnId).toBeUndefined();
  });
});
