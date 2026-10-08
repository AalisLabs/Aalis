import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type { LLMUsageEvent } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 会话记下每一轮的结局与用量：一轮结束时写 lastTurn（结局、结束时间，出错时带 agent:turn:after 给的原因），
// 子会话与根会话同一套收口；模型调用的 token 按会话累加进 tokens，只记已有的会话、不改 updatedAt，
// 随会话落盘与删除。两项都由 session-manager 写入，不收调用方传值。
// ════════════════════════════════════════════════════════════

type Outcome = HookContextMap['agent:turn:after']['outcome'];

const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, sessionManager });
  const mem = fakeMemory();
  host.provide(memory, mem as never);
  await app.plugin(sessionManagerPlugin);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  const sm = host.sessionManager.require();

  let turns = 0;
  /** 按 agent 的顺序跑一轮；不给结局时不发 agent:turn:after（消息被拦下的一轮） */
  const turn = (sessionId: string, outcome?: Outcome, error?: string) => {
    const message: IncomingMessage = { content: '<占位>', sessionId, platform: 'webui' };
    const turnId = `t${++turns}`;
    return host.hooks.run('agent:input:before', { message, turnId, metadata: {} }, async () => {
      if (!outcome) return;
      await host.hooks.run('agent:turn:after', {
        message,
        reply: outcome === 'replied' ? '<回复>' : '',
        outcome,
        ...(error === undefined ? {} : { error }),
        sessionId,
        turnId,
        metadata: {},
      });
    });
  };

  const usage = (fields: Partial<LLMUsageEvent>) =>
    host.events.emit('llm:usage', {
      provider: '<服务商>',
      model: '<模型>',
      inputTokens: 0,
      outputTokens: 0,
      ...fields,
    });

  const updates: SessionInfo[] = [];
  host.events.on('session:updated', session => void updates.push(structuredClone(session)));

  /** 推进 1 秒的落盘去抖；假后端存的是会话对象的引用，推进后换成快照，才看得出下一次有没有落盘 */
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(1_000);
    for (const [key, data] of mem.meta) mem.meta.set(key, structuredClone(data));
  };

  return { sm, mem, turn, usage, updates, flush };
}

describe('lastTurn：每一轮结束时记下结局与结束时间', () => {
  it('error 带 agent:turn:after 给的原因，其余结局不带；随 session:updated 推出并落盘', async () => {
    const { sm, mem, turn, updates, flush } = await setup();
    // 落盘是 1 秒去抖：从建会话起就用假时钟推进
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const session = await sm.createSession({ name: '<会话>' });
    await flush();

    vi.setSystemTime(10_000);
    await turn(session.id, 'error', '<模型炸了>');
    const failed = { outcome: 'error', endedAt: 10_000, error: '<模型炸了>' };
    expect(sm.getSession(session.id)?.lastTurn).toEqual(failed);
    expect(updates.at(-1)?.lastTurn).toEqual(failed);
    await flush();
    expect(mem.meta.get(session.id)?.lastTurn).toEqual(failed);

    // 原因只跟着 error：别的结局即使带了也不记
    for (const [at, outcome] of [
      [20_000, 'replied'],
      [30_000, 'silent'],
      [40_000, 'aborted'],
    ] as const) {
      vi.setSystemTime(at);
      await turn(session.id, outcome, '<不该留>');
      expect(sm.getSession(session.id)?.lastTurn, outcome).toEqual({ outcome, endedAt: at });
    }
  });

  it('被拦下、没有结局的一轮按 silent 记，不沿用上一轮的出错原因', async () => {
    const { sm, turn } = await setup();
    const session = await sm.createSession({ name: '<会话>' });

    await turn(session.id, 'error', '<模型炸了>');
    await turn(session.id);

    expect(sm.getSession(session.id)?.lastTurn).toEqual({ outcome: 'silent', endedAt: expect.any(Number) });
  });

  it('不收调用方传值：建会话与建档时给的 lastTurn、tokens 都不采信', async () => {
    const { sm } = await setup();
    const lastTurn = { outcome: 'error', endedAt: 1, error: '<伪造>' } as const;
    const tokens = { input: 9, output: 9 };

    // @ts-expect-error 建会话的参数里没有 lastTurn
    const a = await sm.createSession({ lastTurn });
    // @ts-expect-error 建会话的参数里没有 tokens
    const b = await sm.createSession({ tokens });
    const c = await sm.ensureSession('<建档>', { lastTurn, tokens } as never);

    for (const { id } of [a, b, c]) {
      expect(sm.getSession(id)?.lastTurn, id).toBeUndefined();
      expect(sm.getSession(id)?.tokens, id).toBeUndefined();
    }
  });
});

describe('子会话与根会话同一套收口', () => {
  it('子会话最后一轮结束：出错为 error 并带原因，其余为 completed，被停止从 lastTurn 看出', async () => {
    const { sm, turn } = await setup();
    const parent = await sm.createSession({ name: '<父会话>' });

    for (const [outcome, status] of [
      ['error', 'error'],
      ['aborted', 'completed'],
      ['silent', 'completed'],
      ['replied', 'completed'],
    ] as const) {
      const child = await sm.createChildSession(parent.id, { name: `<子会话 ${outcome}>` });
      expect(child.status).toBe('active');
      await turn(child.id, outcome, outcome === 'error' ? '<原因>' : undefined);
      expect(sm.getSession(child.id)?.status, outcome).toBe(status);
      expect(sm.getSession(child.id)?.lastTurn?.outcome, outcome).toBe(outcome);
    }
  });
});

describe('tokens：按会话累加 llm:usage', () => {
  it('累加输入与输出，不改 updatedAt，记了就发 session:updated，随会话落盘', async () => {
    const { sm, mem, usage, updates, flush } = await setup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000);
    const session = await sm.createSession({ name: '<会话>' });
    await flush();
    updates.length = 0;

    vi.setSystemTime(5_000);
    await usage({ sessionId: session.id, inputTokens: 100, cachedTokens: 60, outputTokens: 20 });
    await usage({ sessionId: session.id, inputTokens: 50, outputTokens: 5, purpose: '摘要' });

    expect(sm.getSession(session.id)?.tokens).toEqual({ input: 150, output: 25 });
    expect(sm.getSession(session.id)?.updatedAt).toBe(1_000);
    expect(updates.map(s => [s.id, s.tokens])).toEqual([
      [session.id, { input: 100, output: 20 }],
      [session.id, { input: 150, output: 25 }],
    ]);
    await flush();
    expect(mem.meta.get(session.id)?.tokens).toEqual({ input: 150, output: 25 });
  });

  it('只记已有的会话：没有会话 id 的、会话不存在的不记，也不建会话', async () => {
    const { sm, usage, updates } = await setup();
    const before = sm.listSessions().length;

    await usage({ inputTokens: 10, outputTokens: 1 });
    await usage({ sessionId: '<不存在>', inputTokens: 10, outputTokens: 1 });

    expect(sm.getSession('<不存在>')).toBeUndefined();
    expect(sm.listSessions()).toHaveLength(before);
    expect(updates).toEqual([]);
  });

  it('删除会话时一并清掉：删除之后到的用量不再建出它，落盘里也没有', async () => {
    const { sm, mem, usage, flush } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await sm.createSession({ name: '<会话>' });
    await usage({ sessionId: session.id, inputTokens: 10, outputTokens: 1 });
    await flush();
    expect(mem.meta.get(session.id)?.tokens).toEqual({ input: 10, output: 1 });

    await sm.deleteSession(session.id);
    await usage({ sessionId: session.id, inputTokens: 10, outputTokens: 1 });
    await flush();

    expect(sm.getSession(session.id)).toBeUndefined();
    expect(mem.meta.has(session.id)).toBe(false);
  });
});
