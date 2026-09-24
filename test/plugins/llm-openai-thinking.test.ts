import { afterEach, describe, expect, it } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import openaiPlugin from '../../packages/plugin-llm-openai/src/index.js';

// 背景：plugin-llm-openai 原本只按真 OpenAI 写，request.think 被无视——DeepSeek 走 OpenAI
// 兼容中转时会话级 /session.set -t 等于空转（实测中转原样透传 thinking:{type}，disabled 后
// reasoning_content 消失）。这里用桩 fetch 捕获请求体，锚定「配置闸 × think 三态」真值表。

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 桩 fetch：记录每次 chat 请求体；流式返回最小 SSE */
function stubFetch(bodies: Record<string, unknown>[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 });
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

async function setup(config: Record<string, unknown>) {
  const bodies: Record<string, unknown>[] = [];
  stubFetch(bodies);
  const app = new App({ name: 'T', logLevel: 'error' });
  await app.plugin(openaiPlugin, { apiKey: 'test-key', ...config });
  await app.plugins.idle();
  const host = app.bind({ services });
  const model = host.services.get(llm);
  if (!model?.chatStream) throw new Error('llm entry 未注册');
  return { app, model, bodies };
}

const messages = [{ role: 'user' as const, content: '在吗' }];

describe('thinkingParam：request.think → DeepSeek 风格 thinking:{type}', () => {
  it('开启闸：think=true/false 各编码为 enabled/disabled，未指定则不发字段', async () => {
    const { app, model, bodies } = await setup({ thinkingParam: true });
    await model.chat({ messages, think: true });
    await model.chat({ messages, think: false });
    await model.chat({ messages });
    await app.stop();
    expect(bodies.map(b => b.thinking)).toEqual([{ type: 'enabled' }, { type: 'disabled' }, undefined]);
    expect('thinking' in bodies[2]).toBe(false);
  });

  it('开启闸：流式路径同样编码', async () => {
    const { app, model, bodies } = await setup({ thinkingParam: true });
    for await (const _ of model.chatStream!({ messages, think: false })) {
      // 消费完整条流
    }
    await app.stop();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].stream).toBe(true);
    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
  });

  it('默认关闸（真 OpenAI 端点不认该字段）：即便请求指定 think 也不发', async () => {
    const { app, model, bodies } = await setup({});
    await model.chat({ messages, think: false });
    for await (const _ of model.chatStream!({ messages, think: true })) {
      // 消费完整条流
    }
    await app.stop();
    expect(bodies).toHaveLength(2);
    expect(bodies.every(b => !('thinking' in b))).toBe(true);
  });
});
