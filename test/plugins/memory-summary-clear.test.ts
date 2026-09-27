import { afterEach, describe, expect, it } from 'vitest';
import type { HookContextMap } from '../../packages/api-hooks/src/index.js';
import { LLMCapabilities, type LLMModel } from '../../packages/api-llm/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { setupSummary } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 摘要是归档消息的压缩：清消息历史（context）时一并清掉，否则每轮仍注入「之前对话的摘要」，
// 下次压缩还会把它并进新摘要，被清掉的对话要旨一直延续下去。summary 仍可单独选。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function world() {
  const env = await setupSummary({ threshold: 240, keepRecent: 40 });
  apps.push(env.app);
  for (const s of ['s1', 's2']) await env.memory.saveMetadata('summary', s, { summary: `${s} 的摘要` });
  async function clear(scope: 'session' | 'all', types?: string[]) {
    const data: HookContextMap['memory:clear'] = { scope, types, sessionId: 's1', results: [] };
    await env.host.hooks.run('memory:clear', data, async () => {});
    return data.results;
  }
  const has = async (s: string) => (await env.memory.getMetadata('summary', s)) !== undefined;
  return { clear, has };
}

describe('plugin-memory-summary: 摘要随 context 清理', () => {
  it('会话级：context、summary 与不带类型都删本会话的摘要，其它会话不动', async () => {
    for (const types of [['context'], ['summary'], undefined]) {
      const { clear, has } = await world();
      const results = await clear('session', types);
      expect(results, JSON.stringify(types)).toEqual([
        { source: 'summary', type: 'summary', success: true, message: '当前会话摘要已清空' },
      ]);
      expect(await has('s1'), JSON.stringify(types)).toBe(false);
      expect(await has('s2'), JSON.stringify(types)).toBe(true);
    }
  });

  it('全局：context 删全部摘要', async () => {
    const { clear, has } = await world();
    expect(await clear('all', ['context'])).toEqual([
      { source: 'summary', type: 'summary', success: true, message: '所有会话摘要已清空' },
    ]);
    expect(await has('s1')).toBe(false);
    expect(await has('s2')).toBe(false);
  });

  it('其它类型不动摘要', async () => {
    const { clear, has } = await world();
    expect(await clear('all', ['vector', 'image'])).toEqual([]);
    expect(await has('s1')).toBe(true);
    expect(await has('s2')).toBe(true);
  });
});

// 摘要在后台跑：模型返回前用户发了 /clear（或删除会话），在途结果不能写回，否则被清掉的对话又以摘要注入提示词。
describe('plugin-memory-summary: 清理与在途摘要', () => {
  /** 摘要模型挂在闸门上，放行前可以插入一次清理 */
  function gatedModel() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const state = { calls: 0 };
    const model = {
      id: 'gated',
      providerId: 'gated',
      contextLength: 8192,
      capabilities: [LLMCapabilities.Chat],
      async chat() {
        state.calls++;
        await gate;
        return { content: 'STALE-SUMMARY' };
      },
    } as unknown as LLMModel;
    return { model, state, release };
  }

  /** holdWrite 给出时，summary 命名空间的写入先兑现 writing、再等 holdWrite 放行（模拟晚到的数据库往返） */
  async function inFlight(start: 'turn' | 'compress', holdWrite?: Promise<void>) {
    const { model, state, release } = gatedModel();
    const env = await setupSummary({ threshold: 30, keepRecent: 20 }, model);
    apps.push(env.app);
    let writeStarted!: () => void;
    const writing = new Promise<void>(r => (writeStarted = r));
    if (holdWrite) {
      const save = env.memory.saveMetadata.bind(env.memory);
      env.memory.saveMetadata = async (namespace, key, data) => {
        if (namespace === 'summary') {
          writeStarted();
          await holdWrite;
        }
        return save(namespace, key, data);
      };
    }
    for (let i = 0; i < 35; i++)
      await env.memory.saveMessage('s1', { role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条` });
    const statuses: string[] = [];
    env.host.events.on('session:compressing', info => void statuses.push(info.status));
    // 压缩事件的处理器会一直等到模型返回，emit 不能在放行前 await
    const started =
      start === 'turn'
        ? env.host.hooks.run(
            'agent:turn:after' as never,
            { message: { sessionId: 's1' }, reply: 'ok', outcome: 'replied', sessionId: 's1', metadata: {} } as never,
          )
        : env.host.events.emit('session:compress', { sessionId: 's1', reason: 'manual' });
    await expect.poll(() => state.calls).toBe(1);
    const clear = async (scope: 'session' | 'all', sessionId: string) => {
      const data: HookContextMap['memory:clear'] = { scope, sessionId, results: [] };
      await env.host.hooks.run('memory:clear', data, async () => {});
    };
    const finish = async () => {
      release();
      await started;
      await new Promise<void>(r => setTimeout(r, 50));
      return {
        summary: await env.memory.getMetadata('summary', 's1'),
        remaining: (await env.memory.getHistory('s1', 1000)).length,
        statuses,
      };
    };
    return { clear, finish, release, writing };
  }

  it.each([
    ['会话级清理', 'session'],
    ['全局清理', 'all'],
  ] as const)('%s发生在模型返回前：丢弃在途摘要，不写摘要、不裁切', async (_label, scope) => {
    const { clear, finish } = await inFlight('turn');
    await clear(scope, 's1');
    const { summary, remaining } = await finish();
    expect(summary).toBeUndefined();
    expect(remaining).toBe(35);
  });

  it('清的是别的会话：本会话的摘要照常写入并裁切', async () => {
    const { clear, finish } = await inFlight('turn');
    await clear('session', 's2');
    const { summary, remaining } = await finish();
    expect(summary).toMatchObject({ summary: 'STALE-SUMMARY' });
    expect(remaining).toBe(20);
  });

  it('手动压缩途中清理：同样丢弃，前端收到 error 而不是 done', async () => {
    const { clear, finish } = await inFlight('compress');
    await clear('session', 's1');
    const { summary, remaining, statuses } = await finish();
    expect(summary).toBeUndefined();
    expect(remaining).toBe(35);
    expect(statuses).toEqual(['start', 'error']);
  });

  // 已过比对、写入正在往返时开始清理：mongodb 上写入与清理的删除走不同连接，先发出的写入可能晚于删除落地。
  // /clear all 可以从任意会话发起（带的是发起者所在的会话），全局清理从别的会话发起，要等全部会话的落库
  it.each([
    ['会话级清理', 'session', 's1'],
    ['从别的会话发起的全局清理', 'all', 's-other'],
  ] as const)('%s发生在摘要写入往返途中：清理等这次落库完成再删，摘要不留下', async (_label, scope, from) => {
    let releaseWrite!: () => void;
    const { clear, finish, release, writing } = await inFlight('turn', new Promise<void>(r => (releaseWrite = r)));
    release();
    await writing;
    const clearing = clear(scope, from);
    await new Promise<void>(r => setTimeout(r, 10));
    releaseWrite();
    await clearing;
    const { summary } = await finish();
    expect(summary).toBeUndefined();
  });
});
