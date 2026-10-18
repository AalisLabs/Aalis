import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService, type TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { type ChatModelRequest, type ChatResponse, estimateMsgTokens } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { isSessionConfigError, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events, LogHub } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 条数线 historyLimit 是 agent 登记的会话设置项：发给模型的会话历史不超过这么多条，超过时一次丢掉最早的半条线，之后照常
// 累积到线再丢一段（起点只由活跃条数与条数线算出），也是摘要插件按条数压缩的线；0 或哪一层都没设时发全部活跃历史。
// 真实回合与 token:request 的快照都按会话取、按同一个起点切。用量事件的 historyMessages 是这一轮开头会话的活跃条数
// （含当前这条消息与没发给模型的部分）加本回合追加的工具调用与结果，快照只有活跃条数。
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

/** responses 缺省时每次回复各不相同：与上一条回复相同的回复不落库 */
async function boot(responses?: ChatResponse[]) {
  const logs: string[] = [];
  const logHub = new LogHub();
  logHub.onEntry(entry => void logs.push(entry.message));
  const { app } = hostedApp({ logLevel: 'warn' }, { logHub });
  apps.push(app);
  await registerHubs(app);
  const recorder: ChatModelRequest[] = [];
  let replies = 0;
  await app.plugin(
    createMockLLMPlugin({
      contextLength: 1_000_000,
      responses: responses ?? (() => ({ content: `好 ${++replies}` })),
      recorder,
    }),
  );
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
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ok',
  });
  const usages: TokenUsageEvent[] = [];
  host.events.use.on('token:usage', event => void usages.push(event));
  let asked = 0;
  const ask = (sessionId: string, platform = 'webui') =>
    host.agent.use.handleMessage({ content: `在吗 ${++asked}`, sessionId, platform, userId: 'u1' });
  /** 存 n 条旧消息，时间早于这一轮 */
  const seed = async (sessionId: string, n: number) => {
    const store = host.memory.use;
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
  /** 一次模型请求里发出的历史：去掉系统消息与当前这条 */
  const historyIn = (request: ChatModelRequest | undefined) =>
    (request?.messages ?? []).filter(m => m.role !== 'system').slice(0, -1);
  return { host, sm: host.sessionManager.use, recorder, usages, logs, ask, seed, oldIn, historyIn };
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
  it('设为 N：超过时按半条线成段丢弃；historyMessages 是活跃条数（含当前这条），再加本回合追加的工具调用与结果', async () => {
    const { sm, recorder, usages, ask, seed, oldIn } = await boot([callProbe, { content: '查好了' }]);
    await seed('zz-ctx-five', 30);
    await sm.ensureSession('zz-ctx-five', { config: { historyLimit: 5 } });
    await ask('zz-ctx-five');

    // 活跃 31 条，条数线 5、半条线 3：从第 27 条发起
    expect(oldIn(recorder[0])).toEqual([27, 28, 29].map(i => `zz-old ${i}`));
    expect(usages.map(u => u.historyMessages)).toEqual([31, 33]);
  });

  it('全局默认、平台档与会话自己的设置按层生效；没有出生平台的会话按入口平台选平台档', async () => {
    const { sm, recorder, ask, seed, historyIn } = await boot();
    const owner = await sm.createSession({ name: '本机会话' });
    await seed(owner.id, 30);
    const sentOn = async (platform: string) => {
      await ask(owner.id, platform);
      return historyIn(recorder.at(-1)).length;
    };

    // 每轮落两条，四轮开头的活跃条数是 31、33、35、37
    await sm.updateLayer({ scope: 'defaults' }, { historyLimit: 20 });
    expect(await sentOn('webui')).toBe(10);

    await sm.updateLayer({ scope: 'platform', platform: 'webui' }, { historyLimit: 10 });
    expect([await sentOn('webui'), await sentOn('cli')]).toEqual([7, 14]);

    await sm.updateSession(owner.id, { config: { historyLimit: 5 } });
    expect(await sentOn('webui')).toBe(3);
  });

  it('起点落在工具调用组中间：组首连同结果一起丢，不告警不完整的组', async () => {
    const { host, sm, recorder, logs, ask, oldIn, historyIn } = await boot();
    const SESSION = 'zz-ctx-tool-edge';
    const call = { id: 'call-old', type: 'function' as const, function: { name: PROBE, arguments: '{}' } };
    for (let i = 0; i < 9; i++) {
      const timestamp = 1000 + i;
      await host.memory.use.saveMessage(
        SESSION,
        i === 5
          ? { role: 'assistant', content: null, toolCalls: [call], timestamp }
          : i === 6
            ? { role: 'tool', content: 'ok', toolCallId: call.id, timestamp }
            : { role: i % 2 ? 'assistant' : 'user', content: `zz-old ${i}`, timestamp },
      );
    }
    await sm.ensureSession(SESSION, { config: { historyLimit: 6 } });
    await ask(SESSION);

    // 加上这一轮的入站共 10 条，条数线 6、半条线 3：起点 6 正是第 5 条调用的结果
    expect(oldIn(recorder[0])).toEqual(['zz-old 7', 'zz-old 8']);
    expect(historyIn(recorder[0]).some(m => m.role === 'tool' || m.toolCalls)).toBe(false);
    expect(logs.filter(message => message.includes('不完整工具调用组'))).toEqual([]);
  });

  it('没设或设为 0 时读全部活跃历史：600 条全进上下文，快照同样', async () => {
    const { host, sm, recorder, usages, ask, seed, oldIn } = await boot();
    await seed('zz-ctx-all', 600);

    await host.events.use.emit('token:request', { sessionId: 'zz-ctx-all' });
    expect(usages.at(-1)?.historyMessages).toBe(600);

    await ask('zz-ctx-all');
    expect(oldIn(recorder.at(-1))).toHaveLength(600);
    expect(usages.at(-1)?.historyMessages).toBe(601);

    await sm.ensureSession('zz-ctx-all', { config: { historyLimit: 0 } });
    await ask('zz-ctx-all');
    expect(oldIn(recorder.at(-1))).toHaveLength(600);
  });

  it('快照按同一个起点切，historyMessages 是活跃条数，不带 turnId', async () => {
    const { host, sm, usages, seed } = await boot();
    await seed('zz-ctx-snapshot', 30);
    await sm.ensureSession('zz-ctx-snapshot', { config: { historyLimit: 5 } });
    await host.events.use.emit('token:request', { sessionId: 'zz-ctx-snapshot' });

    // 活跃 30 条，条数线 5、半条线 3：从第 27 条发起
    const sent = (await host.memory.use.getHistory('zz-ctx-snapshot', Infinity)).slice(27);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      historyMessages: 30,
      breakdown: { history: sent.reduce((sum, m) => sum + estimateMsgTokens(m), 0) },
    });
    expect(usages[0].turnId).toBeUndefined();
  });
});
