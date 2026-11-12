import { afterEach, describe, expect, it } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { type ChatModelRequest, estimateMsgTokens, estimateTextTokens, llm } from '../../packages/api-llm/src/index.js';
import { compression, compressionDue, type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import { SQLiteMemoryService } from '../../packages/plugin-memory-sqlite/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import {
  budgetOf,
  conversationOf,
  endTurn,
  fakeSummaryLLM,
  requestTokens,
  setupSummary,
  systemOf,
} from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 挑原文：摘要输入里能整体留下的单位（一条不带工具调用的消息，或工具调用连同它的全部结果）按时间编号，开头标
// 「#编号〔约 N token〕」，N 是原样留下要占的 token。摘要模型在【保留原文】后列出要留的编号，落定时这些单位不归档、
// 原样留在活跃历史最前面。保留的合计超过 min(保留上限, 预算 − 摘要) 时从最早的起去掉；摘要仍覆盖全部对话，去掉的只损失
// 原样的细节。分块时上一次请求挑中的原样带进下一次重挑。认不出格式时只用摘要，照常压成。
// 用例把 summaryBudgetRatio 设 0.5：保留上限是这次新压的对话的一半，短消息编得上号。
// ════════════════════════════════════════════════════════════

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

type Reply = (request: ChatModelRequest, index: number) => string | Promise<string>;
interface Limits {
  contextLength?: number;
  maxOutputTokens?: number;
}

/** 记下告警与调试日志的 logger */
function recordingLogger() {
  const warns: string[] = [];
  const debugs: string[] = [];
  const logger: Logger = {
    debug: (...args: unknown[]) => void debugs.push(args.map(String).join(' ')),
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  return { logger, warns, debugs };
}

async function setup(reply: Reply, limits: Limits = {}, config: Record<string, unknown> = {}) {
  const llm = fakeSummaryLLM({ ...limits, reply });
  const { logger, warns, debugs } = recordingLogger();
  const env = await setupSummary({ summaryBudgetRatio: 0.5, ...config }, llm.model, logger);
  apps.push(env.app);
  const statuses: string[] = [];
  env.host.events.use.on('session:compressing', info => void statuses.push(info.status));
  return { ...env, llm, warns, debugs, statuses };
}

const call = (id: string) => ({ id, type: 'function' as const, function: { name: `probe_${id}`, arguments: '{}' } });
const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });
const calling = (...ids: string[]): Message => ({ role: 'assistant', content: '', toolCalls: ids.map(call) });
const result = (id: string, content = `结果 ${id}`): Message => ({ role: 'tool', toolCallId: id, content });

async function seed(memory: MemoryService, messages: Message[]): Promise<void> {
  for (const m of messages) await memory.saveMessage('s', m);
}

/** 原样留下要占的 token */
const cost = (...messages: Message[]) => messages.reduce((sum, m) => sum + estimateMsgTokens(m), 0);
/** 有编号的单位在摘要输入里的写法 */
const labeled = (id: number, text: string, ...messages: Message[]) => `#${id}〔约 ${cost(...messages)} token〕${text}`;
/**
 * 每次请求放对话的字数（容量），从一次带已有摘要 previous 的请求倒推：(窗口 − 物理上限 − 输出上限) / 2，减去系统提示与请求里的
 * 固定文字
 */
function capacityOf(request: ChatModelRequest, previous: string, contextLength: number, physical: number): number {
  const fixed = String(request.messages[1].content).length - previous.length - conversationOf(request).length;
  return Math.floor((contextLength - physical - (request.maxTokens ?? 0)) / 2) - systemOf(request).length - fixed;
}

/** 活跃历史的形状：角色加正文，工具组首写调用的 id，工具结果写对应的 id */
const shapes = async (memory: MemoryService) =>
  (await memory.getHistory('s', Infinity)).map(m =>
    m.toolCalls?.length ? `${m.role}:${m.toolCalls.map(c => c.id).join()}` : `${m.role}:${m.toolCallId ?? m.content}`,
  );
const summaryOf = async (memory: MemoryService) => (await memory.getMetadata('summary', 's'))?.summary;
const MARKER = 'system:对话已压缩';
/** 一条长回复：原样留下要占的超过保留上限，编不上号；它让这次的输入大到短消息与小工具组都编得上号 */
const TAIL = `答完${'。'.repeat(200)}`;

/** 摘要模型挂在闸门上：放行前可以往会话里写消息 */
function gated(reply: string) {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  return {
    release,
    reply: async () => {
      await gate;
      return reply;
    },
  };
}

describe('plugin-memory-summary: 单位与编号', () => {
  it('有编号的单位开头标「#编号〔约 N token〕」，从 1 起连续；工具组只有组首一行带编号；不齐的组、单独的工具结果（组后落单的也是）、原样留下超过保留上限的单位没有编号', async () => {
    const { memory, compression, llm } = await setup(() => '【保留原文】无\n【目标】SUMMARY-BODY');
    const huge = result('d', '长'.repeat(3000));
    const messages = [
      user('第一问'),
      calling('a'),
      result('a'),
      calling('b', 'c'),
      result('b'),
      user('第二问'),
      calling('e'),
      result('e'),
      result('x'),
      user('第三问'),
      result('y'),
      calling('d'),
      huge,
      assistant('回答'),
    ];
    await seed(memory, messages);

    await compression.compress('s', { reason: 'manual' });

    expect(llm.requests).toHaveLength(1);
    expect(conversationOf(llm.requests[0])).toBe(
      [
        labeled(1, '用户: 第一问', messages[0]),
        labeled(2, '助手: 调用 probe_a({})', messages[1], messages[2]),
        '工具结果(probe_a): 结果 a',
        '助手: 调用 probe_b({})、probe_c({})',
        '工具结果(probe_b): 结果 b',
        labeled(3, '用户: 第二问', messages[5]),
        labeled(4, '助手: 调用 probe_e({})', messages[6], messages[7]),
        '工具结果(probe_e): 结果 e',
        '工具结果: 结果 x',
        labeled(5, '用户: 第三问', messages[9]),
        '工具结果: 结果 y',
        '助手: 调用 probe_d({})',
        `工具结果(probe_d): ${'长'.repeat(200)}…`,
        labeled(6, '助手: 回答', messages[13]),
      ].join('\n'),
    );
  });

  it('按时间戳读历史的存储把别的消息排进了工具调用组：组首连同它的结果是一个单位、编得上号，夹进来的另成一个排在组后；留下这一组时夹进来的照常归档', async () => {
    const { memory, compression, llm } = await setup(() => '【保留原文】#2\n【目标】S');
    // 存储的次序就是按时间戳读回的次序：夹进来的排在调用与结果之间
    const messages = [user('第一问'), calling('a'), user('<夹进来>'), result('a'), assistant('回答'), assistant(TAIL)];
    await seed(memory, messages);

    await compression.compress('s', { reason: 'manual' });

    expect(conversationOf(llm.requests[0])).toBe(
      [
        labeled(1, '用户: 第一问', messages[0]),
        labeled(2, '助手: 调用 probe_a({})', messages[1], messages[3]),
        '工具结果(probe_a): 结果 a',
        labeled(3, '用户: <夹进来>', messages[2]),
        labeled(4, '助手: 回答', messages[4]),
        `助手: ${TAIL}`,
      ].join('\n'),
    );
    expect(await shapes(memory)).toEqual(['assistant:a', 'tool:a', MARKER]);
  });

  const SUMMARY = '【目标】S';
  it('文字超过每次请求容量一半的单位切成几段，每段不超过容量的一半，都没有编号；之后的单位接着编号', async () => {
    const { memory, compression, llm } = await setup(() => `【保留原文】无\n${SUMMARY}`, {
      contextLength: 6000,
      maxOutputTokens: 1024,
    });
    const long = user(`长消息${'甲'.repeat(3000)}完`);
    await seed(memory, [user('前一问'), long, user('后一问')]);

    await compression.compress('s', { reason: 'manual' });

    expect(llm.requests.length).toBeGreaterThan(2);
    const capacity = capacityOf(llm.requests[1], SUMMARY, 6000, 1024);
    const lines = llm.requests.flatMap(request => conversationOf(request).split('\n'));
    const pieces = lines.filter(line => line.includes('甲'));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.startsWith('#')).toBe(false);
      expect(piece.length).toBeLessThanOrEqual(Math.floor(capacity / 2));
    }
    expect(pieces.join('')).toBe(`用户: ${long.content}`);
    expect(lines).toContain(labeled(1, '用户: 前一问', user('前一问')));
    expect(lines).toContain(labeled(2, '用户: 后一问', user('后一问')));
  });

  it('原文不超过容量的一半、加上标注之后超过一半的单位不编号，照常压成', async () => {
    const { memory, compression, llm, statuses } = await setup(() => `【保留原文】无\n${SUMMARY}`, {
      contextLength: 4096,
      maxOutputTokens: 512,
    });
    // 物理上限 512 把预算压到 341；这次新压的对话不小于 682 token 时保留上限也是 341：两次压缩的系统提示一样长，容量相同
    const filler = assistant('。'.repeat(500));
    await memory.saveMetadata('summary', 's', { summary: SUMMARY });
    await seed(memory, [filler]);
    await compression.compress('s', { reason: 'manual' });
    const half = Math.floor(capacityOf(llm.requests[0], SUMMARY, 4096, 512) / 2);
    // 原文恰好是容量的一半
    const probe = user('x'.repeat(half - '用户: '.length));
    await seed(memory, [probe, filler]);
    const asked = llm.requests.length;

    await compression.compress('s', { reason: 'manual' });

    const lines = llm.requests.slice(asked).flatMap(request => conversationOf(request).split('\n'));
    expect(lines).toContain(`用户: ${probe.content}`);
    expect(statuses).toEqual(['start', 'done', 'start', 'done']);
  });

  it('容量恰为 4 时照常压成：大单位切成至多 2 个码元的段，代理对不拆开；容量为 3 时以「装不下」拒绝', async () => {
    const content = '😀'.repeat(20);
    const boot = async (contextLength: number) => {
      const env = await setup(() => `【保留原文】无\n${SUMMARY}`, { contextLength, maxOutputTokens: 512 });
      await env.memory.saveMetadata('summary', 's', { summary: SUMMARY });
      await seed(env.memory, [user(content)]);
      return env;
    };
    const wide = await boot(8192);
    await wide.compression.compress('s', { reason: 'manual' });
    // 窗口不小于 2048 时物理上限是 512、预算是 341：窗口每少 2，容量少 1
    const windowAt = (capacity: number) => 8192 - 2 * (capacityOf(wide.llm.requests[0], SUMMARY, 8192, 512) - capacity);
    expect(windowAt(3)).toBeGreaterThanOrEqual(2048);

    const four = await boot(windowAt(4));
    await four.compression.compress('s', { reason: 'manual' });
    const pieces = four.llm.requests.map(conversationOf);
    expect(pieces.join('')).toBe(`用户: ${content}`);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(2);
    expect(four.statuses).toEqual(['start', 'done']);

    const three = await boot(windowAt(3));
    await expect(three.compression.compress('s', { reason: 'manual' })).rejects.toThrow('装不下');
  });
});

describe('plugin-memory-summary: 保留原文', () => {
  // 编号：问一 #1，工具组 #2，答一 #3，问二 #4；末尾的长回复没有编号
  const conversation = [user('问一'), calling('a'), result('a'), assistant('答一'), user('问二'), assistant(TAIL)];

  it.each([
    ['在第一行', '【保留原文】#2 #4\n【目标】SUMMARY-BODY'],
    ['在末尾', '【目标】SUMMARY-BODY\n【保留原文】#2 #4'],
  ])('回「【保留原文】#2 #4」%s：这两个单位（工具组整组）原样留在活跃历史最前面，之后是切分点之后的消息与分隔标记；存下的摘要不含保留段', async (_label, reply) => {
    const model = gated(reply);
    const { memory, compression, llm, statuses } = await setup(model.reply);
    await seed(memory, conversation);
    const done = compression.compress('s', { reason: 'manual' });
    await expect.poll(() => llm.requests.length).toBe(1);
    await memory.saveMessage('s', user('压缩期间的提问'));
    model.release();
    await done;

    expect(await shapes(memory)).toEqual(['assistant:a', 'tool:a', 'user:问二', 'user:压缩期间的提问', MARKER]);
    expect(await summaryOf(memory)).toBe('【目标】SUMMARY-BODY');
    expect(statuses).toEqual(['start', 'done']);
  });

  it('列了这次请求里没有的编号：丢掉它（记一条调试日志），其余照留', async () => {
    const { memory, compression, debugs } = await setup(() => '【保留原文】#4 #99\n【目标】SUMMARY-BODY');
    await seed(memory, conversation);

    await compression.compress('s', { reason: 'manual' });

    expect(await shapes(memory)).toEqual(['user:问二', MARKER]);
    expect(debugs.filter(line => line.includes('1 个不在这次的输入里'))).toHaveLength(1);
  });

  it('没有【保留原文】：整份当摘要用、全部归档，报 done，记一条告警；不算没压成，下一次到线照常压', async () => {
    const { host, memory, llm, warns, statuses } = await setup(() => '【目标】SUMMARY-BODY');
    await seed(memory, conversation);
    const due = { used: 900, compressible: 500 };

    await endTurn(host, 's', due);
    await expect.poll(() => statuses).toEqual(['start', 'done']);
    expect(await shapes(memory)).toEqual([MARKER]);
    expect(await summaryOf(memory)).toBe('【目标】SUMMARY-BODY');
    expect(warns.filter(line => line.includes('没有按格式列出保留原文的编号'))).toHaveLength(1);

    await seed(memory, [user('又一问')]);
    await endTurn(host, 's', due);
    await expect.poll(() => statuses).toEqual(['start', 'done', 'start', 'done']);
    expect(llm.requests).toHaveLength(2);
  });

  it('这次请求里一个编号都没有（summaryBudgetRatio 为 0）：回复没有【保留原文】时不告警', async () => {
    const { memory, compression, warns } = await setup(() => '【目标】SUMMARY-BODY', {}, { summaryBudgetRatio: 0 });
    await seed(memory, conversation);

    await compression.compress('s', { reason: 'manual' });

    expect(await shapes(memory)).toEqual([MARKER]);
    expect(warns).toEqual([]);
  });

  it('写「无」：全部归档，不告警', async () => {
    const { memory, compression, warns } = await setup(() => '【保留原文】无\n【目标】SUMMARY-BODY');
    await seed(memory, conversation);

    await compression.compress('s', { reason: 'manual' });

    expect(await shapes(memory)).toEqual([MARKER]);
    expect(await summaryOf(memory)).toBe('【目标】SUMMARY-BODY');
    expect(warns.filter(line => line.includes('保留原文'))).toEqual([]);
  });

  it.each([
    ['标题加粗', '**【保留原文】** #2\n【目标】SUMMARY-BODY'],
    ['标题加 Markdown 标题记号', '## 【保留原文】 #2\n【目标】SUMMARY-BODY'],
    ['全角＃', '【保留原文】＃2\n【目标】SUMMARY-BODY'],
    ['小节标题也加了标记', '【保留原文】#2\n## 【目标】SUMMARY-BODY'],
  ])('格式偏差（%s）照样认得', async (_label, reply) => {
    const { memory, compression, warns } = await setup(() => reply);
    await seed(memory, conversation);

    await compression.compress('s', { reason: 'manual' });

    expect(await shapes(memory)).toEqual(['assistant:a', 'tool:a', MARKER]);
    expect(String(await summaryOf(memory))).toMatch(/【目标】SUMMARY-BODY$/);
    expect(warns).toEqual([]);
  });

  it.each([
    ['小节标题写成 Markdown 标题', '【保留原文】#2\n\n## 目标\nSUMMARY-BODY', 2, '## 目标\nSUMMARY-BODY'],
    ['小节标题写成加粗', '【保留原文】#2\n**目标**：SUMMARY-BODY', 2, '**目标**：SUMMARY-BODY'],
    ['没有小节标题', '【保留原文】无\n\nSUMMARY-BODY', 0, 'SUMMARY-BODY'],
    [
      '保留段在末尾、之后还有正文',
      '【目标】SUMMARY-BODY\n【保留原文】#2\n补充：issue #4 已关',
      2,
      '【目标】SUMMARY-BODY\n补充：issue #4 已关',
    ],
  ])('保留段到第一行不只列编号的为止（%s）：之后的各行照常是摘要，照常压成、不告警', async (_label, reply, kept, summary) => {
    const { memory, compression, warns, statuses } = await setup(() => reply);
    await seed(memory, conversation);

    await compression.compress('s', { reason: 'manual' });

    expect(await shapes(memory)).toEqual(kept ? ['assistant:a', 'tool:a', MARKER] : [MARKER]);
    expect(await summaryOf(memory)).toBe(summary);
    expect(warns).toEqual([]);
    expect(statuses).toEqual(['start', 'done']);
  });

  it('保留段在前、摘要正文里写了 #3：正文里的编号不算', async () => {
    const { memory, compression } = await setup(() => '【保留原文】#2\n【目标】跟进 issue #3 的回答');
    await seed(memory, conversation);

    await compression.compress('s', { reason: 'manual' });

    expect(await shapes(memory)).toEqual(['assistant:a', 'tool:a', MARKER]);
    expect(await summaryOf(memory)).toBe('【目标】跟进 issue #3 的回答');
  });

  it('只回了保留段、去掉它之后摘要为空：以「返回了空内容」没压成，什么都不动', async () => {
    const { memory, compression, statuses } = await setup(() => '【保留原文】#2');
    await seed(memory, conversation);

    await expect(compression.compress('s', { reason: 'manual' })).rejects.toThrow('摘要模型返回了空内容');

    expect(await summaryOf(memory)).toBeUndefined();
    expect(await memory.getHistory('s', Infinity)).toHaveLength(conversation.length);
    expect(statuses).toEqual(['start', 'error']);
  });

  it('有两个【保留原文】标题：编号认最后一个，两段都不进存下的摘要', async () => {
    const { memory, compression } = await setup(() => '【保留原文】#4\n【目标】SUMMARY-BODY\n【保留原文】#2');
    await seed(memory, conversation);

    await compression.compress('s', { reason: 'manual' });

    expect(await shapes(memory)).toEqual(['assistant:a', 'tool:a', MARKER]);
    expect(await summaryOf(memory)).toBe('【目标】SUMMARY-BODY');
  });

  it('保留段写了字却没有编号：不保留，记一条告警', async () => {
    const { memory, compression, warns } = await setup(() => '【保留原文】第二条\n【目标】SUMMARY-BODY');
    await seed(memory, conversation);

    await compression.compress('s', { reason: 'manual' });

    expect(await shapes(memory)).toEqual([MARKER]);
    expect(warns.filter(line => line.includes('没认出保留原文的编号'))).toHaveLength(1);
  });
});

describe('plugin-memory-summary: 保留的合计', () => {
  // 五条一样长的消息：保留上限是输入的一半，约两条半
  const five = [1, 2, 3, 4, 5].map(i => user(`第${i}条${'消息正文'.repeat(10)}`));

  it.each([
    ['超过保留上限（输入的一半）', '【目标】SUMMARY-BODY', [3, 4]],
    ['超过预算减去摘要', `【目标】${'摘'.repeat(600)}`, [4]],
  ])('挑中的合计%s：从最早的起去掉，直到不超；去掉的在这次请求的输入里，提示词要求摘要覆盖全部对话', async (_label, summary, kept) => {
    const { memory, compression, llm } = await setup(() => `【保留原文】#1 #2 #3 #4\n${summary}`);
    await seed(memory, five);

    await compression.compress('s', { reason: 'manual' });

    const [request] = llm.requests;
    const input = five.reduce((sum, m) => sum + estimateTextTokens(`用户: ${m.content}`), 0);
    const cap = Math.min(Math.floor(0.5 * input), budgetOf(request) - estimateTextTokens(summary));
    const left = kept.map(i => five[i - 1]);
    // 恰好去到不超为止：再多留前一条就超
    expect(cost(...left)).toBeLessThanOrEqual(cap);
    expect(cost(five[kept[0] - 2], ...left)).toBeGreaterThan(cap);
    expect(await shapes(memory)).toEqual([...left.map(m => `user:${m.content}`), MARKER]);
    for (const m of five.slice(0, 4)) expect(conversationOf(request)).toContain(m.content);
    expect(systemOf(request)).toContain('摘要仍要覆盖全部对话');
  });

  it('保留上限只按这次新压的对话算、不含上一份摘要：上一份摘要很长、新压的是十条短消息时，压完的活跃条数到不了条数线', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => user(`第${i}问`));
    const { memory, compression, llm } = await setup(
      () => `【保留原文】${ten.map((_, i) => `#${i + 1}`).join(' ')}\n【目标】S`,
      {},
      { summaryBudgetRatio: 0.1 },
    );
    // 约 1000 token：算上它时保留上限约 108，十条全编得上号、全留得下
    await memory.saveMetadata('summary', 's', { summary: `【目标】${'旧'.repeat(663)}` });
    await seed(memory, ten);
    const lines = { compressAt: 0.8, historyLimit: 10 };
    const usage = async () => ({
      used: 10,
      contextWindow: 1000,
      tokenBudget: 1000,
      compressible: 10,
      trimmed: false,
      historyMessages: (await memory.getHistory('s', Infinity)).length,
    });
    expect(compressionDue(await usage(), lines)).toBe(true);

    await compression.compress('s', { reason: 'manual' });

    expect(compressionDue(await usage(), lines)).toBe(false);
    const added = ten.reduce((sum, m) => sum + estimateTextTokens(`用户: ${m.content}`), 0);
    expect(systemOf(llm.requests[0])).toContain(`其中保留的原文合计不超过 ${Math.floor(0.1 * added)} tokens`);
  });
});

describe('plugin-memory-summary: 下一次压缩', () => {
  it('上一次留下的单位在这一次输入的开头、重新编号，与新内容一起；这次不选它们就随之归档', async () => {
    const replies = ['【保留原文】#2 #3\n【目标】第一次', '【保留原文】无\n【目标】第二次'];
    const { memory, compression, llm } = await setup((_request, i) => replies[i]);
    const first = [user('问一'), calling('a'), result('a'), user('问二'), assistant(TAIL)];
    await seed(memory, first);
    await compression.compress('s', { reason: 'manual' });
    expect(await shapes(memory)).toEqual(['assistant:a', 'tool:a', 'user:问二', MARKER]);

    await seed(memory, [user('问三'), assistant(TAIL)]);
    await compression.compress('s', { reason: 'manual' });

    expect(conversationOf(llm.requests[1])).toBe(
      [
        labeled(1, '助手: 调用 probe_a({})', first[1], first[2]),
        '工具结果(probe_a): 结果 a',
        labeled(2, '用户: 问二', first[3]),
        labeled(3, '用户: 问三', user('问三')),
        `助手: ${TAIL}`,
      ].join('\n'),
    );
    expect(await shapes(memory)).toEqual([MARKER]);
  });
});

describe('plugin-memory-summary: 分块时带入', () => {
  it('上一次请求挑中的原样（带原编号）排在下一次请求的开头；腾地方时去掉最早的，大单位不会清掉保留的；最终留下最后一次挑中的；每次请求都装得下', async () => {
    // 摘要正文写到物理上限（1024 token，按每字 2 token 折算 512 字），英文字符估算得少，不挤掉保留的原文
    const summary = `【目标】${'x'.repeat(508)}`;
    const a = assistant(`A-${'a'.repeat(438)}`);
    const b = assistant(`B-${'b'.repeat(438)}`);
    const big = user(`big-${'g'.repeat(1500)}`);
    const shorts = Array.from({ length: 40 }, (_, i) => user(`短消息${i}`));
    const last = user('最后一条');
    const lastId = 3 + shorts.length;
    const { memory, compression, llm } = await setup(() => `【保留原文】#1 #2 #${lastId}\n${summary}`, {
      contextLength: 6000,
      maxOutputTokens: 1024,
    });
    await seed(memory, [a, b, big, ...shorts, last]);

    await compression.compress('s', { reason: 'manual' });

    const conversations = llm.requests.map(conversationOf);
    const keptA = labeled(1, `助手: ${a.content}`, a);
    const keptB = labeled(2, `助手: ${b.content}`, b);
    expect(conversations.length).toBeGreaterThan(3);
    expect(conversations[0]).toBe(`${keptA}\n${keptB}`);
    // 第二次放不下 A、B 与大单位的第一段：去掉最早的 A，B 留着
    expect(conversations[1].startsWith(`${keptB}\n用户: big-`)).toBe(true);
    for (const text of conversations.slice(1)) {
      expect(text.startsWith(`${keptB}\n`)).toBe(true);
      expect(text).not.toContain('A-');
    }
    for (const request of llm.requests) expect(requestTokens(request)).toBeLessThanOrEqual(6000);
    expect(conversations.join('\n')).toContain(labeled(lastId, '用户: 最后一条', last));
    expect(await shapes(memory)).toEqual([`assistant:${b.content}`, 'user:最后一条', MARKER]);
  });

  it('后一次没按格式：上一次带进来的保留单位随之归档，它们在这一次的输入里', async () => {
    const replies = ['【保留原文】#1\n【目标】第一块'];
    const { memory, compression, llm, warns } = await setup((_request, i) => replies[i] ?? '【目标】之后', {
      contextLength: 6000,
      maxOutputTokens: 1024,
    });
    const first = user('第一问');
    await seed(memory, [first, ...Array.from({ length: 120 }, (_, i) => user(`第 ${i} 条消息。。。。`))]);

    await compression.compress('s', { reason: 'manual' });

    expect(llm.requests.length).toBeGreaterThan(1);
    expect(conversationOf(llm.requests[1]).startsWith(`${labeled(1, '用户: 第一问', first)}\n`)).toBe(true);
    expect(await shapes(memory)).toEqual([MARKER]);
    expect(warns.filter(line => line.includes('没有按格式列出保留原文的编号')).length).toBeGreaterThan(0);
  });
});

describe('plugin-memory-summary: 挑原文的提示词', () => {
  it('点名四类典型，写明合计预算与保留上限（保留上限 = min(预算, 比例 × 这次新压的对话)）、不必因为是最近几条就保留、摘要仍要覆盖全部对话、编号行在第一行', async () => {
    const { memory, compression, llm } = await setup(
      () => '【保留原文】无\n【目标】S',
      {},
      { summaryBudgetRatio: 0.1 },
    );
    const lines = ['用户: 第一问', '助手: 第一答'];
    await seed(memory, [user('第一问'), assistant('第一答')]);

    await compression.compress('s', { reason: 'manual' });

    const system = systemOf(llm.requests[0]);
    const budget = budgetOf(llm.requests[0]);
    const keepCap = Math.min(budget, Math.floor(0.1 * lines.reduce((sum, line) => sum + estimateTextTokens(line), 0)));
    expect(system).toContain('正在进行的话题、未完成的事项、用户的明确指令、代码或数据原文');
    expect(system).toContain(`摘要与保留的原文合计约 ${budget} tokens`);
    expect(system).toContain(`其中保留的原文合计不超过 ${keepCap} tokens`);
    expect(system).toContain('不必因为是最近几条就保留');
    expect(system).toContain('摘要仍要覆盖全部对话');
    expect(system).toContain('第一行写【保留原文】');
  });

  it('summaryBudgetRatio 为 0：保留上限为 0，没有单位编得上号', async () => {
    const { memory, compression, llm } = await setup(() => '【保留原文】无\n【目标】S', {}, { summaryBudgetRatio: 0 });
    await seed(memory, [user('第一问'), assistant('第一答')]);

    await compression.compress('s', { reason: 'manual' });

    expect(systemOf(llm.requests[0])).toContain('其中保留的原文合计不超过 0 tokens');
    expect(conversationOf(llm.requests[0])).toBe('用户: 第一问\n助手: 第一答');
  });
});

describe('plugin-memory-summary: 落定期间插进一条', () => {
  it('写摘要之后、归档之前，一条晚到的消息时间戳插进了归档段：不归档，摘要回滚到写入前，保留的工具组没被拆开', async () => {
    const store = new SQLiteMemoryService(new DatabaseSync(':memory:'), { logger: { warn() {} } });
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, events, compression });
    host.provide.use(memory, store);
    host.provide.use(llm, fakeSummaryLLM({ reply: () => '【保留原文】#2\n【目标】NEW' }).model);
    await app.plugin(memorySummary, { summaryBudgetRatio: 0.5 });
    await app.plugins.idle();
    await store.saveMetadata('summary', 's', { summary: 'OLD' });
    const seeded = [user('问一'), calling('a'), result('a'), assistant(TAIL)];
    for (const [i, m] of seeded.entries()) await store.saveMessage('s', { ...m, timestamp: 1000 + 10 * i });
    // 压缩写下新摘要之后（回滚再写时不插）
    const save = store.saveMetadata.bind(store);
    let late = true;
    store.saveMetadata = async (namespace, key, data) => {
      await save(namespace, key, data);
      if (late) await store.saveMessage('s', { ...user('晚到'), timestamp: 1005 });
      late = false;
    };

    await expect(host.compression.use.compress('s', { reason: 'manual' })).rejects.toThrow('历史被改动');

    expect(await summaryOf(store)).toBe('OLD');
    expect(await shapes(store)).toEqual(['user:问一', 'user:晚到', 'assistant:a', 'tool:a', `assistant:${TAIL}`]);
  });
});
