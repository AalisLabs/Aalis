import { afterEach, describe, expect, it, vi } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, LogHub, services } from '../../packages/core/src/index.js';
import llmOllama from '../../packages/plugin-llm-ollama/src/index.js';

// ════════════════════════════════════════════════════════════
// 两次刷新并发时，新模型只算一次新增：两次刷新都在等同一个模型的能力探测，先返回的那次登记它，
// 后返回的那次登记时发现已登记，不能再把它记进 added。
// 刷新时新模型的能力探测与初次注册一样并行，登记仍按发现顺序。
// fetch 用替身，不发真实请求。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

describe('plugin-llm-ollama: 并发刷新不重复计入新增', () => {
  it('两次刷新同时发现同一个新模型，added 合计只有一次', async () => {
    let tags = ['qwen3:8b'];
    let showCallsForNew = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/tags')) return Response.json({ models: tags.map(name => ({ name })) });
        if (u.endsWith('/api/show')) {
          const { model } = JSON.parse(String(init?.body)) as { model: string };
          if (model === 'llama3:8b') {
            showCallsForNew++;
            await gate;
          }
          return Response.json({ capabilities: ['completion'] });
        }
        throw new Error(`意外的请求 ${u}`);
      }),
    );

    const app = new App({ name: 'T', logLevel: 'warn', logHub: new LogHub() });
    apps.push(app);
    await app.plugin(llmOllama, { baseUrl: 'http://127.0.0.1:11434' });
    await app.plugins.idle();
    const [entry] = app.bind({ services }).services.all(llm);
    if (!entry?.instance.refresh) throw new Error('ollama 未登记可刷新的条目');

    tags = ['qwen3:8b', 'llama3:8b'];
    const both = Promise.all([entry.instance.refresh(), entry.instance.refresh()]);
    // 两次刷新都停在新模型的能力探测上，再一起放行
    await vi.waitFor(() => expect(showCallsForNew).toBe(2));
    release();
    const [first, second] = await both;

    expect([...first.added, ...second.added], '同一个新模型被两次刷新各记了一次新增').toEqual(['llama3:8b']);
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
  });

  it('刷新出现多个新模型时能力探测并行，按发现顺序计入新增', async () => {
    const fresh = ['a:1', 'b:1', 'c:1'];
    let tags = ['qwen3:8b'];
    let inflight = 0;
    const releases = new Map<string, () => void>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/tags')) return Response.json({ models: tags.map(name => ({ name })) });
        if (u.endsWith('/api/show')) {
          const { model } = JSON.parse(String(init?.body)) as { model: string };
          if (fresh.includes(model)) {
            inflight++;
            await new Promise<void>(resolve => releases.set(model, resolve));
          }
          return Response.json({ capabilities: ['completion'] });
        }
        throw new Error(`意外的请求 ${u}`);
      }),
    );

    const app = new App({ name: 'T', logLevel: 'warn', logHub: new LogHub() });
    apps.push(app);
    await app.plugin(llmOllama, { baseUrl: 'http://127.0.0.1:11434' });
    await app.plugins.idle();
    const [entry] = app.bind({ services }).services.all(llm);
    if (!entry?.instance.refresh) throw new Error('ollama 未登记可刷新的条目');

    tags = ['qwen3:8b', ...fresh];
    const pending = entry.instance.refresh();
    // 串行探测时同一时刻只有一个在飞，到不了 3
    await vi.waitFor(() => expect(inflight).toBe(3));
    // 倒序放行：登记不能跟着探测的完成顺序走
    for (const id of [...fresh].reverse()) {
      releases.get(id)?.();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const result = await pending;

    expect(result.added).toEqual(fresh);
    expect(result.total).toBe(4);
  });
});
