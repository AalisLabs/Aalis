import { afterEach, describe, expect, it } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { estimateTextTokens, llm } from '../../packages/api-llm/src/index.js';
import { compression, type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { isTextRef, resolveText, toSource } from '../../packages/schema-i18n/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { budgetOf, endTurn, fakeSummaryLLM, setupSummary, systemOf, usageEvent } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 摘要预算：这个会话最近一次用量的压缩线 × summaryBudgetRatio（默认 0.1），不超过这次要压的内容（上一份摘要加新压的对话，按
// 格式化后的各行估算），这两项合起来不少于 1000；再不超过压缩线的四分之一与物理上限（摘要模型的输出上限、没声明时 4096，与它
// 窗口的四分之一，取小）的三分之二，两者都压过下限。还没有用量、或用量里的数算不出有限的压缩线时，按要压的内容，同样不少于 1000、
// 不超过物理上限的三分之二。保留上限是 min(预算, ⌊比例 × 这次新压的对话⌋)。预算写进提示词，请求的输出上限是它的 1.5 倍；摘要
// 模型报在输出上限处停下（结束原因 length）的，这次压缩算没压成，不按报的用量猜。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(...args: Parameters<typeof setupSummary>) {
  const env = await setupSummary(...args);
  apps.push(env.app);
  const statuses: string[] = [];
  env.host.events.use.on('session:compressing', info => void statuses.push(info.status));
  return { ...env, statuses };
}

/** 写 count 条消息（正文后缀 pad 个「。」），返回它们进摘要输入的各行 */
async function seed(memory: MemoryService, sessionId: string, count: number, pad = 0): Promise<string[]> {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const content = `第 ${i} 条消息${'。'.repeat(pad)}`;
    await memory.saveMessage(sessionId, { role, content });
    lines.push(`${role === 'user' ? '用户' : '助手'}: ${content}`);
  }
  return lines;
}

const tokensOf = (texts: string[]) => texts.reduce((sum, text) => sum + estimateTextTokens(text), 0);
/** 有用量时的压缩线 min(0.8 × 200000, 190000) = 160000：比例项 16000，四分之一 40000 */
const WIDE = { used: 1, compressible: 0, contextWindow: 200_000, tokenBudget: 190_000 };

/** 没有触发的后台压缩不会有任何动静：等几拍再看 */
const settle = () => new Promise<void>(r => setTimeout(r, 20));

describe('plugin-memory-summary: 摘要预算', () => {
  it('设置项 summaryBudgetRatio：0 到 0.5，默认 0.1，标签与说明取自本插件的字典', () => {
    const field = memorySummary.configSchema?.summaryBudgetRatio;
    expect(field).toMatchObject({ type: 'number', default: 0.1, min: 0, max: 0.5 });
    for (const text of [field?.label, field?.description]) {
      if (!isTextRef(text)) throw new Error('标签与说明应是文字对象');
      expect(resolveText(text, ['en'])).not.toBe(toSource(text));
    }
    expect(toSource(field?.label)).toBe('摘要预算');
  });

  it('要压的比压缩线的一成多时是这一成，不随压掉多少变；请求的输出上限是它的 1.5 倍', async () => {
    const llm = fakeSummaryLLM({ contextLength: 200_000, maxOutputTokens: 32_000 });
    const { host, memory, compression } = await setup({}, llm.model);
    for (const id of ['a', 'b']) await host.events.use.emit('token:usage', usageEvent(id, WIDE));
    expect(tokensOf(await seed(memory, 'a', 121, 100))).toBeGreaterThan(16_000);
    await seed(memory, 'b', 201, 100);

    await compression.compress('a', { reason: 'manual' });
    await compression.compress('b', { reason: 'manual' });

    expect(llm.requests.map(budgetOf)).toEqual([16_000, 16_000]);
    expect(llm.requests.map(request => request.maxTokens)).toEqual([24_000, 24_000]);
  });

  it('要压的（上一份摘要加新压的对话）在 1000 与压缩线的一成之间时等于它；保留上限仍按比例乘新压的对话', async () => {
    const llm = fakeSummaryLLM({ contextLength: 200_000, maxOutputTokens: 32_000 });
    const { host, memory, compression } = await setup({}, llm.model);
    await host.events.use.emit('token:usage', usageEvent('s', WIDE));
    const previous = `【目标】${'旧'.repeat(1000)}`;
    await memory.saveMetadata('summary', 's', { summary: previous });
    const lines = await seed(memory, 's', 20, 100);

    await compression.compress('s', { reason: 'manual' });

    const budget = tokensOf([previous, ...lines]);
    expect(budget).toBeGreaterThan(1000);
    expect(budget).toBeLessThan(16_000);
    expect(budgetOf(llm.requests[0])).toBe(budget);
    expect(systemOf(llm.requests[0])).toContain(`其中保留的原文合计不超过 ${Math.floor(0.1 * tokensOf(lines))} tokens`);
  });

  it('要压的不到 1000 时不少于 1000', async () => {
    const llm = fakeSummaryLLM({ contextLength: 200_000, maxOutputTokens: 32_000 });
    const { host, memory, compression } = await setup({}, llm.model);
    await host.events.use.emit('token:usage', usageEvent('s', WIDE));
    await seed(memory, 's', 2);

    await compression.compress('s', { reason: 'manual' });

    expect(budgetOf(llm.requests[0])).toBe(1000);
  });

  it.each([
    [0.2, 32_000],
    [0, 1000],
  ])('summaryBudgetRatio 设 %s：按它乘压缩线，不少于 1000', async (summaryBudgetRatio, budget) => {
    const llm = fakeSummaryLLM({ contextLength: 400_000, maxOutputTokens: 64_000 });
    const { host, memory, compression } = await setup({ summaryBudgetRatio }, llm.model);
    await host.events.use.emit('token:usage', usageEvent('s', WIDE));
    expect(tokensOf(await seed(memory, 's', 121, 200))).toBeGreaterThan(32_000);

    await compression.compress('s', { reason: 'manual' });

    expect(budgetOf(llm.requests[0])).toBe(budget);
  });

  it.each([
    0.1, 0,
  ])('还没有用量时不看比例（设 %s）：按要压的，不少于 1000、不超过物理上限', async summaryBudgetRatio => {
    const llm = fakeSummaryLLM({ contextLength: 64_000, maxOutputTokens: 8000 });
    const { memory, compression } = await setup({ summaryBudgetRatio }, llm.model);
    await seed(memory, 'short', 2);
    const mid = tokensOf(await seed(memory, 'mid', 20, 100));
    expect(tokensOf(await seed(memory, 'long', 40, 100))).toBeGreaterThan(5333);

    for (const id of ['short', 'mid', 'long']) await compression.compress(id, { reason: 'manual' });

    expect(llm.requests.map(budgetOf)).toEqual([1000, mid, 5333]);
  });

  it.each([
    ['裁剪预算', { tokenBudget: Number.NaN }],
    ['窗口', { contextWindow: Number.NaN }],
  ])('用量里的%s不是有限数时按没有用量：预算不出 NaN', { timeout: 5000 }, async (_label, broken) => {
    // 预算是 NaN 时切分不前进、一直请求：第二次请求就抛错，这样的实现也停得下来
    const llm = fakeSummaryLLM({
      contextLength: 64_000,
      maxOutputTokens: 3000,
      reply: (_request, index) => {
        if (index > 0) throw new Error('请求不止一次');
        return 'SUMMARY-TEXT';
      },
    });
    const { host, memory, compression } = await setup({}, llm.model);
    await host.events.use.emit('token:usage', usageEvent('s', { ...WIDE, ...broken }));
    expect(tokensOf(await seed(memory, 's', 20, 100))).toBeGreaterThan(2000);

    await compression.compress('s', { reason: 'manual' });

    expect(llm.requests.map(budgetOf)).toEqual([2000]);
  });

  it.each([
    ['比例乘出来不到 1000 时不少于 1000', { contextLength: 64_000, maxOutputTokens: 8000 }, 1000],
    ['模型输出上限的三分之二压过下限', { contextLength: 64_000, maxOutputTokens: 900 }, 600],
    ['窗口四分之一的三分之二压过下限', { contextLength: 4000, maxOutputTokens: 8000 }, 666],
  ])('%s，输出上限不超过物理上限', async (_label, limits, budget) => {
    const llm = fakeSummaryLLM(limits);
    const { host, memory, compression } = await setup({}, llm.model);
    // 压缩线 8000：比例项 800，四分之一 2000
    await host.events.use.emit(
      'token:usage',
      usageEvent('s', { used: 1, compressible: 0, contextWindow: 10_000, tokenBudget: 10_000 }),
    );
    await seed(memory, 's', 2);

    await compression.compress('s', { reason: 'manual' });

    const [request] = llm.requests;
    expect(budgetOf(request)).toBe(budget);
    expect(request.maxTokens).toBe(Math.ceil(1.5 * budget));
    expect(request.maxTokens).toBeLessThanOrEqual(Math.min(limits.maxOutputTokens, limits.contextLength / 4));
  });

  it('摘要模型没声明输出上限时物理上限按 4096：预算至多 2730', async () => {
    const llm = fakeSummaryLLM({ contextLength: 200_000 });
    const { host, memory, compression } = await setup({}, llm.model);
    await host.events.use.emit('token:usage', usageEvent('s', WIDE));
    expect(tokensOf(await seed(memory, 's', 20, 100))).toBeGreaterThan(2730);

    await compression.compress('s', { reason: 'manual' });

    expect(budgetOf(llm.requests[0])).toBe(2730);
    expect(llm.requests[0].maxTokens).toBe(4095);
  });

  it.each([
    ['压缩线 × 窗口', 2000, 2000, 400],
    ['裁剪预算更小时按裁剪预算', 10_000, 2400, 600],
  ])('不超过这个会话最近一次用量（快照也算）的压缩线的四分之一，压过下限：%s', async (_label, contextWindow, tokenBudget, budget) => {
    const llm = fakeSummaryLLM({ contextLength: 64_000, maxOutputTokens: 8000 });
    const { host, memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 2);
    const wide = { used: 1, compressible: 0, contextWindow: 1_000_000, tokenBudget: 1_000_000 };
    await host.events.use.emit('token:usage', usageEvent('s', wide, { turnId: 'earlier' }));
    await host.events.use.emit(
      'token:usage',
      usageEvent('s', { used: 1, compressible: 0, contextWindow, tokenBudget }),
    );

    await compression.compress('s', { reason: 'manual' });

    expect(budgetOf(llm.requests[0])).toBe(budget);
  });

  it.each([
    ['插件配置设 0.1', { plugins: { [memorySummary.name]: { compressAt: 0.1 } } }, 75],
    ['插件配置设 0 时取裁剪预算', { plugins: { [memorySummary.name]: { compressAt: 0 } } }, 700],
    [
      '会话没有出生平台时按用量的入口平台选平台档',
      { sessionConfig: { platforms: { webui: { [memorySummary.name]: { compressAt: 0.1 } } } } },
      75,
    ],
  ] as const)('压缩线按这个会话的自动压缩线算：%s', async (_label, doc, budget) => {
    const { app, store } = hostedApp(doc);
    apps.push(app);
    await registerHubs(app);
    const summaryLLM = fakeSummaryLLM({ contextLength: 64_000, maxOutputTokens: 8000 });
    const host = app.bind({ provide, events, memory, compression, sessionManager });
    await app.plugin(memoryInMemory);
    await app.plugin(messageArchive, { debugLogs: false });
    await app.plugin(sessionManagerPlugin);
    await app.plugin(sessionSettingsPlugin);
    host.provide.use(llm, summaryLLM.model);
    await registerFromDoc(app, store, memorySummary);
    await app.plugins.idle();
    const sm = host.sessionManager.use;
    const { id } = await sm.createSession({ name: '本机会话' });
    await seed(host.memory.use, id, 2);
    await host.events.use.emit(
      'token:usage',
      usageEvent(id, { used: 1, compressible: 0, contextWindow: 3000, tokenBudget: 2800 }),
    );

    await host.compression.use.compress(id, { reason: 'manual' });

    expect(budgetOf(summaryLLM.requests[0])).toBe(budget);
  });

  it.each([
    ['这个会话', { scope: 'session', sessionId: 's' }],
    ['全部会话', { scope: 'all' }],
  ] as const)('清理%s之后不再按清理前那次用量的压缩线算', async (_label, target) => {
    const llm = fakeSummaryLLM({ contextLength: 64_000, maxOutputTokens: 8000 });
    const { host, memory, compression } = await setup({}, llm.model);
    await host.events.use.emit(
      'token:usage',
      usageEvent('s', { used: 1, compressible: 0, contextWindow: 2000, tokenBudget: 2000 }),
    );
    await host.hooks.use.run('memory:clear', { ...target, results: [] });
    await seed(memory, 's', 2);

    await compression.compress('s', { reason: 'manual' });

    // 按那次用量是压缩线 1600 的四分之一 400
    expect(budgetOf(llm.requests[0])).toBe(1000);
  });
});

describe('plugin-memory-summary: 在输出上限处停下', () => {
  it('摘要模型照提示词的英文字符数写：输出上限比预算宽，写得完、末节完整', async () => {
    // 路径与代码为主的回复按每 3 个字符 1 token 计（比提示词按每 token 4 个字符的换算更密），写到输出上限就截断
    const tail = '【未完成的事】END';
    const llm = fakeSummaryLLM({
      reply: request => {
        const chars = Number(/约 (\d+) 个英文字符/.exec(systemOf(request))?.[1]);
        const body = `【目标】${'src/a.ts:1 f(x);\n'.repeat(chars)}`.slice(0, chars - tail.length);
        return `${body}${tail}`.slice(0, 3 * (request.maxTokens ?? 0));
      },
      completionTokens: (_request, content) => Math.ceil(content.length / 3),
    });
    const { memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 4);

    await compression.compress('s', { reason: 'manual' });

    expect((await memory.getMetadata('summary', 's'))?.summary).toMatch(/【未完成的事】END$/);
  });

  it.each([
    ['一次性回复', false],
    ['流式回复', true],
  ])('报的结束原因是 length（%s）：这次压缩以「在输出上限处停下」没压成，什么都不写', async (_label, stream) => {
    const llm = fakeSummaryLLM({ stream, finishReason: () => 'length' });
    const { memory, compression, statuses } = await setup({}, llm.model);
    await memory.saveMetadata('summary', 's', { summary: 'OLD-SUMMARY' });
    await seed(memory, 's', 4);

    await expect(compression.compress('s', { reason: 'manual' })).rejects.toThrow('在输出上限处停下');

    expect((await memory.getMetadata('summary', 's'))?.summary).toBe('OLD-SUMMARY');
    expect(await memory.getHistory('s', Infinity)).toHaveLength(4);
    expect(statuses).toEqual(['start', 'error']);
  });

  it.each([
    ['一次性回复', false],
    ['流式回复', true],
  ])('报的输出 token 恰等于输出上限、结束原因是 stop（%s）：照常压成，不按用量猜截断', async (_label, stream) => {
    const llm = fakeSummaryLLM({
      stream,
      completionTokens: request => request.maxTokens ?? 0,
      finishReason: () => 'stop',
    });
    const { memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 4);

    await compression.compress('s', { reason: 'manual' });

    expect((await memory.getMetadata('summary', 's'))?.summary).toBe('SUMMARY-TEXT');
  });

  it('后台压缩在输出上限处停下：计入退避，隔一轮再试', async () => {
    let full = true;
    const llm = fakeSummaryLLM({ finishReason: () => (full ? 'length' : 'stop') });
    const { host, memory, statuses } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    const due = { used: 900, compressible: 500 };

    await endTurn(host, 's', due);
    await expect.poll(() => statuses).toEqual(['start', 'error']);
    full = false;
    await endTurn(host, 's', due);
    await settle();
    expect(llm.requests).toHaveLength(1);

    await endTurn(host, 's', due);
    await expect.poll(() => statuses).toEqual(['start', 'error', 'start', 'done']);
  });
});
