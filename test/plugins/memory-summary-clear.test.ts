import { afterEach, describe, expect, it } from 'vitest';
import type { HookContextMap } from '../../packages/api-hooks/src/index.js';
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
        { source: 'summary', success: true, message: '当前会话摘要已清空' },
      ]);
      expect(await has('s1'), JSON.stringify(types)).toBe(false);
      expect(await has('s2'), JSON.stringify(types)).toBe(true);
    }
  });

  it('全局：context 删全部摘要', async () => {
    const { clear, has } = await world();
    expect(await clear('all', ['context'])).toEqual([
      { source: 'summary', success: true, message: '所有会话摘要已清空' },
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
