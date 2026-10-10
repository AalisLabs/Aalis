import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService, type TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, LogHub } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin, type MockLLMOptions } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// token:usage 在每次模型调用之后发一次（首次调用、工具循环里的每次、格式重试），调用抛错的那次不发。
// used 与 usageRatio 取接口返回的输入 token，没有返回（或不是正的有限数）时取按发出的消息与工具定义的估算；
// trimmed 标出本回合到这次调用为止经过了硬裁剪，untrimmedHistory 是按没经过硬裁剪的列表估算的历史与工具结果。
// token:request 的快照不带 turnId，照样带 trimmed、untrimmedHistory 与读进的条数。
// ════════════════════════════════════════════════════════════

const PROBE = 'zz_usage_probe';
const usage = (promptTokens: number) => ({ promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 });
const callProbe = (promptTokens?: number): ChatResponse => ({
  content: null,
  toolCalls: [{ id: 'call-1', type: 'function', function: { name: PROBE, arguments: '{}' } }],
  ...(promptTokens ? { usage: usage(promptTokens) } : {}),
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(llm: MockLLMOptions = {}) {
  const logs: string[] = [];
  const logHub = new LogHub();
  logHub.onEntry(entry => void logs.push(entry.message));
  const app = new App({ name: 'T', logLevel: 'info', logHub });
  apps.push(app);
  await registerHubs(app);
  const recorder: ChatModelRequest[] = [];
  await app.plugin(createMockLLMPlugin({ ...llm, recorder }));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  for (const name of [toolsPlugin.name, agentPlugin.name]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }
  const host = app.bind({ agent: agentService, tools, events, hooks, memory });
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ok',
  });
  /** 每条用量，与它发出时模型已被调用的次数 */
  const usages: Array<{ event: TokenUsageEvent; calls: number }> = [];
  host.events.use.on('token:usage', event => void usages.push({ event, calls: recorder.length }));
  const ask = (sessionId: string) =>
    host.agent.use.handleMessage({
      content: '帮我查一下',
      sessionId,
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
  return { host, usages, ask, logs };
}

/** 估算的输入：各桶之和（为回复预留的不算） */
const estimated = ({ breakdown }: TokenUsageEvent) =>
  breakdown.system + breakdown.history + breakdown.toolResults + breakdown.toolDefs;
/** 发出的列表里历史与工具结果的估算 */
const sentHistory = ({ breakdown }: TokenUsageEvent) => breakdown.history + breakdown.toolResults;

describe('token:usage 在每次模型调用之后发', () => {
  it('工具循环 3 轮共调用 4 次、发 4 次，used 与 usageRatio 取接口返回的输入 token', async () => {
    const { usages, ask } = await boot({
      responses: [callProbe(1000), callProbe(2000), callProbe(3000), { content: '查好了', usage: usage(4000) }],
    });
    await ask('zz-ctx-loop');

    expect(usages.map(u => u.calls)).toEqual([1, 2, 3, 4]);
    expect(usages.map(u => u.event.used)).toEqual([1000, 2000, 3000, 4000]);
    for (const { event } of usages) {
      expect(event.usageRatio).toBe(event.used / event.contextWindow);
      expect(event.turnId).toEqual(expect.any(String));
    }
  });

  it('接口没返回输入 token 时 used 为估算', async () => {
    const { usages, ask } = await boot({ responses: [callProbe(), { content: '查好了' }] });
    await ask('zz-ctx-estimate');

    expect(usages).toHaveLength(2);
    for (const { event } of usages) {
      expect(event.used).toBeGreaterThan(0);
      expect(event.used).toBe(estimated(event));
    }
    expect(usages[1].event.breakdown.toolResults, '第二次调用带着工具结果').toBeGreaterThan(0);
  });

  it('接口返回的输入 token 不是正的有限数（0、NaN）时 used 为估算', async () => {
    const { usages, ask } = await boot({
      responses: [
        { ...callProbe(), usage: usage(0) },
        { content: '查好了', usage: usage(Number.NaN) },
      ],
    });
    await ask('zz-ctx-bad-count');

    expect(usages).toHaveLength(2);
    for (const { event } of usages) {
      expect(event.used).toBeGreaterThan(0);
      expect(event.used).toBe(estimated(event));
      expect(event.usageRatio).toBe(event.used / event.contextWindow);
    }
  });

  it('调用抛错的那次不发：首次调用抛错一条不发，工具循环里抛错只有之前那次的', async () => {
    const first = await boot({ throwOnce: new Error('模型挂了') });
    await first.ask('zz-ctx-throw-first');
    expect(first.usages).toEqual([]);

    let calls = 0;
    const later = await boot({
      responses: () => {
        if (++calls === 2) throw new Error('模型挂了');
        return callProbe(1000);
      },
    });
    await later.ask('zz-ctx-throw-later');
    expect(later.usages.map(u => [u.calls, u.event.used])).toEqual([[1, 1000]]);
  });

  it('格式重试的那次调用同样在调用之后发', async () => {
    const { host, usages, ask } = await boot({
      responses: [
        { content: '第一版', usage: usage(1000) },
        { content: '第二版', usage: usage(1500) },
      ],
    });
    host.hooks.use.middleware('agent:reply:before', async (data, next) => {
      if (data.attempt === 0) {
        data.retryRequested = true;
        data.maxRetries = 1;
      }
      await next();
    });
    await ask('zz-ctx-retry');

    expect(usages.map(u => [u.calls, u.event.used])).toEqual([
      [1, 1000],
      [2, 1500],
    ]);
  });

  it('回合结束之前，这一轮每条用量的监听者都已处理完', async () => {
    const { host, ask } = await boot({ responses: [callProbe(1000), { content: '查好了', usage: usage(2000) }] });
    // 前一个监听者要等一拍：发射方不等监听者处理完时，后一个监听者要到回合结束之后才收到最后一条
    host.events.use.on('token:usage', () => new Promise<void>(r => setTimeout(r, 0)));
    const seen: number[] = [];
    host.events.use.on('token:usage', event => void seen.push(event.used));
    let atTurnEnd: number[] = [];
    host.hooks.use.middleware('agent:turn:after', async (_data, next) => {
      atTurnEnd = [...seen];
      await next();
    });
    await ask('zz-ctx-order');

    expect(atTurnEnd).toEqual([1000, 2000]);
  });
});

describe('trimmed 与 untrimmedHistory：硬裁剪', () => {
  // 窗口 4096、最大输出 1024：裁剪预算 4096 − 1024 − 512 = 2560；十条两千字的历史估算约 5800
  const LONG = 'a'.repeat(2000);
  async function seedLong(host: Awaited<ReturnType<typeof boot>>['host'], sessionId: string) {
    const store = host.memory.use;
    for (let i = 0; i < 10; i++) {
      await store.saveMessage(sessionId, { role: i % 2 ? 'assistant' : 'user', content: LONG, timestamp: 1000 + i });
    }
  }

  it('入口估算超过裁剪预算时为 true，没超过时为 false', async () => {
    const { host, usages, ask } = await boot({ contextLength: 4096 });
    await seedLong(host, 'zz-ctx-long');
    await ask('zz-ctx-long');
    await ask('zz-ctx-short');

    expect(usages.map(u => [u.event.sessionId, u.event.trimmed])).toEqual([
      ['zz-ctx-long', true],
      ['zz-ctx-short', false],
    ]);
  });

  it('首次调用被硬裁剪：之后的调用在裁过的底稿上追加，照样带 trimmed，untrimmedHistory 补回首次裁掉的部分', async () => {
    const { host, usages, ask } = await boot({ contextLength: 4096, responses: [callProbe(), { content: '查好了' }] });
    await seedLong(host, 'zz-ctx-loop-long');
    await ask('zz-ctx-loop-long');

    expect(usages).toHaveLength(2);
    const [first, second] = usages.map(u => u.event);
    expect([first.trimmed, second.trimmed]).toEqual([true, true]);
    expect(first.untrimmedHistory, '首次调用裁掉了历史').toBeGreaterThan(sentHistory(first));
    // 第二次调用自己没超预算：发出的就是底稿，比首次多出的只有追加的工具调用与结果
    expect(second.used).toBeLessThan(second.tokenBudget);
    expect(second.untrimmedHistory - first.untrimmedHistory).toBe(sentHistory(second) - sentHistory(first));
  });

  it('快照不带 turnId，照样带 trimmed、untrimmedHistory 与读进的条数', async () => {
    const { host, usages } = await boot({ contextLength: 4096 });
    await seedLong(host, 'zz-ctx-long');
    await host.memory.use.saveMessage('zz-ctx-short', { role: 'user', content: '在吗' });
    await host.events.use.emit('token:request', { sessionId: 'zz-ctx-long' });
    await host.events.use.emit('token:request', { sessionId: 'zz-ctx-short' });

    expect(usages.map(({ event }) => [event.turnId, event.trimmed, event.historyMessages])).toEqual([
      [undefined, true, 10],
      [undefined, false, 1],
    ]);
    const [long, short] = usages.map(u => u.event);
    expect(long.untrimmedHistory).toBeGreaterThan(sentHistory(long));
    expect(short.untrimmedHistory).toBe(sentHistory(short));
  });

  it('删了消息的硬裁剪记一行日志，带会话 id，只在真实回合的调用；快照同样裁剪，不记', async () => {
    const { host, usages, ask, logs } = await boot({ contextLength: 4096 });
    await seedLong(host, 'zz-ctx-long');
    const trimLogs = () => logs.filter(message => message.includes('条消息'));

    await host.events.use.emit('token:request', { sessionId: 'zz-ctx-long' });
    expect(usages.at(-1)?.event.trimmed).toBe(true);
    expect(trimLogs()).toEqual([]);

    await ask('zz-ctx-long');
    expect(trimLogs()).toHaveLength(1);
    expect(trimLogs()[0]).toContain('zz-ctx-long');
  });
});
