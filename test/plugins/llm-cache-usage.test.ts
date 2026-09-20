import { App, type PluginModule, services } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import deepseekPlugin from '../../packages/plugin-llm-deepseek/src/index.js';
import openaiPlugin from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// 前缀缓存命中量的上报（打真实适配器，非重抄映射）
//
// DeepSeek 与 OpenAI 的前缀缓存都是自动生效（无需请求侧声明），命中部分按
// 折扣价计费。适配器若不把它映射进 ChatResponse.usage，缓存收益在系统内就
// 完全不可观测——针对缓存的优化也无从验收。这里用桩 fetch 驱动真实 chat()。
// ════════════════════════════════════════════════════════════

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** 每次 stubFetch 重置：记录实际请求 URL（锚定 baseUrl「完整前缀」语义的最终拼接形状） */
const fetchedUrls: string[] = [];

/** 桩 fetch：模型列表接口返回一个模型，chat 接口返回给定 usage */
function stubFetch(modelId: string, usage: Record<string, unknown>): void {
  fetchedUrls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    const json = url.includes('/models')
      ? { data: [{ id: modelId }] }
      : {
          choices: [{ message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }],
          usage,
        };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function chatWith(plugin: PluginModule, modelId: string, usage: Record<string, unknown>) {
  stubFetch(modelId, usage);
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.plugins.register(plugin, { apiKey: 'test-key' });
  await app.plugins.idle();
  const model = app.bind({ services }).services.get(llm);
  if (!model) throw new Error('llm entry 未注册');
  const res = await model.chat({ messages: [{ role: 'user', content: '在吗' }] });
  await app.stop();
  return res;
}

describe('baseUrl 完整前缀语义：最终请求 URL 形状', () => {
  // 锚定「插件只拼端点名、不再自拼 /v1」：旧桩用 includes('/models') 对新旧语义都绿，
  // 本批的核心破坏性变更此前处于零回归覆盖状态（2026-08-24 审计）。
  it('DeepSeek 默认端点（官方无版本段）→ /chat/completions 且无 /v1', async () => {
    await chatWith(deepseekPlugin, 'deepseek-chat', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    expect(fetchedUrls).toContain('https://api.deepseek.com/chat/completions');
    expect(
      fetchedUrls.some(u => u.includes('/v1')),
      '不得再自拼 /v1',
    ).toBe(false);
  });

  it('OpenAI 默认端点（含 /v1 版本段）→ /v1/chat/completions 且无双 /v1', async () => {
    await chatWith(openaiPlugin, 'gpt-4o', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    expect(fetchedUrls).toContain('https://api.openai.com/v1/chat/completions');
    expect(
      fetchedUrls.some(u => u.includes('/v1/v1')),
      '不得出现双 /v1',
    ).toBe(false);
  });
});

describe('前缀缓存命中量上报', () => {
  it('DeepSeek: prompt_cache_hit_tokens 被带进 usage.cachedPromptTokens', async () => {
    const res = await chatWith(deepseekPlugin, 'deepseek-chat', {
      prompt_tokens: 41708,
      completion_tokens: 140,
      total_tokens: 41848,
      prompt_cache_hit_tokens: 38000,
      prompt_cache_miss_tokens: 3708,
    });
    expect(res.usage?.promptTokens).toBe(41708);
    expect(res.usage?.cachedPromptTokens, '缓存命中量必须上报，否则命中率不可观测').toBe(38000);
  });

  it('OpenAI: prompt_tokens_details.cached_tokens 被带进 usage.cachedPromptTokens', async () => {
    const res = await chatWith(openaiPlugin, 'gpt-4o', {
      prompt_tokens: 10000,
      completion_tokens: 50,
      total_tokens: 10050,
      prompt_tokens_details: { cached_tokens: 8192 },
    });
    expect(res.usage?.cachedPromptTokens).toBe(8192);
  });

  it('provider 未上报时保持 undefined（"不可知" ≠ "0 命中"）', async () => {
    const ds = await chatWith(deepseekPlugin, 'deepseek-chat', {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    });
    expect(ds.usage?.cachedPromptTokens).toBeUndefined();
    // 代理端点常整段省略 prompt_tokens_details
    const oa = await chatWith(openaiPlugin, 'gpt-4o', {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    });
    expect(oa.usage?.cachedPromptTokens).toBeUndefined();
  });

  it('流式：usage 挂在 choices 为空的收尾帧上时仍被上报', async () => {
    // OpenAI 的 include_usage 形态把 usage 单独放在 `choices: []` 的末帧。
    // 若 usage 提取排在 delta 守卫之后，整帧会被 `continue` 跳过、usage 全丢。
    const frames = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10000,"completion_tokens":50,"total_tokens":10050,"prompt_tokens_details":{"cached_tokens":8192}}}',
      'data: [DONE]',
    ].join('\n\n');
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 });
      }
      return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.plugins.register(openaiPlugin, { apiKey: 'test-key' });
    await app.plugins.idle();
    const model = app.bind({ services }).services.get(llm);
    if (!model?.chatStream) throw new Error('chatStream 不可用');

    let cached: number | undefined;
    for await (const chunk of model.chatStream({ messages: [{ role: 'user', content: '在吗' }] })) {
      if (chunk.usage?.cachedPromptTokens != null) cached = chunk.usage.cachedPromptTokens;
    }
    expect(cached, 'usage 收尾帧被 delta 守卫吞掉了').toBe(8192);
    await app.stop();
  });

  it('明确 0 命中与不可知可区分', async () => {
    const res = await chatWith(deepseekPlugin, 'deepseek-chat', {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 100,
    });
    expect(res.usage?.cachedPromptTokens).toBe(0);
    expect(res.usage?.cachedPromptTokens).not.toBeUndefined();
  });
});
