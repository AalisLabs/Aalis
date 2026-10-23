import { afterEach, expect, it } from 'vitest';
import { agent, type TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events, LogHub } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import openaiPlugin from '../../packages/plugin-llm-openai/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 发给模型的开头在两次变动之间逐字不变：压缩没压成期间，条数线超出时一次丢掉最早的半条线，历史按 token 超出裁剪预算时一次
// 丢掉不少于预算四分之一的一段；压成之后到下一次压缩之间，摘要块与摘要模型挑出、原样保留的原文排在历史开头。其间各轮请求的
// 系统提示与历史都是下一轮请求的前缀，服务商的前缀缓存因此命中。
// 在发往服务商的那一层比对：真的 OpenAI 插件，桩 fetch 记下每次 /chat/completions 的请求体，逐条比 messages 的 JSON
// （线上发出去的字节），请求体其余部分（模型、工具、输出上限、流式开关）逐字相同。不装人设与注入本轮材料的插件，请求里的
// 本轮块只有当前消息。摘要请求按系统提示的开头认，缺省回 500，可切换成回一份摘要；该压缩的轮次按退避预先算好，等那一轮的
// 后台压缩落定再发下一条，退避的轮次因此确定。
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

/** 摘要请求怎么回：reply 没给时回 500；hold 给了时先等它放行 */
interface Summarizer {
  reply?: () => string;
  hold?: Promise<void>;
}

async function boot(summaryConfig: Record<string, unknown> = {}) {
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
  const summarizer: Summarizer = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ChatBody;
    if (String(body.messages[0]?.content).startsWith('你是对话摘要助手')) {
      summaryTurns.push(turn);
      await summarizer.hold;
      if (summarizer.reply) return sse({ content: summarizer.reply() });
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
  await app.plugin(sessionSettingsPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'zz cache bot' });
  await app.plugin(memorySummary, summaryConfig);
  await app.plugins.idle();
  for (const plugin of [
    openaiPlugin,
    toolsPlugin,
    sessionManagerPlugin,
    sessionSettingsPlugin,
    agentPlugin,
    memorySummary,
  ]) {
    expect(app.plugins.getPlugin(plugin.name)?.state, `${plugin.name} 未激活`).toBe('active');
  }
  const host = app.bind({ agent, events, sessionManager, sessionSettings, tools });
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ok',
  });
  await host.sessionManager.use.ensureSession(SESSION);
  await host.sessionSettings.use.update(
    { sessionId: SESSION },
    { plugin: agentPlugin.name, key: 'historyLimit', value: LIMIT },
  );
  const statuses: string[] = [];
  host.events.use.on('session:compressing', info => void statuses.push(info.status));

  /**
   * 第 k 轮：callsTool 时先调一次探针工具再回复（落四条），否则直接回复（落两条）。compresses 时这一轮结束该触发一次后台
   * 压缩，等它报出 start 与 error（或 done）再往下，不靠压缩在几个任务之内报出
   */
  const ask = async (k: number, { callsTool = false, compresses = false } = {}) => {
    turn = k;
    toolPending = callsTool;
    const reported = statuses.length;
    await host.agent.use.handleMessage({ content: `问题 ${k}`, sessionId: SESSION, platform: 'webui', userId: 'u1' });
    if (compresses) await expect.poll(() => statuses.length).toBe(reported + 2);
  };
  return { ask, conversation, summaryTurns, statuses, logs, summarizer };
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

it('压成之后到下一次压缩之间：摘要块与保留的原文紧接在系统提示之后，每轮在同一位置逐字相同；下一次压成那一轮只共享系统提示', async () => {
  // 保留上限是这次新压的对话的一半，短消息编得上号
  const { ask, conversation, summaryTurns, statuses, summarizer } = await boot({ summaryBudgetRatio: 0.5 });
  // 第 10 轮结束时到线、没压成，第 11 轮丢一段；第 12 轮退避期满再试：丢掉一段之后条数一维仍判得出该压缩
  for (let k = 1; k <= 11; k++) await ask(k, { compresses: k === 10 });
  let summaries = 0;
  summarizer.reply = () => `【保留原文】#2 #5\n【目标】zz-summary-${++summaries}`;
  let release!: () => void;
  summarizer.hold = new Promise<void>(r => (release = r));
  await ask(12);
  await expect.poll(() => summaryTurns).toEqual([10, 12]);
  // 压缩进行中的一轮在切分点之后，落定后仍是活跃历史
  await ask(13);
  release();
  await expect.poll(() => statuses).toEqual(['start', 'error', 'start', 'done']);
  summarizer.hold = undefined;
  // 压成后第 k 轮开头活跃条数为 2k − 22（两条保留的原文、第 13 轮的两条、分隔标记与这一轮的入站消息起算）：第 21 轮结束时到线
  for (let k = 14; k <= 24; k++) await ask(k, { compresses: k === 21 });

  expect(summaryTurns).toEqual([10, 12, 21]);
  expect(statuses).toEqual(['start', 'error', 'start', 'done', 'start', 'done']);
  // 第 14 到 21 轮相邻的请求，前一次的系统提示与历史是后一次的前缀：摘要块与保留的原文每轮在同一位置、逐字相同
  expect(droppedTurns(conversation)).toEqual([11, 14, 22]);
  // 起点回到 0：系统提示 → 摘要块 → 保留的原文（第 2 个单位是第 1 轮的回复，第 5 个是第 3 轮的提问）→ 切分点之后的第 13 轮
  // → 当前消息
  const first = conversation.find(r => r.turn === 14)!.body;
  expect(first.messages.map(m => m.role)).toEqual([
    'system',
    'system',
    'assistant',
    'user',
    'user',
    'assistant',
    'user',
  ]);
  expect(first.messages[1].content).toBe(
    '以下是之前对话的摘要，包含了较早的对话上下文。压缩时原样保留的原文（如果有）按原来的时间顺序排在之后的历史开头，内容已在摘要里概括过：\n【目标】zz-summary-1',
  );
  expect(first.messages[2].content).toBe('回答 1');
  expect(String(first.messages[3].content)).toMatch(/问题 3$/);
  expect(String(first.messages[4].content)).toMatch(/问题 13$/);
  expect(first.messages[5].content).toBe('回答 13');
  expect(String(first.messages[6].content)).toMatch(/问题 14$/);
});

it('历史按 token 超出裁剪预算、压缩一直没压成：按单位（预算的四分之一）成段丢，两次丢弃之间开头逐字不变，系统提示不变', async () => {
  const { app } = hostedApp({ logLevel: 'warn' });
  apps.push(app);
  await registerHubs(app);
  // 摘要请求一律回 500：没压成的压缩不改历史，不用等它落定
  const conversation: Sent[] = [];
  let summaries = 0;
  let turn = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ChatBody;
    if (String(body.messages[0]?.content).startsWith('你是对话摘要助手')) {
      summaries++;
      return new Response(JSON.stringify({ error: { message: 'zz-summary-down' } }), { status: 500 });
    }
    conversation.push({ turn, body });
    return sse({ content: `回答 ${turn} ${'y'.repeat(200)}` });
  }) as typeof fetch;
  // 窗口 4096、输出上限 1024：裁剪预算 2560，单位 640；每轮一问一答约 140，系统提示约 300，第 17 轮起超预算
  await app.plugin(openaiPlugin, {
    apiKey: 'zz-key',
    baseUrl: 'https://llm.invalid/v1',
    customModels: 'gpt-4o',
    discoverModels: false,
    contextLength: 4096,
    maxTokens: 1024,
  });
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'zz cache bot' });
  await app.plugin(memorySummary, {});
  await app.plugins.idle();
  for (const plugin of [openaiPlugin, agentPlugin, memorySummary]) {
    expect(app.plugins.getPlugin(plugin.name)?.state, `${plugin.name} 未激活`).toBe('active');
  }
  const host = app.bind({ agent, events });
  const usages: Array<{ turn: number; event: TokenUsageEvent }> = [];
  host.events.use.on('token:usage', event => void usages.push({ turn, event }));
  for (let k = 1; k <= 30; k++) {
    turn = k;
    await host.agent.use.handleMessage({
      content: `问题 ${k} ${'x'.repeat(200)}`,
      sessionId: SESSION,
      platform: 'webui',
      userId: 'u1',
    });
  }

  // 每轮丢掉的历史：没裁剪的历史减去发出的历史（同一份估算）。只在丢弃的那一轮涨，每次涨过下一个单位的整数倍（丢到累计第一次
  // 达到 k 个单位的那一条）：一次一大段，不是逐条
  const unit = Math.ceil(usages[0].event.tokenBudget / 4);
  const cut = usages.map(({ event }) => event.untrimmedHistory - event.breakdown.history - event.breakdown.toolResults);
  const drops = usages.flatMap(({ turn }, i) => (cut[i] !== (cut[i - 1] ?? 0) ? [turn] : []));
  for (let i = 1; i < cut.length; i++) {
    const crossed = Math.floor(cut[i] / unit) > Math.floor(cut[i - 1] / unit);
    const why = `第 ${usages[i].turn} 轮累计丢掉 ${cut[i]}，此前 ${cut[i - 1]}`;
    expect(cut[i] === cut[i - 1] || crossed, why).toBe(true);
  }
  expect(drops.length).toBeGreaterThanOrEqual(3);
  expect(drops.length, '两次丢弃之间隔着几轮').toBeLessThan(30 - drops[0]);
  // 发出的开头只在丢弃的那几轮变（只共享系统提示），其余各轮以上一轮的系统提示与历史为前缀；系统提示一直不变
  expect(droppedTurns(conversation)).toEqual(drops);
  expect(new Set(conversation.map(({ body }) => JSON.stringify(body.messages[0]))).size).toBe(1);
  expect(summaries, '压缩试过、都没压成').toBeGreaterThan(0);
});

it('插入与排队：同一轮插入之后，下一次请求以上一次请求为前缀；排队开的 T2（其中又有插入）与之后的 T3，各以上一轮最后一次请求（除去说明块）为前缀', async () => {
  const { app } = hostedApp({ logLevel: 'warn' });
  apps.push(app);
  await registerHubs(app);
  // 第 n 次对话请求：第 1、3 次调一次探针工具，其余回答；holds 里有的那一次停住，直到放行
  const sent: ChatBody[] = [];
  const holds = new Map<number, { entered: () => void; release: Promise<void> }>();
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ChatBody;
    const n = sent.push(body);
    const hold = holds.get(n);
    if (hold) {
      hold.entered();
      await hold.release;
    }
    if (n === 1 || n === 3) {
      return sse({ tool_calls: [{ index: 0, id: `call-${n}`, function: { name: PROBE, arguments: '{}' } }] });
    }
    return sse({ content: `回答 ${n}` });
  }) as typeof fetch;
  /** 停住第 n 次对话请求 */
  const hold = (n: number) => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => (entered = resolve));
    holds.set(n, { entered, release: new Promise<void>(resolve => (release = resolve)) });
    return { entered: reached, release };
  };
  await app.plugin(openaiPlugin, {
    apiKey: 'zz-key',
    baseUrl: 'https://llm.invalid/v1',
    customModels: 'gpt-4o',
    discoverModels: false,
  });
  for (const plugin of [toolsPlugin, memoryInMemory]) await app.plugin(plugin, {});
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'zz cache bot' });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
  const host = app.bind({ agent, tools });
  /** 探针每次执行先等 gates 里排着的那一个 */
  const gates: Array<{ entered: () => void; release: Promise<void> }> = [];
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => {
      const gate = gates.shift();
      if (gate) {
        gate.entered();
        await gate.release;
      }
      return 'ok';
    },
  });
  const inTool = () => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => (entered = resolve));
    gates.push({ entered, release: new Promise<void>(resolve => (release = resolve)) });
    return { entered: reached, release };
  };
  const say = (content: string) =>
    host.agent.use.handleMessage({ content, sessionId: SESSION, platform: 'webui', userId: 'u1' });
  const settle = () => new Promise(resolve => setImmediate(resolve));

  // T1：第 1 次请求调工具，工具里时问题 2 到达、插进第 2 次请求；第 2 次请求进行中问题 3 到达、排到 T2
  const tool1 = inTool();
  const reply1 = hold(2);
  const t1 = say('问题 1');
  await tool1.entered;
  const q2 = say('问题 2');
  await settle();
  tool1.release();
  await reply1.entered;
  // T2：问题 3 开轮，第 3 次请求调工具，工具里时问题 4 到达、插进第 4 次请求
  const tool2 = inTool();
  const q3 = say('问题 3');
  await settle();
  reply1.release();
  await tool2.entered;
  const q4 = say('问题 4');
  await settle();
  tool2.release();
  await Promise.all([t1, q2, q3, q4]);
  // T3
  await say('问题 5');

  // 插进来的排在工具结果之后；排队开的 T2 前面是上一轮进行期间到的说明
  expect(sent.map(body => body.messages.map(m => m.role).join(' '))).toEqual([
    'system user',
    'system user assistant tool user',
    'system user assistant tool user assistant system user',
    'system user assistant tool user assistant system user assistant tool user',
    'system user assistant tool user assistant user assistant tool user assistant user',
  ]);
  const rests = sent.map(({ messages: _, ...rest }) => JSON.stringify(rest));
  expect(new Set(rests).size).toBe(1);
  // 同一轮里：插入之后的请求以上一次请求整个为前缀
  for (const [before, after] of [
    [0, 1],
    [2, 3],
  ]) {
    expect(sharedPrefix(lines(sent[before]), lines(sent[after])), `第 ${after + 1} 次请求`).toBe(
      sent[before].messages.length,
    );
  }
  // 下一轮：上一轮最后一次请求去掉说明块（排着的消息开的一轮前面那句，不落库）整个是前缀，输入的时间标注取归档时刻，进历史后
  // 不变
  const note = (m: ApiMessage) => m.role === 'system' && String(m.content).includes('上一轮进行期间到的');
  for (const [before, after] of [
    [1, 2],
    [3, 4],
  ]) {
    const kept = { ...sent[before], messages: sent[before].messages.filter(m => !note(m)) };
    expect(sharedPrefix(lines(kept), lines(sent[after])), `第 ${after + 1} 次请求`).toBe(kept.messages.length);
  }
});
