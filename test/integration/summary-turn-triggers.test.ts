import { afterEach, expect, it } from 'vitest';
import { agent, type TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 回合结束时的后台压缩，用量到不了压缩线时的触发：会话条数（含这一轮落库的最终回复）到了条数线，或这一轮经过了硬裁剪
// （可压缩部分按裁剪之前的历史算）。对话代理发出真实的用量事件，摘要插件据此全量压缩。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const PROBE = 'zz_ctx_probe';
const LONG = 'a'.repeat(2000);

/** callsTool：第一次对话调用先调一次探针工具，之后都直接回复 */
async function boot(contextLength: number, { systemPrompt = 'test bot', callsTool = false } = {}) {
  const { app } = hostedApp();
  apps.push(app);
  await registerHubs(app);
  const recorder: ChatModelRequest[] = [];
  let replies = 0;
  let toolPending = callsTool;
  await app.plugin(
    createMockLLMPlugin({
      contextLength,
      recorder,
      responses: (request): ChatResponse => {
        if (request.purpose === '摘要') return { content: 'SUMMARY-OF-OLD' };
        if (!toolPending) return { content: `回答${++replies}` };
        toolPending = false;
        return {
          content: null,
          toolCalls: [{ id: 'call-1', type: 'function', function: { name: PROBE, arguments: '{}' } }],
        };
      },
    }),
  );
  if (callsTool) await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  await app.plugin(agentPlugin, { systemPrompt });
  await app.plugin(memorySummary);
  await app.plugins.idle();
  for (const plugin of [sessionManagerPlugin, agentPlugin, memorySummary]) {
    expect(app.plugins.getPlugin(plugin.name)?.state, `${plugin.name} 未激活`).toBe('active');
  }
  const host = app.bind({ agent, events, memory, sessionManager, tools });
  if (callsTool) {
    host.tools.use.register({
      definition: {
        type: 'function',
        function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => 'ok',
    });
  }
  const statuses: string[] = [];
  host.events.use.on('session:compressing', info => void statuses.push(info.status));
  const usages: TokenUsageEvent[] = [];
  host.events.use.on('token:usage', event => void usages.push(event));
  const ask = (sessionId: string, content: string) =>
    host.agent.use.handleMessage({ content, sessionId, platform: 'webui', userId: 'u1' });
  const summaries = () => recorder.filter(r => r.purpose === '摘要').length;
  const active = async (sessionId: string) =>
    (await host.memory.use.getHistory(sessionId, Infinity)).map(m => String(m.content));
  /** 预存十条两千字的历史：估算约 5800 token */
  const seedLong = async (sessionId: string) => {
    for (let i = 0; i < 10; i++) {
      await host.memory.use.saveMessage(sessionId, {
        role: i % 2 ? 'assistant' : 'user',
        content: LONG,
        timestamp: 1000 + i,
      });
    }
  };
  return { host, recorder, statuses, usages, ask, summaries, active, seedLong };
}

/** 一次模型请求里各条消息的正文 */
const textsOf = (request: ChatModelRequest | undefined) => (request?.messages ?? []).map(m => String(m.content ?? ''));

it('条数线：回合结束时会话条数（含落库的最终回复）到线就全量压缩，下一轮读之前已压完；用量远不到压缩线', async () => {
  const { host, recorder, statuses, usages, ask, summaries, active } = await boot(100_000);
  const SESSION = 'zz-ctx-count';
  await host.sessionManager.use.ensureSession(SESSION, { config: { historyLimit: 4 } });

  // 第一轮读进 1 条、落库回复后 2 条；第二轮读进 3 条、落库回复后 4 条，到线
  await ask(SESSION, '第一问');
  expect(summaries()).toBe(0);
  await ask(SESSION, '第二问');
  expect(usages.map(u => u.historyMessages)).toEqual([1, 3]);
  expect(usages.at(-1)).toMatchObject({ trimmed: false });
  expect(usages.at(-1)?.usageRatio).toBeLessThan(0.1);
  await expect.poll(() => statuses).toEqual(['start', 'done']);
  expect(await active(SESSION)).toEqual(['对话已压缩']);
  const summarized = textsOf(recorder.find(r => r.purpose === '摘要')).join('\n');
  for (const text of ['第一问', '回答1', '第二问', '回答2']) expect(summarized).toContain(text);

  // 第三轮读进分隔标记与这一问，最早的消息都在摘要里；压完不再触发
  await ask(SESSION, '第三问');
  await new Promise<void>(r => setTimeout(r, 20));
  expect(usages.at(-1)?.historyMessages).toBe(2);
  expect(summaries()).toBe(1);
  const texts = textsOf(recorder.at(-1));
  expect(texts.some(text => text.includes('SUMMARY-OF-OLD'))).toBe(true);
  expect(texts.some(text => text.includes('第三问'))).toBe(true);
});

// 下面三条：窗口 4096、最大输出 1024，裁剪预算 2560，低于 0.8 × 4096，有效阈值就是裁剪预算
it('没有工具、压缩线乘窗口高于裁剪预算：入口估算超过裁剪预算的那一轮带 trimmed，结束时全量压缩', async () => {
  const { statuses, usages, ask, active, seedLong } = await boot(4096);
  const SESSION = 'zz-ctx-trimmed';
  await seedLong(SESSION);

  await ask(SESSION, '在吗');

  const last = usages.at(-1);
  expect(last).toMatchObject({ trimmed: true, tokenBudget: 2560, turnId: expect.any(String) });
  expect(last?.used, '裁剪之后的用量到不了裁剪预算').toBeLessThan(2560);
  expect(last?.untrimmedHistory, '可压缩部分够线的一半').toBeGreaterThanOrEqual(1280);
  await expect.poll(() => statuses).toEqual(['start', 'done']);
  expect(await active(SESSION)).toEqual(['对话已压缩']);
});

it('首次调用被硬裁剪、之后调了一次工具：最后一次调用照样带 trimmed，回合结束时全量压缩', async () => {
  const { statuses, usages, ask, active, seedLong } = await boot(4096, { callsTool: true });
  const SESSION = 'zz-ctx-trimmed-tool';
  await seedLong(SESSION);

  await ask(SESSION, '帮我查一下');

  expect(usages).toHaveLength(2);
  const last = usages[1];
  expect(last).toMatchObject({ trimmed: true, turnId: usages[0].turnId });
  expect(last.used, '最后一次调用自己没超裁剪预算').toBeLessThan(2560);
  await expect.poll(() => statuses).toEqual(['start', 'done']);
  expect(await active(SESSION)).toEqual(['对话已压缩']);
});

it('压不掉的部分超过裁剪预算：每轮都被硬裁剪，按裁剪之前的历史判可压缩部分，压完下一轮不再触发', async () => {
  // 人设约 2860 token，单它就超过裁剪预算：裁剪之后发出的历史只剩当前这条消息
  const { statuses, usages, ask, summaries, seedLong } = await boot(4096, { systemPrompt: 'p'.repeat(10_000) });
  const SESSION = 'zz-ctx-heavy-system';
  await seedLong(SESSION);

  await ask(SESSION, '在吗');
  const first = usages.at(-1);
  expect(first?.trimmed).toBe(true);
  expect(first && first.breakdown.history + first.breakdown.toolResults, '发出的历史不到线的一半').toBeLessThan(1280);
  expect(first?.untrimmedHistory, '裁剪之前的历史够线的一半').toBeGreaterThanOrEqual(1280);
  await expect.poll(() => statuses).toEqual(['start', 'done']);

  const compressed = summaries();
  await ask(SESSION, '再问一句');
  await new Promise<void>(r => setTimeout(r, 20));
  expect(usages.at(-1)?.trimmed).toBe(true);
  expect(summaries()).toBe(compressed);
  expect(statuses).toEqual(['start', 'done']);
});
