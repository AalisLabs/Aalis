import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelRequest, LLMModel } from '../../packages/api-llm/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { App, Logger } from '../../packages/core/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { endTurn, fakeSummaryLLM, setupSummary, startTurn, usageEvent } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 全量压缩：切分点之前的全部活跃历史压成一份摘要，切分点之后到达的消息原样留在活跃历史里。
// 后台压缩在回合结束时按这一轮最后一次调用的用量判定；手动压缩短对话也完整压一次。
// 没压成什么都不动：不写摘要、不归档、不写分隔标记。
// 用量的窗口与裁剪预算缺省都是 1000，默认压缩线 0.8 下有效阈值为 800。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(...args: Parameters<typeof setupSummary>) {
  const env = await setupSummary(...args);
  apps.push(env.app);
  const statuses: string[] = [];
  env.host.events.use.on('session:compressing', info => void statuses.push(`${info.sessionId}:${info.status}`));
  return { ...env, statuses };
}

async function seed(memory: MemoryService, sessionId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await memory.saveMessage(sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条消息` });
  }
}

const active = (memory: MemoryService, sessionId: string) => memory.getHistory(sessionId, Infinity);
const summaryOf = async (memory: MemoryService, sessionId: string) =>
  (await memory.getMetadata('summary', sessionId))?.summary;
const MARKER = { role: 'system', kind: 'event-marker', content: '对话已压缩' };
const shape = (m: Message) => ({ role: m.role, kind: m.kind, content: m.content });
/** 没有触发的后台压缩不会有任何动静：等几拍再看 */
const settle = () => new Promise<void>(r => setTimeout(r, 20));

/** 摘要模型挂在闸门上：放行前可以往会话里写消息、改历史 */
function gatedLLM() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const llm = fakeSummaryLLM({
    reply: async () => {
      await gate;
      return 'SUMMARY-TEXT';
    },
  });
  return { ...llm, release };
}

/** 请求里交给摘要模型的这一块对话（不含提示语与已有摘要） */
const chunkOf = (request: ChatModelRequest) => {
  const content = String(request.messages.at(-1)?.content ?? '');
  return content.slice(content.lastIndexOf('摘要：\n') + 4);
};

/** 一次请求按每字 2 token 折算的输入，加上它的输出上限 */
const requestTokens = (request: ChatModelRequest) =>
  2 * request.messages.reduce((sum, m) => sum + String(m.content ?? '').length, 0) + (request.maxTokens ?? 0);

describe('plugin-memory-summary: 手动压缩', () => {
  it('历史只有 3 条：照常报进度，三条全部进摘要，活跃历史只剩分隔标记', async () => {
    const llm = fakeSummaryLLM();
    const { memory, compression, statuses } = await setup({}, llm.model);
    await seed(memory, 's', 3);

    await compression.compress('s', { reason: 'manual' });

    expect(statuses).toEqual(['s:start', 's:done']);
    for (const i of [0, 1, 2]) expect(llm.text()).toContain(`第 ${i} 条消息`);
    expect(await summaryOf(memory, 's')).toBe('SUMMARY-TEXT');
    expect((await active(memory, 's')).map(shape)).toEqual([MARKER]);
  });

  it('历史为空、或只剩分隔标记时什么都不做，不报进度、不调模型', async () => {
    const llm = fakeSummaryLLM();
    const { memory, compression, statuses } = await setup({}, llm.model);
    await compression.compress('s', { reason: 'manual' });
    expect(statuses).toEqual([]);

    await seed(memory, 's', 2);
    await compression.compress('s', { reason: 'manual' });
    await compression.compress('s', { reason: 'manual' });
    expect(statuses).toEqual(['s:start', 's:done']);
    expect(llm.requests).toHaveLength(1);
    expect((await active(memory, 's')).map(shape)).toEqual([MARKER]);
  });

  it('同一会话正在压缩时再压：拒绝并说明，不另起一次', async () => {
    const llm = gatedLLM();
    const { memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 4);
    const first = compression.compress('s', { reason: 'manual' });
    await expect.poll(() => llm.requests.length).toBe(1);
    await expect(compression.compress('s', { reason: 'manual' })).rejects.toThrow('正在压缩');
    llm.release();
    await first;
    expect(llm.requests).toHaveLength(1);
  });

  it('开始压之前就失败（读不出历史）：拒绝并带原因，不报进度', async () => {
    const { memory, compression, statuses } = await setup();
    vi.spyOn(memory, 'getHistory').mockRejectedValueOnce(new Error('记忆库读不出'));
    await expect(compression.compress('s', { reason: 'manual' })).rejects.toThrow('记忆库读不出');
    expect(statuses).toEqual([]);
  });

  it('压缩期间到达的消息不受影响：落定后仍在活跃历史里，不进这次的摘要', async () => {
    const llm = gatedLLM();
    const { memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 4);
    const done = compression.compress('s', { reason: 'manual' });
    await expect.poll(() => llm.requests.length).toBe(1);
    await memory.saveMessage('s', { role: 'user', content: '压缩期间的提问' });
    await memory.saveMessage('s', { role: 'assistant', content: '压缩期间的回答' });
    llm.release();
    await done;

    expect((await active(memory, 's')).map(m => m.content)).toEqual(['压缩期间的提问', '压缩期间的回答', '对话已压缩']);
    expect(llm.text()).not.toContain('压缩期间');
  });
});

describe('plugin-memory-summary: 切分点', () => {
  const call = (id: string) => ({ id, type: 'function' as const, function: { name: `probe_${id}`, arguments: '{}' } });

  it.each([
    ['只写了 assistant', [] as string[]],
    ['结果只写了一部分', ['a']],
  ])('快照末尾的工具调用组没写全（%s）：切分点退到它之前，它与随后写入的结果都留在活跃历史里', async (_label, before) => {
    const llm = gatedLLM();
    const { memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 3);
    await memory.saveMessage('s', { role: 'assistant', content: '', toolCalls: [call('a'), call('b')] });
    const result = (id: string) => memory.saveMessage('s', { role: 'tool', toolCallId: id, content: `结果 ${id}` });
    for (const id of before) await result(id);

    const done = compression.compress('s', { reason: 'manual' });
    await expect.poll(() => llm.requests.length).toBe(1);
    for (const id of ['a', 'b'].filter(id => !before.includes(id))) await result(id);
    llm.release();
    await done;

    expect((await active(memory, 's')).map(m => [m.role, m.toolCallId ?? m.toolCalls?.map(c => c.id).join()])).toEqual([
      ['assistant', 'a,b'],
      ['tool', 'a'],
      ['tool', 'b'],
      ['system', undefined],
    ]);
    expect(llm.text()).toContain('第 2 条消息');
    expect(llm.text()).not.toContain('probe_a');
  });
});

describe('plugin-memory-summary: 落笔前核对', () => {
  it('压缩期间前缀里的一条被删（回滚）：整次作废，不写摘要、不归档、不写分隔标记，以原因拒绝', async () => {
    const llm = gatedLLM();
    const { memory, compression, statuses } = await setup({}, llm.model);
    for (let i = 0; i < 4; i++) {
      await memory.saveMessage('s', {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${i} 条`,
        timestamp: 1000 + i,
      });
    }
    const done = compression.compress('s', { reason: 'manual' }).then(
      () => 'done',
      (err: Error) => err.message,
    );
    await expect.poll(() => llm.requests.length).toBe(1);
    await memory.deleteMessagesByTimestamps?.('s', [1002]);
    llm.release();

    expect(await done).toContain('历史被改动');
    expect(await summaryOf(memory, 's')).toBeUndefined();
    expect((await active(memory, 's')).map(m => m.content)).toEqual(['第 0 条', '第 1 条', '第 3 条']);
    expect(statuses).toEqual(['s:start', 's:error']);
  });
});

describe('plugin-memory-summary: 没压成', () => {
  const failing: Array<[string, Partial<LLMModel>]> = [
    [
      '抛错',
      {
        async chat() {
          throw new Error('fake timeout');
        },
      },
    ],
    ['返回空白', { chat: async () => ({ content: '  ' }) }],
    [
      '流式中途断开',
      {
        async chat() {
          throw new Error('本用例应走 chatStream');
        },
        async *chatStream() {
          yield { contentDelta: '前半截…' };
          throw new Error('fake stream timeout');
        },
      },
    ],
  ];

  it.each(failing)('摘要模型%s：历史、摘要与分隔标记都不动，以原因拒绝并报 error', async (_label, behavior) => {
    const model = { ...fakeSummaryLLM().model, ...behavior } as LLMModel;
    const { memory, compression, statuses } = await setup({}, model);
    await memory.saveMetadata('summary', 's', { summary: 'GOOD-OLD-SUMMARY' });
    await seed(memory, 's', 6);

    await expect(compression.compress('s', { reason: 'manual' })).rejects.toThrow('摘要模型');

    expect(await summaryOf(memory, 's')).toBe('GOOD-OLD-SUMMARY');
    expect((await active(memory, 's')).map(m => m.content)).toEqual([0, 1, 2, 3, 4, 5].map(i => `第 ${i} 条消息`));
    expect(statuses).toEqual(['s:start', 's:error']);
  });

  it('custom 指向的摘要模型不在：以点名这个模型的原因拒绝并报 error，只记一条告警', async () => {
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
      error() {},
      child: () => logger,
    };
    const { memory, compression, statuses } = await setup(
      { summaryModelMode: 'custom', summaryLLM: { provider: 'gone', model: 'x' } },
      undefined,
      logger,
    );
    await seed(memory, 's', 2);

    await expect(compression.compress('s', { reason: 'manual' })).rejects.toThrow(
      '摘要模型解析失败（gone/x 不存在或未激活）',
    );
    expect(warns.filter(line => line.includes('摘要模型'))).toHaveLength(1);
    expect(statuses).toEqual(['s:start', 's:error']);
  });

  it('流式摘要模型：增量拼成整段摘要', async () => {
    const model = {
      ...fakeSummaryLLM().model,
      async *chatStream() {
        yield { contentDelta: '流式' };
        yield { contentDelta: '摘要' };
      },
    } as LLMModel;
    const { memory, compression } = await setup({}, model);
    await seed(memory, 's', 2);
    await compression.compress('s', { reason: 'manual' });
    expect(await summaryOf(memory, 's')).toBe('流式摘要');
  });
});

describe('plugin-memory-summary: 后台触发', () => {
  it('只认这一轮的用量：不带 turnId 的快照、上一轮留下的用量远超阈值也不触发', async () => {
    const llm = fakeSummaryLLM();
    const { host, memory, statuses } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    const far = { used: 990, compressible: 900 };

    await host.events.use.emit('token:usage', usageEvent('s', far));
    await endTurn(host, 's');
    await host.events.use.emit('token:usage', usageEvent('s', far, { turnId: 'earlier' }));
    await endTurn(host, 's');
    await settle();
    expect(llm.requests).toHaveLength(0);

    await endTurn(host, 's', far);
    await expect.poll(() => statuses).toEqual(['s:start', 's:done']);
  });

  it.each(['aborted', 'error'] as const)('结局为 %s 的回合不判', async outcome => {
    const llm = fakeSummaryLLM();
    const { host, memory } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    await endTurn(host, 's', { used: 990, compressible: 900 }, { outcome });
    await settle();
    expect(llm.requests).toHaveLength(0);
  });

  it('回差：压完后用量仍到线、可压缩部分不到线的一半时不触发；涨到线的一半后再压', async () => {
    const llm = fakeSummaryLLM();
    const { host, memory, statuses } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    await endTurn(host, 's', { used: 900, compressible: 500 });
    await expect.poll(() => statuses).toEqual(['s:start', 's:done']);

    await seed(memory, 's', 2);
    await endTurn(host, 's', { used: 850, compressible: 399 });
    await settle();
    expect(llm.requests).toHaveLength(1);

    await endTurn(host, 's', { used: 850, compressible: 400 });
    await expect.poll(() => statuses).toEqual(['s:start', 's:done', 's:start', 's:done']);
  });

  it('有效阈值：压缩线 × 窗口高于裁剪预算时按裁剪预算判', async () => {
    const llm = fakeSummaryLLM();
    const { host, memory, statuses } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    await endTurn(host, 's', { used: 499, compressible: 400, tokenBudget: 500 });
    await settle();
    expect(statuses).toEqual([]);

    await endTurn(host, 's', { used: 500, compressible: 250, tokenBudget: 500 });
    await expect.poll(() => statuses).toEqual(['s:start', 's:done']);
  });

  // 用量是硬裁剪之后量的：裁剪预算 900、压不掉的部分 100，可压缩部分至多 800，失败之后涨不了多少
  const trimmed = (compressible: number) => ({ used: compressible + 100, compressible, tokenBudget: 900 });

  it('失败不裁切：历史、摘要与分隔标记都不动；之后隔一轮再试，用量已涨到裁剪预算也照样重试并压成', async () => {
    let fail = true;
    const llm = fakeSummaryLLM({
      reply: () => {
        if (fail) throw new Error('fake timeout');
        return 'NEW-SUMMARY';
      },
    });
    const { host, memory, statuses } = await setup({}, llm.model);
    await memory.saveMetadata('summary', 's', { summary: 'OLD-SUMMARY' });
    await seed(memory, 's', 20);

    await endTurn(host, 's', trimmed(750));
    await expect.poll(() => statuses).toEqual(['s:start', 's:error']);
    expect(await active(memory, 's')).toHaveLength(20);
    expect(await summaryOf(memory, 's')).toBe('OLD-SUMMARY');

    fail = false;
    await endTurn(host, 's', trimmed(800));
    await settle();
    expect(llm.requests).toHaveLength(1);

    await endTurn(host, 's', trimmed(800));
    await expect.poll(() => statuses).toEqual(['s:start', 's:error', 's:start', 's:done']);
    expect(await summaryOf(memory, 's')).toBe('NEW-SUMMARY');
    expect((await active(memory, 's')).map(shape)).toEqual([MARKER]);
  });

  it('连续没压成：第 k 次失败之后隔 2 的 k 次方轮再试，封顶 32 轮', async () => {
    const llm = fakeSummaryLLM({
      reply: () => {
        throw new Error('fake timeout');
      },
    });
    const { host, memory } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    const retried: number[] = [];
    for (let turn = 1; turn <= 100; turn++) {
      const before = llm.requests.length;
      await endTurn(host, 's', trimmed(800));
      await settle();
      if (llm.requests.length > before) retried.push(turn);
    }
    expect(retried).toEqual([1, 3, 7, 15, 31, 63, 95]);
  });

  it('压缩落定之前开始、落定之后才结束的一轮不判：它的用量是按压缩之前的历史算的', async () => {
    const llm = gatedLLM();
    const { host, memory, statuses } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    await endTurn(host, 's', { used: 900, compressible: 500 });
    await expect.poll(() => llm.requests.length).toBe(1);

    const during = startTurn(host, 's');
    await memory.saveMessage('s', { role: 'user', content: '压缩期间的提问' });
    await memory.saveMessage('s', { role: 'assistant', content: '压缩期间的回答' });
    llm.release();
    await expect.poll(() => statuses).toEqual(['s:start', 's:done']);
    await during.end({ used: 900, compressible: 500 });
    await settle();
    expect(llm.requests).toHaveLength(1);
    expect((await active(memory, 's')).map(m => m.content)).toEqual(['压缩期间的提问', '压缩期间的回答', '对话已压缩']);

    await endTurn(host, 's', { used: 900, compressible: 500 });
    await expect.poll(() => statuses).toEqual(['s:start', 's:done', 's:start', 's:done']);
  });

  it('这一轮最后一次用量之后、回合结束之前到了一条快照：仍按这一轮的用量判', async () => {
    const llm = fakeSummaryLLM();
    const { host, memory, statuses } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    const turn = startTurn(host, 's');
    await host.events.use.emit(
      'token:usage',
      usageEvent('s', { used: 900, compressible: 500 }, { turnId: turn.turnId }),
    );
    await host.events.use.emit('token:usage', usageEvent('s', { used: 100, compressible: 50 }));
    await turn.end();
    await expect.poll(() => statuses).toEqual(['s:start', 's:done']);
  });

  it('清空之前开始、清空之后才结束的一轮不判：它的用量是按清空之前的历史算的', async () => {
    const llm = fakeSummaryLLM();
    const { host, memory, statuses } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    const turn = startTurn(host, 's');
    await host.hooks.use.run('memory:clear', { scope: 'session', sessionId: 's', results: [] });
    await turn.end({ used: 900, compressible: 500 });
    await settle();
    expect(llm.requests).toHaveLength(0);

    await endTurn(host, 's', { used: 900, compressible: 500 });
    await expect.poll(() => statuses).toEqual(['s:start', 's:done']);
  });

  it.each([
    ['手动压缩压成', 'manual'],
    ['会话级清理（/clear、删除会话）', 'session'],
    ['全局清理', 'all'],
  ] as const)('失败记录在%s之后清掉：下一次到线照常压缩', async (_label, reset) => {
    let fail = true;
    const llm = fakeSummaryLLM({
      reply: () => {
        if (fail) throw new Error('fake timeout');
        return 'NEW-SUMMARY';
      },
    });
    const { host, memory, compression, statuses } = await setup({}, llm.model);
    await seed(memory, 's', 6);
    await endTurn(host, 's', { used: 900, compressible: 500 });
    await expect.poll(() => statuses).toEqual(['s:start', 's:error']);

    fail = false;
    if (reset === 'manual') await compression.compress('s', { reason: 'manual' });
    else await host.hooks.use.run('memory:clear', { scope: reset, sessionId: 's', results: [] });
    await seed(memory, 's', 2);
    const before = llm.requests.length;
    await endTurn(host, 's', { used: 900, compressible: 500 });
    await expect.poll(() => llm.requests.length).toBe(before + 1);
  });
});

describe('plugin-memory-summary: 分块', () => {
  it('输入超过摘要模型的单次容量：逐块增量，上一块的结果作为下一块的已有摘要，每次请求都装得下，最终一份摘要', async () => {
    const llm = fakeSummaryLLM({ contextLength: 3000, maxOutputTokens: 512, reply: (_req, i) => `摘要${i}` });
    const { memory, compression } = await setup({}, llm.model);
    for (let i = 0; i < 30; i++) {
      await memory.saveMessage('s', {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${i} 条消息。。。。。。。。。。`,
      });
    }
    await memory.saveMessage('s', { role: 'user', content: `长消息${'甲'.repeat(1200)}完` });

    await compression.compress('s', { reason: 'manual' });

    const chunks = llm.requests.map(chunkOf);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const request of llm.requests) expect(requestTokens(request)).toBeLessThanOrEqual(3000);
    for (let i = 0; i < 30; i++) {
      expect(
        chunks.filter(chunk => chunk.includes(`第 ${i} 条消息`)),
        `第 ${i} 条`,
      ).toHaveLength(1);
    }
    expect(chunks.join('').match(/甲/g)).toHaveLength(1200);
    expect(chunks.join('')).toContain('完');
    for (let i = 1; i < chunks.length; i++) expect(llm.text(i)).toContain(`以下是之前的对话摘要：\n摘要${i - 1}`);
    expect(await summaryOf(memory, 's')).toBe(`摘要${chunks.length - 1}`);
    expect((await active(memory, 's')).map(shape)).toEqual([MARKER]);
  });

  it('待办参数作为最后一行一起分块：每次请求仍装得下，附的是待摘要部分里最后一次待办的参数', async () => {
    const llm = fakeSummaryLLM({ contextLength: 3000, maxOutputTokens: 512 });
    const { memory, compression } = await setup({}, llm.model);
    const todo = (label: string) => JSON.stringify({ todoList: [{ title: `${label}${'办'.repeat(380)}` }] });
    const todoCall = async (id: string, label: string) => {
      const call = { id, type: 'function' as const, function: { name: 'manage_todo_list', arguments: todo(label) } };
      await memory.saveMessage('s', { role: 'assistant', content: '', toolCalls: [call] });
      await memory.saveMessage('s', { role: 'tool', toolCallId: id, content: 'ok' });
    };
    await todoCall('t1', '旧');
    for (let i = 0; i < 4; i++)
      await memory.saveMessage('s', { role: 'user', content: `第 ${i} 条${'。'.repeat(260)}` });
    await todoCall('t2', '新');

    await compression.compress('s', { reason: 'manual' });

    const chunks = llm.requests.map(chunkOf);
    for (const request of llm.requests) expect(requestTokens(request)).toBeLessThanOrEqual(3000);
    expect(chunks.at(-1)).toContain(`当前任务列表状态：\n${todo('新')}`);
    expect(chunks.join('\n')).not.toContain(todo('旧'));
  });

  it('中间一块失败：整次失败，摘要与历史都不动', async () => {
    const llm = fakeSummaryLLM({
      contextLength: 3000,
      maxOutputTokens: 512,
      reply: (_req, i) => {
        if (i === 1) throw new Error('第二块超时');
        return `摘要${i}`;
      },
    });
    const { memory, compression, statuses } = await setup({}, llm.model);
    await memory.saveMetadata('summary', 's', { summary: 'OLD-SUMMARY' });
    for (let i = 0; i < 60; i++) {
      await memory.saveMessage('s', { role: 'user', content: `第 ${i} 条消息。。。。。。。。。。` });
    }

    await expect(compression.compress('s', { reason: 'manual' })).rejects.toThrow('第二块超时');

    expect(llm.requests).toHaveLength(2);
    expect(await summaryOf(memory, 's')).toBe('OLD-SUMMARY');
    expect(await active(memory, 's')).toHaveLength(60);
    expect(statuses).toEqual(['s:start', 's:error']);
  });

  it('分块途中会话被清空：不再请求后面的块，整次作废', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const llm = fakeSummaryLLM({
      contextLength: 3000,
      maxOutputTokens: 512,
      reply: async (_req, i) => {
        if (i === 0) await gate;
        return `摘要${i}`;
      },
    });
    const { host, memory, compression } = await setup({}, llm.model);
    for (let i = 0; i < 60; i++) {
      await memory.saveMessage('s', { role: 'user', content: `第 ${i} 条消息。。。。。。。。。。` });
    }
    const done = compression.compress('s', { reason: 'manual' }).then(
      () => 'done',
      (err: Error) => err.message,
    );
    await expect.poll(() => llm.requests.length).toBe(1);
    await host.hooks.use.run('memory:clear', { scope: 'session', sessionId: 's', results: [] });
    release();

    expect(await done).toBe('压缩期间会话被清空');
    expect(llm.requests).toHaveLength(1);
  });

  it('每次请求都装得下：输入（提示词、至多输出上限那么多的已有摘要、这一块）加输出上限不超过摘要模型的窗口', async () => {
    // 会话主模型的窗口 100 万，按比例算的输出上限顶到摘要模型的 4096；摘要模型每次都回到输出上限（按每字 2 token 折算）
    const llm = fakeSummaryLLM({
      contextLength: 8192,
      maxOutputTokens: 4096,
      reply: request => '摘'.repeat(Math.floor((request.maxTokens ?? 0) / 2)),
    });
    const { host, memory, compression } = await setup({}, llm.model);
    await host.events.use.emit('token:usage', usageEvent('s', { used: 1, compressible: 0, contextWindow: 1_000_000 }));
    for (let i = 0; i < 60; i++) {
      await memory.saveMessage('s', {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${i} 条消息${'。'.repeat(100)}`,
      });
    }

    await compression.compress('s', { reason: 'manual' });

    expect(llm.requests.length).toBeGreaterThan(1);
    for (const request of llm.requests) expect(requestTokens(request)).toBeLessThanOrEqual(8192);
    expect((await active(memory, 's')).map(shape)).toEqual([MARKER]);
  });

  it('摘要模型的窗口装不下输出上限：拒绝并说明，不调模型', async () => {
    const llm = fakeSummaryLLM({ contextLength: 512, maxOutputTokens: 512 });
    const { memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 2);
    await expect(compression.compress('s', { reason: 'manual' })).rejects.toThrow('装不下');
    expect(llm.requests).toHaveLength(0);
    expect(await active(memory, 's')).toHaveLength(2);
  });
});

describe('plugin-memory-summary: 摘要预算', () => {
  it('输出上限按会话最近一次用量的窗口算比例（快照也记），没有用量时按摘要模型的窗口；下限 512，不超过模型的输出上限', async () => {
    const llm = fakeSummaryLLM({ contextLength: 64_000, maxOutputTokens: 8000 });
    const { host, memory, compression } = await setup({ summaryTokenRatio: 0.01 }, llm.model);
    const windows: Array<[string, number | undefined, number]> = [
      ['wide', 1_000_000, 8000],
      ['narrow', 128_000, 1280],
      ['tiny', 1000, 512],
      ['fresh', undefined, 640],
    ];
    for (const [sessionId, contextWindow] of windows) {
      await seed(memory, sessionId, 2);
      if (contextWindow) {
        await host.events.use.emit('token:usage', usageEvent(sessionId, { used: 1, compressible: 0, contextWindow }));
      }
    }
    for (const [sessionId] of windows) await compression.compress(sessionId, { reason: 'manual' });
    expect(llm.requests.map(r => [r.sessionId, r.maxTokens])).toEqual(windows.map(([s, , budget]) => [s, budget]));
  });

  it('摘要模型没声明输出上限时按 4096 封顶', async () => {
    const llm = fakeSummaryLLM({ contextLength: 64_000 });
    const { host, memory, compression } = await setup({}, llm.model);
    await seed(memory, 's', 2);
    await host.events.use.emit('token:usage', usageEvent('s', { used: 1, compressible: 0, contextWindow: 1_000_000 }));
    await compression.compress('s', { reason: 'manual' });
    expect(llm.requests[0].maxTokens).toBe(4096);
  });
});

describe('plugin-memory-summary: 摘要输入里的通知', () => {
  it('定时任务派来的指令等通知与对话一起进摘要输入、按每条 200 字截断；压缩分隔标记不进', async () => {
    const llm = fakeSummaryLLM();
    const { memory, compression } = await setup({}, llm.model);
    await memory.saveMessage('s', { role: 'system', kind: 'event-marker', content: '对话已压缩' });
    await memory.saveMessage('s', {
      role: 'notice',
      kind: 'cross-session-delegation',
      content: `每天九点整理日报${'甲'.repeat(300)}`,
    });
    await memory.saveMessage('s', { role: 'assistant', content: '日报已整理' });

    await compression.compress('s', { reason: 'manual' });

    expect(llm.text()).toContain(`通知: 每天九点整理日报${'甲'.repeat(192)}…`);
    expect(llm.text()).not.toContain('甲'.repeat(193));
    expect(llm.text()).toContain('助手: 日报已整理');
    expect(llm.text()).not.toContain('对话已压缩');
  });
});
