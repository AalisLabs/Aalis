import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ToolService, tools } from '../../packages/api-tools/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import maimaiPlugin from '../../packages/plugin-maimai/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// MaimaiClient.request 的 fetch 此前不带 signal。工具执行面没有外层超时，对端不应答即那轮
// 对话永久挂住——与已修的 embedding-openai 同形状。client 未导出，经 tools.execute 走完整路径。
// ════════════════════════════════════════════════════════════

function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const sig = init?.signal;
      if (!sig) return;
      sig.addEventListener('abort', () => reject(sig.reason ?? new Error('aborted')), { once: true });
    })) as unknown as typeof fetch;
}

const PLAYER = { name: '测试玩家', rating: 12345, friend_code: 123 };

describe('plugin-maimai: 查分器请求必须带超时', () => {
  const apps: App[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const a of apps.splice(0)) await a.stop().catch(() => {});
  });

  async function setup(timeoutMs?: number): Promise<ToolService> {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    await app.plugins.register(toolsPlugin, {});
    await app.plugins.register(maimaiPlugin, {
      developerToken: 'tok',
      enableCommands: false,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    await app.plugins.idle();
    const registry = app.bind({ services }).services.get(tools);
    expect(registry).toBeDefined();
    return registry!;
  }

  it('对端不应答时在 timeoutMs 内以错误结果返回，而不是永久挂住', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const registry = await setup(1000); // 实现有 1000ms 地板
    const outcome = await Promise.race([
      registry
        .execute('maimai_get_player_info', { friend_code: '123' }, { sessionId: 's1' })
        .then(r => `result:${r.content}`),
      new Promise<string>(r => setTimeout(() => r('still-hanging'), 2500)),
    ]);
    expect(outcome, '没有 signal 就会一直挂着').not.toBe('still-hanging');
    // handler 把异常包成「查询失败: <message>」纯文本回给模型，不是 JSON error 键
    expect(outcome, '超时应作为工具错误结果返回').toMatch(/^result:查询失败:.*timeout/i);
  });

  it('正常对端照常返回', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(JSON.stringify({ success: true, data: PLAYER }), { status: 200 })) as unknown as typeof fetch,
    );
    const registry = await setup();
    const r = await registry.execute('maimai_get_player_info', { friend_code: '123' }, { sessionId: 's1' });
    expect(r.content).toContain('测试玩家');
  });
});
