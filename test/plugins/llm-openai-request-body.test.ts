import { afterEach, describe, expect, it } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import openaiPlugin from '../../packages/plugin-llm-openai/src/index.js';

// plugin-llm-openai 的请求体编码：用桩 fetch 捕获请求体，按模型与配置锚定发出的字段。

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

async function setup(modelId: string, config: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown>[] = [];
  stubFetch(modelId, bodies);
  const app = new App({ name: 'T', logLevel: 'error' });
  await app.plugin(openaiPlugin, { apiKey: 'test-key', ...config });
  await app.plugins.idle();
  const host = app.bind({ services });
  const model = host.services.get(llm);
  if (!model?.chatStream) throw new Error('llm entry 未注册');
  return { app, model, bodies };
}

const messages = [{ role: 'user' as const, content: '在吗' }];

// 背景：isReasoningModel 原本只认 /^o\d/，gpt-5 系列被当普通模型发 max_tokens + temperature，
// 被 OpenAI 直接 400。这里锚定「推理模型 → max_completion_tokens 且不带 temperature」
// 「普通模型 → max_tokens 且带 temperature」两侧。
describe('isReasoningModel：gpt-5 系列与 o 系列同为推理模型', () => {
  for (const modelId of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-chat', 'o3']) {
    it(`${modelId} 走 max_completion_tokens 且不带 temperature（chat 与 stream 两条路径）`, async () => {
      const { app, model, bodies } = await setup(modelId);
      await model.chat({ messages, maxTokens: 128 });
      for await (const _ of model.chatStream!({ messages, maxTokens: 128 })) {
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
    const { app, model, bodies } = await setup('gpt-4o');
    await model.chat({ messages, maxTokens: 128, temperature: 0.3 });
    for await (const _ of model.chatStream!({ messages, maxTokens: 128, temperature: 0.3 })) {
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

// 背景：plugin-llm-openai 原本只按真 OpenAI 写，request.think 被无视——DeepSeek 走 OpenAI
// 兼容中转时会话级 /session.set -t 等于空转（实测中转原样透传 thinking:{type}，disabled 后
// reasoning_content 消失）。这里锚定「配置闸 × think 三态」真值表。
describe('thinkingParam：request.think → DeepSeek 风格 thinking:{type}', () => {
  it('开启闸：think=true/false 各编码为 enabled/disabled，未指定则不发字段', async () => {
    const { app, model, bodies } = await setup('deepseek-chat', { thinkingParam: true });
    await model.chat({ messages, think: true });
    await model.chat({ messages, think: false });
    await model.chat({ messages });
    await app.stop();
    expect(bodies.map(b => b.thinking)).toEqual([{ type: 'enabled' }, { type: 'disabled' }, undefined]);
    expect('thinking' in bodies[2]).toBe(false);
  });

  it('开启闸：流式路径同样编码', async () => {
    const { app, model, bodies } = await setup('deepseek-chat', { thinkingParam: true });
    for await (const _ of model.chatStream!({ messages, think: false })) {
      // 消费完整条流
    }
    await app.stop();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].stream).toBe(true);
    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
  });

  it('默认关闸（真 OpenAI 端点不认该字段）：即便请求指定 think 也不发', async () => {
    const { app, model, bodies } = await setup('deepseek-chat');
    await model.chat({ messages, think: false });
    for await (const _ of model.chatStream!({ messages, think: true })) {
      // 消费完整条流
    }
    await app.stop();
    expect(bodies).toHaveLength(2);
    expect(bodies.every(b => !('thinking' in b))).toBe(true);
  });
});
