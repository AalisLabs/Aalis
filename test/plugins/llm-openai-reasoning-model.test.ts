import { afterEach, describe, expect, it } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as openaiModule from '../../packages/plugin-llm-openai/src/index.js';

// 背景：isReasoningModel 原本只认 /^o\d/，gpt-5 系列被当普通模型发 max_tokens + temperature，
// 被 OpenAI 直接 400。这里用桩 fetch 捕获请求体，锚定「推理模型 → max_completion_tokens 且不带
// temperature」「普通模型 → max_tokens 且带 temperature」两侧。

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 桩 fetch：/models 只暴露指定的一个模型；记录每次请求体；流式返回最小 SSE */
function stubFetch(modelId: string, bodies: Record<string, unknown>[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/models')) {
      return new Response(JSON.stringify({ data: [{ id: modelId }] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.stream) {
      const frames = ['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]'].join('\n\n');
      return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

async function setup(modelId: string) {
  const bodies: Record<string, unknown>[] = [];
  stubFetch(modelId, bodies);
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(openaiModule as never, { apiKey: 'test-key' });
  await app.plugins.idle();
  const llm = app.ctx.getService<LLMModel>('llm');
  if (!llm?.chatStream) throw new Error('llm entry 未注册');
  return { app, llm, bodies };
}

const messages = [{ role: 'user' as const, content: '在吗' }];

describe('isReasoningModel：gpt-5 系列与 o 系列同为推理模型', () => {
  for (const modelId of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-chat', 'o3']) {
    it(`${modelId} 走 max_completion_tokens 且不带 temperature（chat 与 stream 两条路径）`, async () => {
      const { app, llm, bodies } = await setup(modelId);
      await llm.chat({ messages, maxTokens: 128 });
      for await (const _ of llm.chatStream!({ messages, maxTokens: 128 })) {
        // 消费完整条流
      }
      await app.stop();
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        expect(body.model).toBe(modelId);
        expect(body.max_completion_tokens).toBe(128);
        expect('max_tokens' in body).toBe(false);
        expect('temperature' in body).toBe(false);
      }
    });
  }

  it('gpt-4o 仍走 max_tokens 且带 temperature（chat 与 stream 两条路径）', async () => {
    const { app, llm, bodies } = await setup('gpt-4o');
    await llm.chat({ messages, maxTokens: 128, temperature: 0.3 });
    for await (const _ of llm.chatStream!({ messages, maxTokens: 128, temperature: 0.3 })) {
      // 消费完整条流
    }
    await app.stop();
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.max_tokens).toBe(128);
      expect('max_completion_tokens' in body).toBe(false);
      expect(body.temperature).toBe(0.3);
    }
  });
});
