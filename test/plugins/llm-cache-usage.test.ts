import { App } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as deepseekModule from '../../packages/plugin-deepseek/src/index.js';
import type { LLMModel } from '../../packages/plugin-llm-api/src/index.js';
import * as openaiModule from '../../packages/plugin-openai/src/index.js';

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

/** 桩 fetch：模型列表接口返回一个模型，chat 接口返回给定 usage */
function stubFetch(modelId: string, usage: Record<string, unknown>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = url.includes('/models')
      ? { data: [{ id: modelId }] }
      : {
          choices: [{ message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }],
          usage,
        };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function chatWith(
  module: typeof deepseekModule | typeof openaiModule,
  modelId: string,
  usage: Record<string, unknown>,
) {
  stubFetch(modelId, usage);
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(module as never, { apiKey: 'test-key' });
  await app.plugins.idle();
  const llm = app.ctx.getService<LLMModel>('llm');
  if (!llm) throw new Error('llm entry 未注册');
  const res = await llm.chat({ messages: [{ role: 'user', content: '在吗' }] });
  await app.stop();
  return res;
}

describe('前缀缓存命中量上报', () => {
  it('DeepSeek: prompt_cache_hit_tokens 被带进 usage.cachedPromptTokens', async () => {
    const res = await chatWith(deepseekModule, 'deepseek-chat', {
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
    const res = await chatWith(openaiModule, 'gpt-4o', {
      prompt_tokens: 10000,
      completion_tokens: 50,
      total_tokens: 10050,
      prompt_tokens_details: { cached_tokens: 8192 },
    });
    expect(res.usage?.cachedPromptTokens).toBe(8192);
  });

  it('provider 未上报时保持 undefined（"不可知" ≠ "0 命中"）', async () => {
    const ds = await chatWith(deepseekModule, 'deepseek-chat', {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    });
    expect(ds.usage?.cachedPromptTokens).toBeUndefined();
    // 代理端点常整段省略 prompt_tokens_details
    const oa = await chatWith(openaiModule, 'gpt-4o', {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    });
    expect(oa.usage?.cachedPromptTokens).toBeUndefined();
  });

  it('明确 0 命中与不可知可区分', async () => {
    const res = await chatWith(deepseekModule, 'deepseek-chat', {
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
