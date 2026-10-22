import { afterEach, describe, expect, it } from 'vitest';
import { estimateTextTokens, llm } from '../../packages/api-llm/src/index.js';
import { compression, type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { todoList } from '../../packages/api-todo-list/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
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
// 摘要预算：这次重写的输入（上一份摘要加这次新压的对话，按格式化后的各行估算）× summaryBudgetRatio（默认 0.1），不少于
// 1000；不超过物理上限（摘要模型的输出上限、没声明时 4096，与它窗口的四分之一，取小）的三分之二，与这个会话最近一次用量的
// 压缩线的四分之一（压过下限）。预算写进提示词，请求的输出上限是它的 1.5 倍；摘要模型写满了输出上限的，这次压缩算没压成。
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
    expect(toSource(field?.label)).toBe('摘要预算（占压掉内容的比例）');
  });

  it('是这次重写的输入（上一份摘要加各行的估算）的一成，请求的输出上限是它的 1.5 倍（向上取整）', async () => {
    const llm = fakeSummaryLLM({ contextLength: 200_000, maxOutputTokens: 32_000 });
    const { memory, compression } = await setup({}, llm.model);
    const previous = `【目标】${'旧'.repeat(3000)}`;
    await memory.saveMetadata('summary', 's', { summary: previous });
    const lines = await seed(memory, 's', 121, 100);

    await compression.compress('s', { reason: 'manual' });

    const budget = Math.floor(0.1 * tokensOf([previous, ...lines]));
    expect(budget).toBeGreaterThan(1000);
    expect(llm.requests).toHaveLength(1);
    expect(budgetOf(llm.requests[0])).toBe(budget);
    expect(llm.requests[0].maxTokens).toBe(Math.ceil(1.5 * budget));
  });

  it('输入算上工作模板附的待办那一行', async () => {
    const llm = fakeSummaryLLM({ contextLength: 200_000, maxOutputTokens: 32_000 });
    const { memory, compression, host } = await setup({}, llm.model);
    host.provide.use(todoList, {
      get: async () => [{ id: 1, title: '整理发布清单', status: 'not-started' }],
      clear: async () => {},
    });
    const lines = await seed(memory, 's', 121, 100);

    await compression.compress('s', { reason: 'manual' });

    const rows = [...lines, '当前任务列表状态：\n- [not-started] 整理发布清单'];
    expect(budgetOf(llm.requests[0])).toBe(Math.floor(0.1 * tokensOf(rows)));
  });

  it.each([
    [0.2, (input: number) => Math.floor(0.2 * input)],
    [0, () => 1000],
  ])('summaryBudgetRatio 设 %s：按它算，不少于 1000', async (summaryBudgetRatio, expected) => {
    const llm = fakeSummaryLLM({ contextLength: 200_000, maxOutputTokens: 32_000 });
    const { memory, compression } = await setup({ summaryBudgetRatio }, llm.model);
    const lines = await seed(memory, 's', 121, 100);

    await compression.compress('s', { reason: 'manual' });

    expect(budgetOf(llm.requests[0])).toBe(expected(tokensOf(lines)));
  });

  it.each([
    ['输入小时不少于 1000', { contextLength: 64_000, maxOutputTokens: 8000 }, 1000],
    ['模型输出上限的三分之二压过下限', { contextLength: 64_000, maxOutputTokens: 900 }, 600],
    ['窗口四分之一的三分之二压过下限', { contextLength: 4000, maxOutputTokens: 8000 }, 666],
  ])('%s，输出上限不超过物理上限', async (_label, limits, budget) => {
    const llm = fakeSummaryLLM(limits);
    const { memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 2);

    await compression.compress('s', { reason: 'manual' });

    const [request] = llm.requests;
    expect(budgetOf(request)).toBe(budget);
    expect(request.maxTokens).toBe(Math.ceil(1.5 * budget));
    expect(request.maxTokens).toBeLessThanOrEqual(Math.min(limits.maxOutputTokens, limits.contextLength / 4));
  });

  it('摘要模型没声明输出上限时物理上限按 4096：预算至多 2730', async () => {
    const llm = fakeSummaryLLM({ contextLength: 200_000 });
    const { memory, compression } = await setup({}, llm.model);
    const lines = await seed(memory, 's', 201, 100);

    await compression.compress('s', { reason: 'manual' });

    expect(Math.floor(0.1 * tokensOf(lines))).toBeGreaterThan(2730);
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
  ] as const)('清理%s之后不再按清理前那次用量的压缩线封顶', async (_label, target) => {
    const llm = fakeSummaryLLM({ contextLength: 64_000, maxOutputTokens: 8000 });
    const { host, memory, compression } = await setup({}, llm.model);
    await host.events.use.emit(
      'token:usage',
      usageEvent('s', { used: 1, compressible: 0, contextWindow: 2000, tokenBudget: 2000 }),
    );
    await host.hooks.use.run('memory:clear', { ...target, results: [] });
    await seed(memory, 's', 2);

    await compression.compress('s', { reason: 'manual' });

    expect(budgetOf(llm.requests[0])).toBe(1000);
  });
});

describe('plugin-memory-summary: 写满输出上限', () => {
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
  ])('报的输出 token 不小于输出上限（%s）：这次压缩以「写满了输出上限」没压成，什么都不写', async (_label, stream) => {
    const llm = fakeSummaryLLM({ stream, completionTokens: request => request.maxTokens ?? 0 });
    const { memory, compression, statuses } = await setup({}, llm.model);
    await memory.saveMetadata('summary', 's', { summary: 'OLD-SUMMARY' });
    await seed(memory, 's', 4);

    await expect(compression.compress('s', { reason: 'manual' })).rejects.toThrow('写满了输出上限');

    expect((await memory.getMetadata('summary', 's'))?.summary).toBe('OLD-SUMMARY');
    expect(await memory.getHistory('s', Infinity)).toHaveLength(4);
    expect(statuses).toEqual(['start', 'error']);
  });

  it('报的输出 token 比输出上限少：照常压成', async () => {
    const llm = fakeSummaryLLM({ stream: true, completionTokens: request => (request.maxTokens ?? 0) - 1 });
    const { memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 4);

    await compression.compress('s', { reason: 'manual' });

    expect((await memory.getMetadata('summary', 's'))?.summary).toBe('SUMMARY-TEXT');
  });

  it('后台压缩写满了输出上限：计入退避，隔一轮再试', async () => {
    let full = true;
    const llm = fakeSummaryLLM({ completionTokens: request => (full ? (request.maxTokens ?? 0) : 1) });
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
