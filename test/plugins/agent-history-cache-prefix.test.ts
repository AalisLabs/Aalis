import { afterEach, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events, LogHub } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import openaiPlugin from '../../packages/plugin-llm-openai/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 压缩没压成期间，发给模型的开头在两次成段丢弃之间逐字不变：条数线超出时一次丢掉最早的半条线，之后各轮请求的系统提示与
// 历史都是下一轮请求的前缀，服务商的前缀缓存因此命中。在发往服务商的那一层比对：真的 OpenAI 插件，桩 fetch 记下每次
// /chat/completions 的请求体，逐条比 messages 的 JSON（线上发出去的字节），请求体其余部分（模型、工具、输出上限、流式
// 开关）逐字相同。不装人设与注入本轮材料的插件，请求里的本轮块只有当前消息。摘要请求按系统提示的开头认，一律回 500；
// 该压缩的轮次按退避预先算好，等那一轮的后台压缩落定再发下一条，退避的轮次因此确定。
// ════════════════════════════════════════════════════════════

const SESSION = 'zz-cache-prefix';
const LIMIT = 20;
const PROBE = 'zz_cache_probe';

interface ApiMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
}
interface ChatBody extends Record<string, unknown> {
  messages: ApiMessage[];
}
/** 一次对话请求：发出时所在的轮次与请求体 */
interface Sent {
  turn: number;
  body: ChatBody;
}

const realFetch = globalThis.fetch;
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  globalThis.fetch = realFetch;
});

/** 一个增量帧的 SSE 流 */
function sse(delta: Record<string, unknown>): Response {
  const frames = [`data: ${JSON.stringify({ choices: [{ delta }] })}`, 'data: [DONE]'];
  return new Response(frames.join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function boot() {
  const logs: string[] = [];
  const logHub = new LogHub();
  logHub.onEntry(entry => void logs.push(entry.message));
  const { app } = hostedApp({ logLevel: 'warn' }, { logHub });
  apps.push(app);
  await registerHubs(app);

  const conversation: Sent[] = [];
  const summaryTurns: number[] = [];
  let turn = 0;
  let toolPending = false;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ChatBody;
    if (String(body.messages[0]?.content).startsWith('你是对话摘要助手')) {
      summaryTurns.push(turn);
      return new Response(JSON.stringify({ error: { message: 'zz-summary-down' } }), { status: 500 });
    }
    conversation.push({ turn, body });
    if (!toolPending) return sse({ content: `回答 ${turn}` });
    toolPending = false;
    return sse({ tool_calls: [{ index: 0, id: `call-${turn}`, function: { name: PROBE, arguments: '{}' } }] });
  }) as typeof fetch;

  await app.plugin(openaiPlugin, {
    apiKey: 'zz-key',
    baseUrl: 'https://llm.invalid/v1',
    customModels: 'gpt-4o',
    discoverModels: false,
  });
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'zz cache bot' });
  await app.plugin(memorySummary);
  await app.plugins.idle();
  for (const plugin of [openaiPlugin, toolsPlugin, sessionManagerPlugin, agentPlugin, memorySummary]) {
    expect(app.plugins.getPlugin(plugin.name)?.state, `${plugin.name} 未激活`).toBe('active');
  }
  const host = app.bind({ agent, events, sessionManager, tools });
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ok',
  });
  await host.sessionManager.use.ensureSession(SESSION, { config: { historyLimit: LIMIT } });
  const statuses: string[] = [];
  host.events.use.on('session:compressing', info => void statuses.push(info.status));

  /**
   * 第 k 轮：callsTool 时先调一次探针工具再回复（落四条），否则直接回复（落两条）。compresses 时这一轮结束该触发一次后台
   * 压缩，等它报出 start 与 error 再往下，不靠压缩在几个任务之内报出
   */
  const ask = async (k: number, { callsTool = false, compresses = false } = {}) => {
    turn = k;
    toolPending = callsTool;
    const reported = statuses.length;
    await host.agent.use.handleMessage({ content: `问题 ${k}`, sessionId: SESSION, platform: 'webui', userId: 'u1' });
    if (compresses) await expect.poll(() => statuses.length).toBe(reported + 2);
  };
  return { ask, conversation, summaryTurns, statuses, logs };
}

/** 请求体里逐条消息的 JSON */
const lines = (body: ChatBody) => body.messages.map(m => JSON.stringify(m));
/** 两次请求开头逐字相同的条数 */
const sharedPrefix = (a: string[], b: string[]) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
/** 当前消息的位置：最后一条用户消息（工具循环里的后续请求在它之后接着本回合的工具调用与结果） */
const head = (body: ChatBody) => body.messages.findLastIndex(m => m.role === 'user');
/** 发出的历史：系统提示与当前消息之间的消息 */
const historyOf = (body: ChatBody) => body.messages.slice(1, head(body));

/**
 * 相邻两次对话请求：请求体去掉 messages 之后逐字相同（工具列表变了前缀就全失效）；前一次的系统提示与历史是后一次的前缀，
 * 没保住的只能是开头只共享系统提示的那一对（成段丢弃）。返回这些对里后一次所在的轮次。当前消息到下一轮成了历史，跨分钟时
 * 时间标注可能不同，所以只比到它之前
 */
function droppedTurns(conversation: Sent[]): number[] {
  const rests = conversation.map(({ body: { messages: _, ...rest } }) => JSON.stringify(rest));
  expect(new Set(rests).size).toBe(1);
  const dropped: number[] = [];
  for (let i = 1; i < conversation.length; i++) {
    const prev = conversation[i - 1].body;
    const shared = sharedPrefix(lines(prev), lines(conversation[i].body));
    if (shared >= head(prev)) continue;
    expect(shared, `第 ${conversation[i].turn} 轮`).toBe(1);
    dropped.push(conversation[i].turn);
  }
  return dropped;
}

it('压缩一直失败：两次成段丢弃之间开头逐字不变，发出的历史在半条线到整条线之间；摘要按退避的轮次请求', async () => {
  const { ask, conversation, summaryTurns, statuses } = await boot();
  // 第 k 轮开头活跃条数为 2k − 1（含这一轮的入站消息）：超过 20 条之后每超出 10 条丢一段。
  // 第 10 轮结束时到线，之后第 k 次没压成隔 2^k 轮再试
  const compressing = [10, 12, 16, 24];
  for (let k = 1; k <= 30; k++) await ask(k, { compresses: compressing.includes(k) });

  expect(droppedTurns(conversation)).toEqual([11, 16, 21, 26]);
  const sizes = conversation.filter(r => r.turn >= 11).map(r => historyOf(r.body).length);
  expect([Math.min(...sizes), Math.max(...sizes)]).toEqual([10, 18]);
  expect(summaryTurns).toEqual(compressing);
  expect(statuses).toEqual(compressing.flatMap(() => ['start', 'error']));
});

it('丢弃的边界落在工具调用组中间：组首连同结果一起丢，工具组整组发或整组不发，不告警不完整的组', async () => {
  const { ask, conversation, summaryTurns, logs } = await boot();
  // 第 5、13 轮调一次工具：第 k 轮开头活跃条数为 1、3、5、7、9、13、…、27、31、…，第 10、14、19 轮超出一段；
  // 第 10 轮的起点 10 正是第 5 轮的工具结果（8 用户、9 带调用的助手、10 工具结果、11 回复）。
  // 第 9 轮结束时到线（19 条加回复），之后隔 2、4 轮再试
  const compressing = [9, 11, 15];
  for (let k = 1; k <= 20; k++) await ask(k, { callsTool: k === 5 || k === 13, compresses: compressing.includes(k) });

  expect(droppedTurns(conversation)).toEqual([10, 14, 19]);
  // 起点算对：第 10 轮的历史从第 5 轮的回复开始，工具组整组丢掉
  const first = conversation.find(r => r.turn === 10);
  expect(first && historyOf(first.body)[0]).toMatchObject({ role: 'assistant', content: '回答 5' });
  // 第 14 到 18 轮的历史带着第 13 轮的整组
  expect(
    conversation.filter(r => r.turn >= 14 && r.turn <= 18).every(r => historyOf(r.body).some(m => m.tool_calls)),
  ).toBe(true);
  // 对齐：起点落在组中间时开头的工具结果随组首一起丢，清洗不会再跳过落单的结果
  expect(logs.filter(message => message.includes('不完整工具调用组'))).toEqual([]);
  expect(summaryTurns).toEqual(compressing);
});
