import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type ChatModelRequest, llm } from '../../packages/api-llm/src/index.js';
import { compression, compressionDue, memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { conversationOf, endTurn, fakeSummaryLLM, usageEvent } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 条数线是 agent 按会话解析好、记在这一轮用量事件里的 historyLimit：回合结束时的会话条数（这一轮最后一次调用的用量里会话
// 历史的条数，结局为 replied 时加上之后落库的最终回复）到了它，摘要插件就在后台全量压缩，与用量到线同一条流程、同一套按轮数
// 的失败退避。为 0 时不按条数压缩。设了条数线时，挑中的原文只留到压完的活跃条数（保留的原文、切分点之后的消息与分隔标记）
// 不超过条数线的一半（向下取整）为止，条数线取这个会话最近一次用量里的。下面的用量都远不到压缩线（窗口与裁剪预算 1000，
// 用量 10）。
// ════════════════════════════════════════════════════════════

const settle = () => new Promise<void>(r => setTimeout(r, 20));
/** 用量远不到压缩线，只有会话条数与这一轮的条数线 */
const counted = (historyMessages: number, historyLimit: number) => ({
  used: 10,
  compressible: 10,
  historyMessages,
  historyLimit,
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(summaryLLM = fakeSummaryLLM()) {
  const { app } = hostedApp();
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, memory, sessionManager, compression });
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  host.provide.use(llm, summaryLLM.model);
  await app.plugin(memorySummary);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(memorySummary.name)?.state, `${memorySummary.name} 未激活`).toBe('active');
  const statuses: string[] = [];
  host.events.use.on('session:compressing', info => void statuses.push(`${info.sessionId}:${info.status}`));
  const sm = host.sessionManager.use;
  const say = (sessionId: string) => host.memory.use.saveMessage(sessionId, { role: 'user', content: '在吗' });
  return { host, sm, summaryLLM, statuses, say };
}

describe('plugin-memory-summary: 条数线', () => {
  it('回合结束时的会话条数含落库的最终回复：结局为 replied 时最后一次调用的条数加一，静默的一轮不加', async () => {
    const { host, sm, statuses, say } = await setup();
    const owner = await sm.createSession({ name: '本机会话' });
    await say(owner.id);

    await endTurn(host, owner.id, counted(4, 5), { outcome: 'silent' });
    await settle();
    expect(statuses).toEqual([]);

    await endTurn(host, owner.id, counted(4, 5), { outcome: 'replied' });
    await expect.poll(() => statuses).toEqual([`${owner.id}:start`, `${owner.id}:done`]);
  });

  it('条数线为 0：会话条数再多也不按条数压缩', async () => {
    const { host, sm, summaryLLM, say } = await setup();
    const owner = await sm.createSession({ name: '本机会话' });
    await say(owner.id);
    await endTurn(host, owner.id, counted(600, 0));
    await settle();
    expect(summaryLLM.requests).toHaveLength(0);
  });

  it('条数线取这一轮用量事件里的值：前后两轮的条数线不同时各按各的', async () => {
    const { host, sm, statuses, say } = await setup();
    const owner = await sm.createSession({ name: '本机会话' });
    await say(owner.id);

    await endTurn(host, owner.id, counted(5, 50));
    await settle();
    expect(statuses).toEqual([]);

    await endTurn(host, owner.id, counted(5, 5));
    await expect.poll(() => statuses).toEqual([`${owner.id}:start`, `${owner.id}:done`]);
  });

  it('条数到线而没压成：与用量到线同一套按轮数的退避，隔一轮再试并压成', async () => {
    let fail = true;
    const summaryLLM = fakeSummaryLLM({
      reply: () => {
        if (fail) throw new Error('fake timeout');
        return 'NEW-SUMMARY';
      },
    });
    const { host, sm, statuses, say } = await setup(summaryLLM);
    const owner = await sm.createSession({ name: '本机会话' });
    await say(owner.id);

    await endTurn(host, owner.id, counted(5, 5));
    await expect.poll(() => statuses).toEqual([`${owner.id}:start`, `${owner.id}:error`]);

    fail = false;
    await endTurn(host, owner.id, counted(6, 5));
    await settle();
    expect(summaryLLM.requests).toHaveLength(1);

    await endTurn(host, owner.id, counted(7, 5));
    await expect.poll(() => statuses.slice(2)).toEqual([`${owner.id}:start`, `${owner.id}:done`]);
    expect((await host.memory.use.getMetadata('summary', owner.id))?.summary).toBe('NEW-SUMMARY');
  });
});

describe('plugin-memory-summary: 压完的条数', () => {
  /** 摘要模型把这次请求里编得上号的全留 */
  const keepAll = (request: ChatModelRequest) => {
    const ids = [...conversationOf(request).matchAll(/^#(\d+)〔/gm)].map(match => `#${match[1]}`);
    return `【保留原文】${ids.join(' ') || '无'}\n【目标】S`;
  };
  const user = (content: string): Message => ({ role: 'user', content });
  /** 一条很长的回答：把保留上限（这次新压的对话的一成）撑大到下面的短消息与工具组全编得上号，它自己编不上号 */
  const answer: Message = { role: 'assistant', content: `答${'长'.repeat(800)}` };
  /** 六条短问与一个工具组，共八条 */
  const seed: Message[] = [
    ...[0, 1, 2, 3, 4, 5].map(i => user(`第${i}问`)),
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'a', type: 'function', function: { name: 'probe', arguments: '{}' } }],
    },
    { role: 'tool', toolCallId: 'a', content: 'ok' },
  ];
  const seedShapes = [...[0, 1, 2, 3, 4, 5].map(i => `user:第${i}问`), 'assistant:a', 'tool:a'];
  const MARKER = 'system:对话已压缩';
  /** 判压缩的两条线与插件这时的相同：压缩线取默认 0.8，条数线 10 */
  const due = (historyMessages: number) =>
    compressionDue(
      { used: 10, contextWindow: 1000, tokenBudget: 1000, compressible: 10, trimmed: false, historyMessages },
      { compressAt: 0.8, historyLimit: 10 },
    );

  async function session(
    historyLimit: number,
    reply: (request: ChatModelRequest) => string | Promise<string> = keepAll,
  ) {
    const env = await setup(fakeSummaryLLM({ reply }));
    const { id } = await env.sm.createSession({ name: '本机会话' });
    // 条数线取这个会话最近一次用量里的：手动压缩之前先有一次用量快照（不带回合 id）
    await env.host.events.use.emit('token:usage', usageEvent(id, { used: 10, compressible: 10, historyLimit }));
    const store = env.host.memory.use;
    const save = async (...messages: Message[]) => {
      for (const m of messages) await store.saveMessage(id, m);
    };
    const history = () => store.getHistory(id, Infinity);
    /** 活跃历史的形状：角色加正文，工具组首写调用的 id，工具结果写对应的 id */
    const shapes = async () =>
      (await history()).map(m =>
        m.toolCalls?.length
          ? `${m.role}:${m.toolCalls.map(c => c.id).join()}`
          : `${m.role}:${m.toolCallId ?? m.content}`,
      );
    return { ...env, id, save, history, shapes };
  }

  it('比例 0.1、条数线 10，每轮一问一条很长的回答、摘要模型编得上号的全留：压完的活跃条数（含分隔标记）不超过条数线的一半，超出的从最早的保留单位起整组去掉，压完 compressionDue 为假', async () => {
    const { host, id, save, history, shapes, statuses } = await session(10);
    await save(...seed);
    const round = async (k: number) => {
      await save(user(`问${k}`), answer);
      const ended = (await history()).length;
      const reported = statuses.length;
      await endTurn(host, id, counted(ended, 10), { outcome: 'silent' });
      if (due(ended)) await expect.poll(() => statuses.length).toBe(reported + 2);
      expect(due((await history()).length), `第 ${k} 轮之后`).toBe(false);
    };

    await round(1);
    // 编得上号的是六条短问、工具组与问1，共九条：连同分隔标记留到五条，去掉最早的五条短问，工具组两条整组留下
    expect(await shapes()).toEqual([...seedShapes.slice(5), 'user:问1', MARKER]);
    for (const k of [2, 3, 4]) await round(k);
    expect(statuses).toEqual([`${id}:start`, `${id}:done`, `${id}:start`, `${id}:done`]);
  });

  it('条数线为 0：不受这条限制，编得上号的全留', async () => {
    const { host, id, save, shapes } = await session(0);
    await save(...seed, user('问1'), answer);

    await host.compression.use.compress(id, { reason: 'manual' });

    expect(await shapes()).toEqual([...seedShapes, 'user:问1', MARKER]);
  });

  /** 手动压缩，摘要模型回话之前到了 count 条新消息（落定时在切分点之后）；返回压完的形状与这几条的形状 */
  async function compressWithLate(historyLimit: number, count: number) {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const { host, id, save, shapes, summaryLLM } = await session(historyLimit, async request => {
      await gate;
      return keepAll(request);
    });
    await save(...seed, user('问1'), answer);
    const done = host.compression.use.compress(id, { reason: 'manual' });
    await expect.poll(() => summaryLLM.requests.length).toBe(1);
    const late = Array.from({ length: count }, (_, i) => `压缩期间第${i}条`);
    await save(...late.map(user));
    release();
    await done;
    return { shapes: await shapes(), late: late.map(content => `user:${content}`) };
  }

  it('条数线 11（一半向下取整为 5）、压缩期间到了一条：挑中的原文只留到连同这一条与分隔标记合计五条为止', async () => {
    const { shapes, late } = await compressWithLate(11, 1);

    expect(shapes).toEqual(['assistant:a', 'tool:a', 'user:问1', ...late, MARKER]);
  });

  it('切分点之后的消息本身就超过条数线的一半（条数线 10、压缩期间到了六条）：一条原文都不留', async () => {
    const { shapes, late } = await compressWithLate(10, 6);

    expect(shapes).toEqual([...late, MARKER]);
  });
});
