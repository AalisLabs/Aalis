import { afterEach, describe, expect, it } from 'vitest';
import {
  agent as agentService,
  type PromptContributionView,
  type TokenUsageEvent,
} from '../../packages/api-agent/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type ChatModelRequest, type ChatResponse, estimateMsgTokens } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { type Message, WellKnownKinds } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { callTool, StepModel, stepModelPlugin } from '../fixtures/step-llm.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 硬裁剪（按 token 的那一维）：发出的列表分头部（第一条非 system 之前：人设、技能、摘要等，属于历史的 system 消息不算）、历史与
// 本轮三段。历史超过它的可用量（预算减头部再减一个单位）就按预算的四分之一为单位成段丢，不看本轮多大，切点落在工具调用组中间时
// 整组丢；仍超预算时只动本轮追加的（截短较早的过长工具结果、缩推理、压成摘要，最后一组不动）；仍超时历史接着按单位丢；历史
// 丢完仍超才缩、删注入的 system 块（会改开头）；最后手段截短最后一组里过长的结果、缩它的推理，请求不超窗。本轮的输入一条不删。
// 跨轮的缓存前缀（真的服务商插件）的用例在 agent-history-cache-prefix。
// 模型是窗口 4096、输出上限 1024 的替身：裁剪预算 4096 − 1024 − 512 = 2560，单位 640；系统提示（'test' 加输入约定）约 300。
// 各条消息的正文以尖括号记号开头，后面按要的大小补 x。
// ════════════════════════════════════════════════════════════

const SESSION = 'zz-trim';
const PROBE = 'zz_trim_probe';
const BUDGET = 2560;
/** 历史的时间戳从一小时前起 */
const T0 = Date.now() - 3_600_000;

/** 正文：记号后面补 pad 个 x */
const body = (marker: string, pad = 0) => (pad ? `${marker} ${'x'.repeat(pad)}` : marker);
const user = (marker: string, pad = 0): Message => ({ role: 'user', content: body(marker, pad) });
const reply = (marker: string, pad = 0): Message => ({ role: 'assistant', content: body(marker, pad) });
/** 一组工具调用：调用之后接各个结果 */
const group = (id: string, results: string[]): Message[] => [
  {
    role: 'assistant',
    content: '',
    toolCalls: results.map((_, i) => ({
      id: `${id}-${i}`,
      type: 'function' as const,
      function: { name: PROBE, arguments: '{}' },
    })),
  },
  ...results.map((content, i): Message => ({ role: 'tool', toolCallId: `${id}-${i}`, content })),
];
/** 请求里的一条：带记号的取记号，工具调用组写 call / result，其余写角色 */
const mark = (m: Message) =>
  m.toolCalls?.length
    ? 'call'
    : m.role === 'tool'
      ? 'result'
      : ((typeof m.content === 'string' && m.content.match(/<[^<>\s]+>/)?.[0]) ?? m.role);
/** 请求里 system 以外的各条 */
const turnShape = (request: ChatModelRequest) => request.messages.filter(m => m.role !== 'system').map(mark);
/** 请求的估算（与 agent 同一口径） */
const estimated = (request: ChatModelRequest) => request.messages.reduce((sum, m) => sum + estimateMsgTokens(m), 0);
/** 一次并行调 n 个探针的回复，调用 id 按第 k 次调用区分 */
const parallel = (n: number, k: number): ChatResponse => ({
  content: null,
  toolCalls: Array.from({ length: n }, (_, i) => ({
    id: `p${k}-${i}`,
    type: 'function' as const,
    function: { name: PROBE, arguments: '{}' },
  })),
});
const settle = () => new Promise(resolve => setImmediate(resolve));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(
  decide: (request: ChatModelRequest, n: number) => ChatResponse = (_r, n) => ({ content: `<答${n}>` }),
) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const model = new StepModel(decide, 4096);
  await app.plugin(stepModelPlugin(model));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'test', memoryTokenBudget: 1024 });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
  const host = app.bind({ agent: agentService, tools, memory, contributions, events });
  return {
    host,
    model,
    say: (content: string) =>
      host.agent.use.handleMessage({ content, sessionId: SESSION, platform: 'webui', userId: 'console' }),
    /** 这个会话的一条宿主通知（这一轮的输入是通知块） */
    notice: (content: string) =>
      host.agent.use.handleMessage({
        content,
        sessionId: SESSION,
        platform: 'webui',
        source: 'bg:1',
        hostNotice: { kind: 'background', id: '1' },
      }),
    /** 往这个会话的历史里按先后写几条 */
    seed: async (messages: Message[]) => {
      for (const [i, message] of messages.entries()) {
        await host.memory.use.saveMessage(SESSION, { ...message, timestamp: T0 + i });
      }
    },
    /** 登记探针工具 */
    tool: (handler: () => Promise<string>) =>
      host.tools.use.register({
        definition: {
          type: 'function',
          function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
        },
        handler,
      }),
    /** 一块落在头部 system 区末尾的注入块（同摘要的锚位） */
    headBlock: (text: string) =>
      host.contributions.use.contribute('agent:prompt', { id: 'zz-head', anchor: 'context', build: () => text }),
    /** 一块落在历史之后的本轮材料（同档案、召回的锚位），按这一轮的输入给 */
    turnBlock: (build: (view: PromptContributionView) => string) =>
      host.contributions.use.contribute('agent:prompt', { id: 'zz-turn', anchor: 'turn-context', build }),
  };
}

/** 十条历史，一问一答，每条约 150 */
const TEN = Array.from({ length: 5 }, (_, i) => [user(`<问${i + 1}>`, 500), reply(`<答${i + 1}>`, 500)]).flat();

describe('本轮的输入一条不删', () => {
  it('开轮的与插进来的：排着的两条一起开轮、工具里又插进一条，超预算时三条都在，插进来那条之前的最后一组工具调用也不截短', async () => {
    const s = await boot((_r, n) => (n === 2 ? callTool(PROBE) : { content: `<答${n}>` }));
    await s.seed(TEN);
    const entered = deferred();
    const release = deferred();
    const output = body('<结果>', 2100);
    s.tool(async () => {
      entered.resolve();
      await release.promise;
      return output;
    });
    // 甲那一轮唯一一次调用期间到的乙、丙排到下一轮一起开轮；那一轮停在工具里时丁到达，插进下一次调用
    const held = s.model.hold(1);
    const a = s.say('<甲>');
    await held.entered;
    const b = s.say(body('<乙>', 1400));
    const c = s.say(body('<丙>', 1400));
    await settle();
    held.release();
    await entered.promise;
    const d = s.say(body('<丁>', 1400));
    await settle();
    release.resolve();
    await Promise.all([a, b, c, d]);

    // 第三次调用：乙、丙、丁各约 400，连同约 640 的工具组与历史超过预算；历史按单位丢掉一段即回到预算内
    expect(s.model.requests).toHaveLength(3);
    const third = s.model.requests[2];
    expect(turnShape(third).slice(-5)).toEqual(['<乙>', '<丙>', 'call', 'result', '<丁>']);
    expect(turnShape(third)).not.toContain('<问1>');
    expect(third.messages.find(m => m.role === 'tool')?.content).toBe(output);
  });

  it('宿主通知那一轮的通知块是这一轮的输入：调用工具之后超预算，它不缩', async () => {
    const s = await boot((_r, n) => (n === 1 ? callTool(PROBE) : { content: '<答>' }));
    s.tool(async () => 'x'.repeat(2100));
    const notice = '通'.repeat(1300);
    await s.host.agent.use.handleMessage({
      content: notice,
      sessionId: SESSION,
      platform: 'webui',
      source: 'bg:1',
      hostNotice: { kind: 'background', id: '1' },
    });

    // 通知块约 1960，超过注入块的额度 1024；第二次调用带着工具结果超过预算
    expect(s.model.requests).toHaveLength(2);
    const block = s.model.requests[1].messages.find(m => m.metadata?.injector === 'host-notice');
    expect(block?.content).toBe(`[宿主通知]\n${notice}`);
  });
});

describe('先丢历史，头部的注入块不缩', () => {
  it('历史超出时按单位成段丢，摘要一类的头部块原样发出', async () => {
    const s = await boot();
    const head = '摘'.repeat(700);
    s.headBlock(head);
    await s.seed(TEN);
    await s.say('<问末>');

    // 头部约 1350，历史可用 2560 − 1350 − 640 = 570；十条历史约 1530，超出约 960，丢两个单位（1280）：丢到第九条为止
    const [request] = s.model.requests;
    expect(request.messages.filter(m => m.content === head)).toHaveLength(1);
    expect(turnShape(request)).toEqual(['<答5>', '<问末>']);
  });

  it('本轮超过一个单位：按单位丢过之后仍超，历史接着丢到回到预算内，头部块照样不缩', async () => {
    const s = await boot();
    const head = '摘'.repeat(700);
    s.headBlock(head);
    await s.seed(TEN);
    await s.say(body('<问末>', 3920));

    // 本轮约 1130：丢两个单位后还差约 80，最后一条历史随之丢掉
    const [request] = s.model.requests;
    expect(request.messages.filter(m => m.content === head)).toHaveLength(1);
    expect(turnShape(request)).toEqual(['<问末>']);
  });

  it('头部本身就快占满预算：历史全部丢掉，仍超时才缩注入块', async () => {
    const s = await boot();
    s.headBlock('摘'.repeat(1300));
    await s.seed(TEN);
    await s.say(body('<问末>', 1200));

    // 头部约 2250，历史可用为负，十条全丢；本轮约 350，仍超预算，注入块按额度 1024 缩
    const [request] = s.model.requests;
    expect(turnShape(request)).toEqual(['<问末>']);
    const block = request.messages.find(m => typeof m.content === 'string' && m.content.startsWith('摘'));
    expect(block?.content).toContain('[记忆内容已缩减]');
  });
});

it('切点落在工具调用组中间：组首连同组里剩下的结果一起丢，不截短、不压成摘要', async () => {
  const s = await boot();
  // 历史约 1970：问一约 60、调用约 30、两个结果各约 900、之后三条约 80。本轮约 600，合计超过预算；历史可用约 1620，丢一个单位
  // （640），累计在第一个结果处达到
  await s.seed([
    user('<问1>', 175),
    ...group('h', [body('<结果1>', 3150), body('<结果2>', 3150)]),
    reply('<答1>'),
    user('<问2>', 175),
    reply('<答2>'),
  ]);
  await s.say(body('<问3>', 2100));

  expect(turnShape(s.model.requests[0])).toEqual(['<答1>', '<问2>', '<答2>', '<问3>']);
});

it('本轮较早的过长工具结果照旧截短，最后一组与历史里的工具结果不动', async () => {
  const s = await boot((_r, n) => (n <= 3 ? callTool(PROBE, {}, `call-${n}`) : { content: '<答>' }));
  s.tool(async () => body('<结果>', 2100));
  const old = body('<旧结果>', 2100);
  await s.seed([user('<问1>'), ...group('h', [old]), reply('<答1>')]);
  await s.say('<问2>');

  // 历史约 660，没超出历史可用；第四次调用带着三组各约 640 的工具调用，超过预算，截短本轮第一组的结果即回到预算内
  expect(s.model.requests).toHaveLength(4);
  const results = s.model.requests[3].messages.filter(m => m.role === 'tool').map(m => m.content);
  expect(results).toHaveLength(4);
  expect(results[0]).toBe(old);
  expect(results[1]).toContain('[工具输出已截断]');
  expect(results.slice(2)).toEqual([body('<结果>', 2100), body('<结果>', 2100)]);
});

describe('切点只由头部与历史定', () => {
  it('历史超出可用量时不看本轮多大：本轮材料一轮大一轮小，三轮都从同一条起，用量都报经过了硬裁剪', async () => {
    const s = await boot();
    // 本轮材料落在历史之后：第二轮约 690，其余两轮约 10
    s.turnBlock(view => 'x'.repeat(view.inputs[0]?.message.content === '<问末2>' ? 2400 : 10));
    const usages: TokenUsageEvent[] = [];
    s.host.events.use.on('token:usage', event => void usages.push(event));
    await s.seed([...TEN, user('<问6>', 500), reply('<答6>', 500)]);
    for (const k of [1, 2, 3]) await s.say(`<问末${k}>`);

    // 十二条历史约 1840，可用 2560 − 300 − 640 = 1620，超出不到一个单位：丢到累计达到 640 的那一条（第五条）
    expect(s.model.requests.map(request => turnShape(request)[0])).toEqual(['<答3>', '<答3>', '<答3>']);
    expect(usages.map(usage => usage.trimmed)).toEqual([true, true, true]);
  });

  it('历史开头是一条属于历史的 system 消息（投递失败的记录）：它算历史、不算头部，可用量不因它少算', async () => {
    const s = await boot();
    await s.seed([
      { role: 'system', kind: WellKnownKinds.OutboundDeliveryFailed, content: body('<没发出>', 1400) },
      ...TEN,
    ]);
    await s.say(body('<问末>', 1400));

    // 头部只有系统提示，可用 1620；历史约 1930，超出约 310，丢一个单位：投递失败的记录、问一与答一
    expect(turnShape(s.model.requests[0])[0]).toBe('<问2>');
  });

  it('工具循环里本轮持续超过一个单位：历史接着丢也按单位丢，相邻两次调用的开头一致', async () => {
    const s = await boot((_r, n) => (n <= 2 ? parallel(2, n) : { content: '<答>' }));
    let runs = 0;
    s.tool(async () => body('<结果>', runs++ < 2 ? 1700 : 1900));
    await s.seed(TEN);
    await s.say('<问末>');

    // 十条历史约 1530，没超出可用量。第二次调用带着约 1040 的一组，超出约 330；第三次调用前一组截短、压成摘要（约 90），带着约
    // 1160 的一组，超出约 530：都丢一个单位，切在同一条
    expect(s.model.requests).toHaveLength(3);
    const [, second, third] = s.model.requests.map(turnShape);
    expect(second[0]).toBe('<答3>');
    expect(third[0]).toBe('<答3>');
  });
});

describe('缩推理、压成摘要与继续提示只看本轮', () => {
  it('历史里带长推理的回复与工具调用组原样；本轮较早一组压成摘要、较早的推理缩短，最后一组的推理不动', async () => {
    const thought = (n: number) => `<想${n}> ${'q'.repeat(1400)}`;
    const s = await boot((_r, n) =>
      n <= 3 ? { ...callTool(PROBE, {}, `call-${n}`), reasoningContent: thought(n) } : { content: '<答>' },
    );
    s.tool(async () => body('<结果>', 1400));
    const old = `<旧想> ${'r'.repeat(700)}`;
    const [call, result] = group('h', ['<旧结果>']);
    await s.seed([user('<问1>'), { ...call, reasoningContent: old }, result, reply('<答1>', 1500)]);
    await s.say('<问2>');

    // 第四次调用：历史约 680，本轮三组各约 840，超过预算；缩掉前两组的推理、把第一组压成摘要即回到预算内
    expect(s.model.requests).toHaveLength(4);
    const fourth = s.model.requests[3];
    expect(turnShape(fourth).slice(0, 4)).toEqual(['<问1>', 'call', 'result', '<答1>']);
    expect(fourth.messages.filter(m => m.content?.startsWith('[历史工具调用]'))).toHaveLength(1);
    const thoughts = fourth.messages.flatMap(m => (m.reasoningContent ? [m.reasoningContent] : []));
    expect(thoughts).toHaveLength(3);
    expect(thoughts[0]).toBe(old);
    expect(thoughts[1]).toContain('[推理内容已缩减]');
    expect(thoughts[2]).toBe(thought(3));
  });

  it('删得多时的继续提示紧跟在本轮最后一条输入之后：宿主通知那一轮在通知块之后', async () => {
    const s = await boot();
    s.headBlock('摘'.repeat(1600));
    await s.seed(TEN);
    await s.notice('<通知>');

    // 头部约 2700：十条历史全丢，仍超预算，注入块按额度缩；删了十条，加继续提示
    const [request] = s.model.requests;
    const at = request.messages.findIndex(m => m.metadata?.injector === 'host-notice');
    expect(at).toBeGreaterThan(0);
    expect(request.messages[at + 1]?.content).toMatch(/^\[系统提示\] 由于上下文长度限制/);
  });
});

describe('最后一组本身超预算：最后手段才截短它', () => {
  it('并行的几个大结果：最后一组里过长的结果按同样的阈值截短，五个结果都在，请求回到预算内', async () => {
    const s = await boot((_r, n) => (n === 1 ? parallel(5, n) : { content: '<答>' }));
    s.tool(async () => body('<结果>', 2100));
    await s.say('<问>');

    // 五个结果各约 610，单这一组就超过预算
    expect(s.model.requests).toHaveLength(2);
    const second = s.model.requests[1];
    const results = second.messages.filter(m => m.role === 'tool');
    expect(results).toHaveLength(5);
    expect(results[0].content).toContain('[工具输出已截断]');
    expect(estimated(second)).toBeLessThanOrEqual(BUDGET);
  });

  it('这一组带很长的推理：最后手段缩它的推理（留 400 字），请求回到预算内', async () => {
    const s = await boot((_r, n) =>
      n === 1 ? { ...callTool(PROBE), reasoningContent: `<想> ${'q'.repeat(9000)}` } : { content: '<答>' },
    );
    s.tool(async () => 'ok');
    await s.say('<问>');

    expect(s.model.requests).toHaveLength(2);
    const second = s.model.requests[1];
    expect(second.messages.find(m => m.toolCalls?.length)?.reasoningContent).toContain('[推理内容已缩减]');
    expect(estimated(second)).toBeLessThanOrEqual(BUDGET);
  });
});
